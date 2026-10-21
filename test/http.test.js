// Test über den echten Webserver: Anmeldung, Zugriffsschutz, gleichzeitiges Eintragen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let server;

before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kino-http-'));
  server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), DATABASE_FILE: path.join(dir, 'db.sqlite'), ADMIN_PASSWORD: 'admin-geheim', SHARED_PASSWORD: 'popcorn', SEED_DEMO: 'true', ANTHROPIC_API_KEY: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/me`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('Server startet nicht');
});
after(() => server?.kill());

async function call(method, url, { body, cookie, xrw = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (xrw) headers['X-Requested-With'] = 'kino';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data: await res.json().catch(() => ({})), cookie: setCookie?.split(';')[0] };
}

const login = (firstName, lastName, password = 'popcorn') =>
  call('POST', '/api/login', { body: { firstName, lastName, password } });

test('Falsches Kino-Passwort wird abgelehnt', async () => {
  const r = await login('Fremd', 'Person', 'falsch');
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'Das Kino-Passwort stimmt leider nicht.');
});

test('Anmeldung nur mit Vorname, Nachname und Kino-Passwort', async () => {
  const neu = await login('Paula', 'Neu');
  assert.equal(neu.status, 200);
  assert.equal(neu.data.isNew, true);
  const wieder = await login('paula', 'neu'); // Groß/Klein egal, kein zweites Konto
  assert.equal(wieder.status, 200);
  assert.equal(wieder.data.isNew, false);
  const me = await call('GET', '/api/me', { cookie: wieder.cookie });
  assert.equal(me.data.employee.name, 'Paula Neu');
});

test('Kinobesitzer kann Punkte gezielt ändern, Mitarbeiter nicht', async () => {
  const emp = await login('Anna', 'Berger');
  const admin = await call('POST', '/api/admin/login', { body: { password: 'admin-geheim' } });
  const list = (await call('GET', '/api/admin/employees', { cookie: admin.cookie })).data.employees;
  const anna = list.find((e) => e.name === 'Anna Berger');
  assert.equal((await call('POST', `/api/admin/employees/${anna.id}/points`, { cookie: emp.cookie, body: { points: 0 } })).status, 401);
  const r = await call('POST', `/api/admin/employees/${anna.id}/points`, { cookie: admin.cookie, body: { points: 15 } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/calendar', { cookie: emp.cookie })).data.me.points, 15);
  const bad = await call('POST', `/api/admin/employees/${anna.id}/points`, { cookie: admin.cookie, body: { points: -3 } });
  assert.equal(bad.status, 400);
  await call('POST', `/api/admin/actions/${r.data.actionId}/undo`, { cookie: admin.cookie });
  assert.equal((await call('GET', '/api/calendar', { cookie: emp.cookie })).data.me.points, 20);
});

test('Mitarbeiter haben keinen Zugriff auf Admin-Funktionen', async () => {
  const { cookie } = await login('Lena', 'Huber');
  for (const [m, u] of [['GET', '/api/admin/overview'], ['GET', '/api/admin/employees'], ['PUT', '/api/admin/settings'], ['POST', '/api/admin/shows'], ['POST', '/api/admin/chat'], ['POST', '/api/admin/import/run']]) {
    const r = await call(m, u, { cookie, body: {} });
    assert.equal(r.status, 401, `${m} ${u}`);
  }
  const nobody = await call('GET', '/api/calendar');
  assert.equal(nobody.status, 401);
});

test('Anfragen von fremden Seiten (ohne Kennung) werden abgelehnt', async () => {
  const { cookie } = await login('Tobias', 'Maier');
  const r = await call('POST', '/api/notices/seen', { cookie, xrw: false });
  assert.equal(r.status, 403);
});

test('Keine Geheimnisse in den Browser-Dateien', async () => {
  for (const f of ['/', '/admin', '/app.js', '/admin.js', '/common.js']) {
    const text = await (await fetch(BASE + f)).text();
    assert.ok(!/admin-geheim|popcorn|ANTHROPIC_API_KEY|sk-ant/.test(text), f);
  }
  const traversal = await fetch(`${BASE}/..%2Fserver.js`);
  assert.equal(traversal.status, 404);
});

test('20 Leute klicken gleichzeitig auf dieselbe Schicht – nur eine Person bekommt sie', async () => {
  const admin = await call('POST', '/api/admin/login', { body: { password: 'admin-geheim' } });
  assert.equal(admin.status, 200);
  await call('PUT', '/api/admin/settings', { cookie: admin.cookie, body: { release_enabled: false } });
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(Date.now() + 5 * 86400000));
  const add = await call('POST', '/api/admin/shows', { cookie: admin.cookie, body: { film: 'Wettlauf', date, time: '20:15' } });
  assert.equal(add.status, 200);
  const shows = await call('GET', `/api/admin/shows?from=${date}&days=1`, { cookie: admin.cookie });
  const showId = shows.data.days[0].shifts.find((s) => s.film === 'Wettlauf').id;

  const cookies = [];
  for (let i = 0; i < 20; i++) cookies.push((await login('Läufer', `Nummer${String.fromCharCode(65 + i)}`)).cookie);
  const results = await Promise.all(cookies.map((cookie) => call('POST', `/api/shifts/${showId}/book`, { cookie })));
  const winners = results.filter((r) => r.status === 200);
  const losers = results.filter((r) => r.status === 409);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 19);
  assert.ok(losers.every((r) => r.data.error === 'Diese Schicht ist leider schon vergeben.'));
  // Die Antwort bringt den neuen Kalender gleich mit (eine Anfrage pro Klick)
  const mine = winners[0].data.calendar.days.flatMap((d) => d.shifts).find((s) => s.id === showId);
  assert.equal(mine.mine, true);
});

test('Server bleibt bei vielen gleichzeitigen Anmeldungen für andere flüssig', async () => {
  const { cookie } = await login('Lena', 'Huber');
  const logins = Array.from({ length: 15 }, (_, i) => login('Gast', `Nummer${String.fromCharCode(97 + i)}`));
  const t0 = Date.now();
  const cal = await call('GET', '/api/calendar', { cookie });
  const waited = Date.now() - t0;
  await Promise.all(logins);
  assert.equal(cal.status, 200);
  assert.ok(waited < 300, `Kalender musste ${waited} ms warten`);
});

test('Datensicherung: nur für den Kinobesitzer, echte Datenbank-Datei', async () => {
  const emp = await login('Anna', 'Berger');
  assert.equal((await fetch(`${BASE}/api/admin/backup`, { headers: { Cookie: emp.cookie } })).status, 401);
  const admin = await call('POST', '/api/admin/login', { body: { password: 'admin-geheim' } });
  const res = await fetch(`${BASE}/api/admin/backup`, { headers: { Cookie: admin.cookie } });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
});

test('KI-Funktionen melden sich freundlich, wenn kein Schlüssel da ist', async () => {
  const { cookie } = await login('Max', 'Moser');
  const r = await call('POST', '/api/chat', { cookie, body: { question: 'Was läuft heute?' } });
  assert.equal(r.status, 503);
  assert.match(r.data.error, /noch nicht eingerichtet/);
});
