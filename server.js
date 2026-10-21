// Schichtplan Kino Murnau – Webserver.
// Start: `node server.js`  (Einstellungen über Umgebungsvariablen, siehe .env.example)
import http from 'node:http';
import { readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  db, nowIso, getSettings, setSetting, DEFAULT_SETTINGS, ensurePasswords, checkPassword, setPassword,
  addLog, employeeName, getEmployee, nameKey,
} from './src/db.js';
import {
  UserError, calendarFor, bookShift, cancelOwnShift, ops, runAdminAction, undoAdminAction, deleteEmployee,
  adminOverview, releaseRuleText, karmaExplanation, cleanupOldData, employeeNames, shiftView, showLabel,
} from './src/logic.js';
import { todayBerlin, addDays, formatDateShort, formatInstant, isValidDate, isValidTime, weekdayOf, WEEKDAYS } from './src/time.js';
import { runImport, latestImport, applyImport, discardImport, startDailyImport } from './src/importer.js';
import { employeeChat, adminChat, confirmAdminProposal } from './src/chat.js';
import { aiAvailable } from './src/ai.js';
import { seedDemoIfEmpty, removeDemoData } from './src/seed.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const EMP_COOKIE = 'kino_ma';
const ADMIN_COOKIE = 'kino_admin';
const EMP_SESSION_DAYS = 365;
const ADMIN_SESSION_DAYS = 30;
const RAW = Symbol('Antwort wurde schon direkt geschickt');

ensurePasswords();
seedDemoIfEmpty();
cleanupOldData();
setInterval(cleanupOldData, 6 * 3600000);
startDailyImport();

