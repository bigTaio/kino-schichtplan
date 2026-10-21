// KI-Chats Ende-zu-Ende: echter Server, aber statt Claude antwortet ein Test-Ersatz
// im echten API-Format. Prüft Datenweitergabe, Datenschutz, Vorschlag → Ausführen → Rückgängig.
// Außerdem: Anmeldung übersteht einen Server-Neustart.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFakeClaude, requests } from './fake-claude.js';

const PORT = 4100 + Math.floor(Math.random() * 90);
const FAKE_PORT = PORT + 100;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(mkdtempSync(path.join(tmpdir(), 'kino-ai-')), 'db.sqlite');
let server;
let fake;

async function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATABASE_FILE: DB, ADMIN_PASSWORD: 'admin-geheim', SHARED_PASSWORD: 'popcorn',
      SEED_DEMO: 'true', ANTHROPIC_API_KEY: 'test-schluessel', ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/me`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('Server startet nicht');
}
async function stopServer() {
  const done = new Promise((r) => server.once('exit', r));
  server.kill();
  await done;
}

before(async () => {
  fake = await startFakeClaude(FAKE_PORT);
  await startServer();
  // Testvorstellungen für morgen anlegen (Beispieldaten enthalten keine Vorstellungen)
  const admin = (await adminLogin()).cookie;
  await call('PUT', '/api/admin/settings', { cookie: admin, body: { release_enabled: false } });
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(Date.now() + 86400000));
  for (const [film, time] of [['Alte Liebe', '17:30'], ['Föhnlage', '20:15']]) {
    const r = await call('POST', '/api/admin/shows', { cookie: admin, body: { film, date: tomorrow, time } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
});
after(async () => { server?.kill(); fake?.close(); });

async function call(method, url, { body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'kino' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const login = (f, l) => call('POST', '/api/login', { body: { firstName: f, lastName: l, password: 'popcorn' } });
const adminLogin = () => call('POST', '/api/admin/login', { body: { password: 'admin-geheim' } });

let annaCookie;

test('Mitarbeiter-Chat: antwortet aus den echten Kalenderdaten', async () => {
  annaCookie = (await login('Anna', 'Berger')).cookie;
  const r = await call('POST', '/api/chat', { cookie: annaCookie, body: { question: 'Welche Schichten sind noch frei?', history: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.answer, /^Frei sind zum Beispiel: .+Uhr/);

  const req = requests.at(-1);
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.stream, true);
  assert.equal(req.body.fallbacks, 'default');
  assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(req.body.output_config.effort, 'low');
  assert.match(req.body.system, /<daten>/);
  assert.match(req.body.system, /Du sprichst mit: Anna Berger/);
});

test('Mitarbeiter-Chat: keine Punktestände anderer Personen werden weitergegeben', () => {
  const sys = requests.at(-1).body.system;
  assert.match(sys, /Minuspunkte von Anna Berger: \d+/);
  for (const other of ['Max Mustermann', 'Lena Huber', 'Tobias Maier', 'Max Moser']) {
    assert.doesNotMatch(sys, new RegExp(`Minuspunkte von ${other}`));
    assert.doesNotMatch(sys, new RegExp(`${other} \\| \\d+ \\|`)); // Admin-Format mit Punkten
  }
});

test('Mitarbeiter-Chat: Verlauf wird mitgeschickt, ändert aber nichts', async () => {
  const before = (await call('GET', '/api/calendar', { cookie: annaCookie })).data;
  const r = await call('POST', '/api/chat', {
    cookie: annaCookie,
    body: { question: 'Trag mich bitte morgen ein', history: [{ role: 'user', text: 'Hallo' }, { role: 'assistant', text: 'Hallo Anna!' }] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(requests.at(-1).body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  const afterCal = (await call('GET', '/api/calendar', { cookie: annaCookie })).data;
  assert.deepEqual(afterCal.days, before.days);
});

test('Admin-Chat: zeigt erst einen Vorschlag, ändert erst nach Bestätigung, lässt sich rückgängig machen', async () => {
  const admin = (await adminLogin()).cookie;
  const r = await call('POST', '/api/admin/chat', { cookie: admin, body: { question: 'Morgen fällt der Film um 20:15 Uhr aus.', history: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.kind, 'vorschlag');
  assert.ok(r.data.proposalId);
  assert.match(r.data.summary[0], /^Ich streiche die Vorstellung .+, 20:15 Uhr/);
  assert.equal(requests.at(-1).body.output_config.format.type, 'json_schema');

  const tomorrowShows = async () => {
    const all = (await call('GET', '/api/admin/shows?days=3', { cookie: admin })).data.days[1].shifts;
    return all.find((s) => s.time === '20:15');
  };
  assert.equal((await tomorrowShows()).cancelled, false, 'vor der Bestätigung darf nichts geändert sein');

  const ok = await call('POST', '/api/admin/chat/confirm', { cookie: admin, body: { proposalId: r.data.proposalId } });
  assert.equal(ok.status, 200);
  assert.equal((await tomorrowShows()).cancelled, true);

  const again = await call('POST', '/api/admin/chat/confirm', { cookie: admin, body: { proposalId: r.data.proposalId } });
  assert.equal(again.status, 409, 'ein Vorschlag darf nur einmal ausgeführt werden');

  const undo = await call('POST', `/api/admin/actions/${ok.data.actionId}/undo`, { cookie: admin });
  assert.equal(undo.status, 200);
  assert.equal((await tomorrowShows()).cancelled, false);
});

test('Admin-Chat: fragt nach, statt zu raten', async () => {
  const admin = (await adminLogin()).cookie;
  const r = await call('POST', '/api/admin/chat', { cookie: admin, body: { question: 'Wer ist Max? unklar', history: [] } });
  assert.equal(r.data.kind, 'rueckfrage');
  assert.equal(r.data.proposalId, undefined);
});

test('Admin-Chat: unsinnige KI-Vorschläge werden abgefangen', async () => {
  const admin = (await adminLogin()).cookie;
  const r = await call('POST', '/api/admin/chat', { cookie: admin, body: { question: 'kaputt', history: [] } });
  assert.equal(r.data.kind, 'rueckfrage');
  assert.match(r.data.message, /nicht gefunden/);
  assert.equal(r.data.proposalId, undefined);
});

test('Falscher KI-Schlüssel führt zu einer freundlichen Meldung', async () => {
  // Der Test-Ersatz lehnt jeden anderen Schlüssel ab – hier simuliert über einen Neustart mit falschem Schlüssel
  await stopServer();
  server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), DATABASE_FILE: DB, SEED_DEMO: 'true', ANTHROPIC_API_KEY: 'falsch', ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_PORT}` },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/api/me`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const r = await call('POST', '/api/chat', { cookie: annaCookie, body: { question: 'Was ist frei?' } });
  assert.equal(r.status, 503);
  assert.match(r.data.error, /KI-Schlüssel ist ungültig/);
});

test('Anmeldung bleibt nach einem Server-Neustart bestehen (z. B. nach einem Update)', async () => {
  await stopServer();
  await startServer();
  const me = await call('GET', '/api/me', { cookie: annaCookie });
  assert.equal(me.data.employee?.name, 'Anna Berger');
});