// ---------- kleine Helfer ----------

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function setCookie(req, res, name, value, days) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.round(days * 86400)}`];
  if (isHttps(req)) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...prev, parts.join('; ')]);
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createSession(req, res, role, employeeId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const days = role === 'admin' ? ADMIN_SESSION_DAYS : EMP_SESSION_DAYS;
  db.prepare('INSERT INTO sessions(token_hash, role, employee_id, expires_at) VALUES(?, ?, ?, ?)')
    .run(sha(token), role, employeeId ?? null, Date.now() + days * 86400000);
  setCookie(req, res, role === 'admin' ? ADMIN_COOKIE : EMP_COOKIE, token, days);
}

function sessionFrom(req, cookieName, role) {
  const token = parseCookies(req)[cookieName];
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND role = ?').get(sha(token), role);
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}

function currentEmployee(req) {
  const s = sessionFrom(req, EMP_COOKIE, 'employee');
  if (!s) return null;
  const emp = getEmployee(s.employee_id);
  return emp && !emp.blocked ? emp : null;
}

function isAdmin(req) {
  return !!sessionFrom(req, ADMIN_COOKIE, 'admin');
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) throw new UserError('Die Anfrage ist zu groß.', 413);
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new UserError('Ungültige Anfrage.', 400);
  }
}

// Einfache Bremse gegen Durchprobieren von Passwörtern und gegen zu viele KI-Anfragen.
const buckets = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return; }
  b.n++;
  if (b.n > max) throw new UserError('Zu viele Versuche. Bitte warte ein paar Minuten.', 429);
}
/** Wie limit(), zählt aber nur Fehlversuche: erst prüfen, bei Misserfolg hochzählen. */
async function guardFailures(key, max, windowMs, fn) {
  const b = buckets.get(key);
  if (b && b.reset > Date.now() && b.n >= max) throw new UserError('Zu viele Fehlversuche. Bitte warte ein paar Minuten.', 429);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UserError && err.status === 401) limit(key, Infinity, windowMs);
    throw err;
  }
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 600000);

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}

const NAME_RE = /^[\p{L}][\p{L}\p{M} .'’-]{0,39}$/u;
const cleanName = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

// ---------- Router ----------

const routes = [];
const route = (method, pattern, role, handler) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, role, handler });
};

// ---------- Anmeldung ----------

route('GET', '/api/me', null, (ctx) => {
  const emp = currentEmployee(ctx.req);
  return { employee: emp ? { id: emp.id, name: employeeName(emp), firstName: emp.first_name } : null, admin: isAdmin(ctx.req) };
});

route('POST', '/api/login', null, async (ctx) => {
  const { req, res, body } = ctx;
  const ip = clientIp(req);
  const first = cleanName(body.firstName);
  const last = cleanName(body.lastName);
  if (!NAME_RE.test(first) || !NAME_RE.test(last)) throw new UserError('Bitte gib deinen Vor- und Nachnamen ein.');
  // Anmeldung nur mit Name + gemeinsamem Kino-Passwort (so vom Kinobesitzer gewünscht).
  await guardFailures(`login:${ip}`, 20, 15 * 60000, async () => {
    if (!(await checkPassword('shared', String(body.password || '')))) throw new UserError('Das Kino-Passwort stimmt leider nicht.', 401);
  });

  const key = nameKey(first, last);
  // INSERT OR IGNORE: Melden sich zwei Geräte gleichzeitig mit demselben neuen Namen an, entsteht nur ein Konto.
  const info = db.prepare('INSERT OR IGNORE INTO employees(first_name, last_name, name_key, created_at) VALUES(?, ?, ?, ?)')
    .run(first, last, key, nowIso());
  const isNew = info.changes === 1;
  const emp = db.prepare('SELECT * FROM employees WHERE name_key = ?').get(key);
  if (isNew) addLog(employeeName(emp), 'Neu angemeldet', 'Erste Anmeldung');
  if (emp.blocked) throw new UserError('Dein Zugang ist gesperrt. Bitte sprich mit dem Kinobesitzer.', 403);
  createSession(req, res, 'employee', emp.id);
  if (!isNew) addLog(employeeName(emp), 'Angemeldet', 'Auf einem Gerät angemeldet');
  return { ok: true, isNew, name: employeeName(emp), firstName: emp.first_name, lastName: emp.last_name };
});

route('POST', '/api/logout', null, (ctx) => {
  const emp = currentEmployee(ctx.req);
  const t = parseCookies(ctx.req)[EMP_COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  if (emp) addLog(employeeName(emp), 'Abgemeldet', 'Auf einem Gerät abgemeldet');
  setCookie(ctx.req, ctx.res, EMP_COOKIE, '', 0);
  return { ok: true };
});

route('POST', '/api/admin/login', null, async (ctx) => {
  await guardFailures(`admin:${clientIp(ctx.req)}`, 10, 15 * 60000, async () => {
    if (!(await checkPassword('admin', String(ctx.body.password || '')))) throw new UserError('Das Admin-Passwort stimmt leider nicht.', 401);
  });
  createSession(ctx.req, ctx.res, 'admin', null);
  addLog('Kinobesitzer', 'Admin-Anmeldung', '');
  return { ok: true };
});

route('POST', '/api/admin/logout', null, (ctx) => {
  const t = parseCookies(ctx.req)[ADMIN_COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  setCookie(ctx.req, ctx.res, ADMIN_COOKIE, '', 0);
  return { ok: true };
});

// ---------- Mitarbeiter ----------

function calendarPayload(empId) {
  const emp = getEmployee(empId);
  const s = getSettings();
  const notices = db.prepare('SELECT id, text, created_at FROM notices WHERE employee_id = ? AND seen = 0 ORDER BY id DESC').all(emp.id);
  return {
    me: { id: emp.id, name: employeeName(emp), firstName: emp.first_name, points: emp.minus_points, warnAt: s.karma_warn },
    days: calendarFor(emp.id),
    notices: notices.map((n) => ({ ...n, when: formatInstant(new Date(n.created_at)) })),
    releaseRule: releaseRuleText(s),
    shiftMinutes: s.shift_minutes_before,
    aiEnabled: aiAvailable(),
  };
}

route('GET', '/api/calendar', 'employee', ({ emp }) => calendarPayload(emp.id));

route('GET', '/api/my', 'employee', ({ emp }) => {
  const s = getSettings();
  const names = employeeNames();
  const now = new Date();
  const upcoming = db.prepare(`SELECT * FROM shows WHERE employee_id = ? AND date >= ? ORDER BY date, time`).all(emp.id, addDays(todayBerlin(), -1))
    .map((sh) => ({ ...shiftView(sh, s, emp.id, now, names), dateLabel: formatDateShort(sh.date) }))
    .filter((v) => !v.past || v.date === todayBerlin());
  const events = db.prepare('SELECT delta, reason, created_at FROM karma_events WHERE employee_id = ? ORDER BY id DESC LIMIT 20').all(emp.id)
    .map((e) => ({ ...e, when: formatInstant(new Date(e.created_at)) }));
  return { points: emp.minus_points, warnAt: s.karma_warn, explanation: karmaExplanation(s), events, upcoming };
});

// Die Antwort enthält gleich den neuen Kalender – so reicht eine einzige Anfrage pro Klick.
route('POST', '/api/shifts/:id/book', 'employee', ({ emp, params }) => {
  const r = bookShift(emp.id, Number(params.id));
  return { ...r, calendar: calendarPayload(emp.id) };
});
route('POST', '/api/shifts/:id/cancel', 'employee', ({ emp, params }) => {
  const r = cancelOwnShift(emp.id, Number(params.id));
  return { ...r, calendar: calendarPayload(emp.id) };
});

route('POST', '/api/notices/seen', 'employee', ({ emp }) => {
  db.prepare('UPDATE notices SET seen = 1 WHERE employee_id = ?').run(emp.id);
  return { ok: true };
});

route('POST', '/api/chat', 'employee', async ({ emp, body }) => {
  limit(`chat:${emp.id}`, 40, 3600000);
  return employeeChat(emp.id, body.history, body.question);
});

// ---------- Admin ----------

route('GET', '/api/admin/overview', 'admin', () => ({ ...adminOverview(), aiEnabled: aiAvailable() }));

route('GET', '/api/admin/shows', 'admin', ({ url }) => {
  const s = getSettings();
  const from = isValidDate(url.searchParams.get('from')) ? url.searchParams.get('from') : todayBerlin();
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 21, 1), 90);
  const to = addDays(from, days - 1);
  const names = employeeNames();
  const now = new Date();
  const rows = db.prepare('SELECT * FROM shows WHERE date BETWEEN ? AND ? ORDER BY date, time').all(from, to);
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    out.push({ date: d, label: formatDateShort(d), weekday: WEEKDAYS[weekdayOf(d)], shifts: [] });
  }
  const map = new Map(out.map((d) => [d.date, d]));
  for (const r of rows) {
    map.get(r.date).shifts.push({ ...shiftView(r, s, null, now, names), employeeId: r.employee_id, source: r.source });
  }
  return { from, days: out };
});

function showIdsAction(desc, showId, fn) {
  return runAdminAction(desc, { showIds: [showId] }, fn);
}
const labelOf = (id) => { const sh = db.prepare('SELECT * FROM shows WHERE id = ?').get(id); return sh ? showLabel(sh) : `#${id}`; };

route('POST', '/api/admin/shows', 'admin', ({ body }) => {
  const r = runAdminAction(`Vorstellung angelegt: ${body.film} ${body.date} ${body.time}`, {}, () => ops.addShow(body));
  return { message: 'Vorstellung angelegt.', actionId: r.actionId };
});
route('PUT', '/api/admin/shows/:id', 'admin', ({ params, body }) => {
  const id = Number(params.id);
  const r = showIdsAction(`Vorstellung geändert: ${labelOf(id)}`, id, () => ops.updateShow(id, body));
  return { message: 'Gespeichert.', actionId: r.actionId };
});
route('POST', '/api/admin/shows/:id/cancel', 'admin', ({ params }) => {
  const id = Number(params.id);
  const r = showIdsAction(`Vorstellung gestrichen: ${labelOf(id)}`, id, () => ops.cancelShow(id));
  return { message: 'Vorstellung gestrichen. Keine Minuspunkte für die eingetragene Person.', actionId: r.actionId };
});
route('POST', '/api/admin/shows/:id/restore', 'admin', ({ params }) => {
  const id = Number(params.id);
  const r = showIdsAction(`Vorstellung wieder aufgenommen: ${labelOf(id)}`, id, () => ops.restoreShow(id));
  return { message: 'Vorstellung findet wieder statt.', actionId: r.actionId };
});
route('DELETE', '/api/admin/shows/:id', 'admin', ({ params }) => {
  const id = Number(params.id);
  const r = showIdsAction(`Vorstellung gelöscht: ${labelOf(id)}`, id, () => ops.deleteShow(id));
  return { message: 'Vorstellung gelöscht.', actionId: r.actionId };
});
route('POST', '/api/admin/shows/:id/assign', 'admin', ({ params, body }) => {
  const id = Number(params.id);
  const empId = Number(body.employeeId);
  const r = runAdminAction(`${employeeName(getEmployee(empId))} eingetragen: ${labelOf(id)}`, { showIds: [id] }, () => ops.assign(id, empId));
  return { message: 'Eingetragen. Die Person sieht einen Hinweis.', actionId: r.actionId };
});
route('POST', '/api/admin/shows/:id/unassign', 'admin', ({ params }) => {
  const id = Number(params.id);
  const r = showIdsAction(`Aus Schicht genommen: ${labelOf(id)}`, id, () => ops.unassign(id));
  return { message: 'Ausgetragen. Keine Minuspunkte.', actionId: r.actionId };
});

route('GET', '/api/admin/employees', 'admin', () => {
  const s = getSettings();
  const today = todayBerlin();
  const rows = db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM shows WHERE employee_id = e.id AND status = 'active' AND date >= ?) AS upcoming
    FROM employees e ORDER BY e.minus_points DESC, e.first_name, e.last_name`).all(today);
  return {
    warnAt: s.karma_warn,
    employees: rows.map((e) => ({
      id: e.id, name: employeeName(e), points: e.minus_points, blocked: !!e.blocked, demo: !!e.is_demo,
      upcoming: e.upcoming, warn: e.minus_points >= s.karma_warn,
    })),
  };
});

const empAction = (desc, fn) => ({ params }) => {
  const id = Number(params.id);
  const emp = getEmployee(id);
  if (!emp) throw new UserError('Diesen Mitarbeiter gibt es nicht.', 404);
  const r = runAdminAction(`${desc}: ${employeeName(emp)}`, { employeeIds: [id] }, () => fn(id));
  return { message: 'Erledigt.', actionId: r.actionId };
};
route('POST', '/api/admin/employees/:id/block', 'admin', empAction('Gesperrt', (id) => ops.setBlocked(id, true)));
route('POST', '/api/admin/employees/:id/unblock', 'admin', empAction('Entsperrt', (id) => ops.setBlocked(id, false)));
route('POST', '/api/admin/employees/:id/reset-points', 'admin', empAction('Punkte zurückgesetzt', (id) => ops.resetPoints(id)));
route('POST', '/api/admin/employees/:id/points', 'admin', (ctx) => empAction('Punkte geändert', (id) => ops.setPoints(id, ctx.body.points))(ctx));
route('DELETE', '/api/admin/employees/:id', 'admin', ({ params }) => deleteEmployee(Number(params.id)));

route('GET', '/api/admin/settings', 'admin', () => ({ settings: getSettings(), aiEnabled: aiAvailable() }));

route('PUT', '/api/admin/settings', 'admin', ({ body }) => {
  const s = getSettings();
  const next = { ...s };
  const int = (k, min, max) => {
    if (body[k] === undefined) return;
    const v = Number(body[k]);
    if (!Number.isInteger(v) || v < min || v > max) throw new UserError(`Bitte eine ganze Zahl zwischen ${min} und ${max} eingeben.`);
    next[k] = v;
  };
  int('shift_minutes_before', 0, 240);
  int('release_weekday', 0, 6);
  for (const k of ['karma_far', 'karma_mid', 'karma_near', 'karma_same_day', 'karma_bonus']) int(k, 0, 500);
  int('karma_far_days', 1, 60);
  int('karma_near_days', 1, 60);
  int('karma_warn', 1, 5000);
  if (body.release_time !== undefined) {
    if (!isValidTime(body.release_time)) throw new UserError('Bitte die Uhrzeit so eingeben: 21:00');
    next.release_time = body.release_time;
  }
  for (const k of ['release_enabled', 'import_auto']) if (body[k] !== undefined) next[k] = !!body[k];
  for (const k of ['import_url', 'import_pdf_url']) {
    if (body[k] === undefined) continue;
    const v = String(body[k]).trim();
    if (v && !/^https?:\/\/\S+$/.test(v)) throw new UserError('Bitte eine gültige Internetadresse (https://…) eingeben.');
    next[k] = v;
  }
  if (next.karma_near_days >= next.karma_far_days) {
    throw new UserError('Die kurze Frist muss kleiner sein als die lange Frist (z. B. 3 und 7 Tage).');
  }
  const changed = Object.keys(DEFAULT_SETTINGS).filter((k) => next[k] !== s[k]);
  for (const k of changed) setSetting(k, next[k]);
  if (changed.length) addLog('Kinobesitzer', 'Einstellungen', changed.map((k) => `${k}: ${s[k]} → ${next[k]}`).join(', '));
  return { message: 'Einstellungen gespeichert.', settings: getSettings() };
});

route('POST', '/api/admin/password', 'admin', ({ req, body }) => {
  const kind = body.kind === 'admin' ? 'admin' : 'shared';
  const pw = String(body.password || '');
  if (pw.length < (kind === 'admin' ? 8 : 4)) {
    throw new UserError(kind === 'admin' ? 'Das Admin-Passwort braucht mindestens 8 Zeichen.' : 'Das Kino-Passwort braucht mindestens 4 Zeichen.');
  }
  setPassword(kind, pw);
  if (kind === 'admin') {
    const mine = sha(parseCookies(req)[ADMIN_COOKIE] || '');
    db.prepare(`DELETE FROM sessions WHERE role = 'admin' AND token_hash != ?`).run(mine);
  } else if (body.logoutAll) {
    db.prepare(`DELETE FROM sessions WHERE role = 'employee'`).run();
  }
  addLog('Kinobesitzer', kind === 'admin' ? 'Admin-Passwort geändert' : 'Kino-Passwort geändert', body.logoutAll ? 'Alle Mitarbeiter abgemeldet' : '');
  return { message: 'Neues Passwort gespeichert.' };
});

route('GET', '/api/admin/log', 'admin', ({ url }) => {
  const q = (url.searchParams.get('q') || '').trim();
  const rows = q
    ? db.prepare(`SELECT * FROM log WHERE actor LIKE ? OR action LIKE ? OR details LIKE ? ORDER BY id DESC LIMIT 300`).all(`%${q}%`, `%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM log ORDER BY id DESC LIMIT 300').all();
  return { entries: rows.map((r) => ({ ...r, when: formatInstant(new Date(r.at)) })) };
});

route('GET', '/api/admin/actions', 'admin', () => ({
  actions: db.prepare('SELECT id, created_at, description, undone FROM admin_actions ORDER BY id DESC LIMIT 40').all()
    .map((a) => ({ ...a, when: formatInstant(new Date(a.created_at)) })),
}));
route('POST', '/api/admin/actions/:id/undo', 'admin', ({ params }) => undoAdminAction(Number(params.id)));

route('GET', '/api/admin/import', 'admin', () => ({ latest: latestImport(), aiEnabled: aiAvailable() }));
route('POST', '/api/admin/import/run', 'admin', async () => {
  const r = await runImport('manual');
  return { latest: latestImport(), message: r.status === 'nochange' ? 'Alles aktuell – es gibt keine Änderungen.' : r.message };
});
route('POST', '/api/admin/import/:id/apply', 'admin', ({ params }) => applyImport(Number(params.id)));
route('POST', '/api/admin/import/:id/discard', 'admin', ({ params }) => discardImport(Number(params.id)));

route('POST', '/api/admin/chat', 'admin', async ({ body }) => {
  limit('adminchat', 120, 3600000);
  return adminChat(body.history, body.question);
});
route('POST', '/api/admin/chat/confirm', 'admin', ({ body }) => confirmAdminProposal(body.proposalId));

route('POST', '/api/admin/demo/remove', 'admin', () => removeDemoData());

// Datensicherung: eine vollständige Kopie der Datenbank als Datei zum Herunterladen.
route('GET', '/api/admin/backup', 'admin', async ({ res }) => {
  const tmp = path.join(os.tmpdir(), `kino-sicherung-${crypto.randomUUID()}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  try {
    const data = await readFile(tmp);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="kino-sicherung-${todayBerlin()}.db"`,
      'Cache-Control': 'no-store',
    });
    res.end(data);
    addLog('Kinobesitzer', 'Datensicherung', 'Heruntergeladen');
  } finally {
    await unlink(tmp).catch(() => {});
  }
  return RAW;
});

// ---------- Statische Dateien ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

const staticCache = new Map();

async function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname === '/admin' || pathname === '/admin/' ? '/admin.html' : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404); return res.end(); }
  try {
    // Dateien ändern sich nur bei einem Update (= Neustart). Darum im Speicher halten und mit
    // ETag ausliefern: Kennt der Browser die Datei schon, genügt die kurze Antwort "unverändert" (304).
    let entry = staticCache.get(full);
    if (!entry) {
      const data = await readFile(full);
      entry = { data, etag: `"${crypto.createHash('sha1').update(data).digest('base64url')}"` };
      staticCache.set(full, entry);
    }
    const headers = {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: entry.etag,
    };
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : entry.data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Seite nicht gefunden.');
  }
}

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }

  try {
    // Schutz gegen fremde Seiten, die im Namen des Browsers etwas abschicken wollen.
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'kino') {
      throw new UserError('Ungültige Anfrage.', 403);
    }
    let match = null;
    let r = null;
    for (const candidate of routes) {
      if (candidate.method !== req.method) continue;
      match = url.pathname.match(candidate.re);
      if (match) { r = candidate; break; }
    }
    if (!r) throw new UserError('Nicht gefunden.', 404);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
    const ctx = { req, res, url, params, body: req.method === 'GET' ? {} : await readJson(req) };
    if (r.role === 'employee') {
      ctx.emp = currentEmployee(req);
      if (!ctx.emp) throw new UserError('Bitte melde dich an.', 401);
    } else if (r.role === 'admin') {
      if (!isAdmin(req)) throw new UserError('Bitte als Kinobesitzer anmelden.', 401);
    }
    const result = await r.handler(ctx);
    if (result !== RAW) send(res, 200, result);
  } catch (err) {
    if (err instanceof UserError) return send(res, err.status, { error: err.userMessage });
    console.error(err);
    send(res, 500, { error: 'Da ist leider etwas schiefgegangen. Bitte lade die Seite neu und versuch es noch einmal.' });
  }
});

server.listen(PORT, () => {
  console.log(`Schichtplan läuft auf http://localhost:${PORT}  (Admin: http://localhost:${PORT}/admin)`);
  console.log(aiAvailable() ? 'KI-Funktionen: aktiv' : 'KI-Funktionen: aus (ANTHROPIC_API_KEY fehlt)');
});
