// Datenbank: eine einzige SQLite-Datei (standardmäßig data/kino.db).
// Zum Sichern genügt es, diese Datei zu kopieren (siehe ANLEITUNG.md).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const dbFile = process.env.DATABASE_FILE || path.resolve('data', 'kino.db');
mkdirSync(path.dirname(dbFile), { recursive: true });

export const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employees (
  id           INTEGER PRIMARY KEY,
  first_name   TEXT NOT NULL,
  last_name    TEXT NOT NULL,
  name_key     TEXT NOT NULL UNIQUE,
  pin_hash     TEXT,
  minus_points INTEGER NOT NULL DEFAULT 0,
  blocked      INTEGER NOT NULL DEFAULT 0,
  is_demo      INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shows (
  id                INTEGER PRIMARY KEY,
  film              TEXT NOT NULL,
  date              TEXT NOT NULL,
  time              TEXT NOT NULL,
  note              TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active',
  source            TEXT NOT NULL DEFAULT 'manual',
  employee_id       INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  assigned_at       TEXT,
  short_notice_free INTEGER NOT NULL DEFAULT 0,
  freed_by          INTEGER,
  is_demo           INTEGER NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shows_date ON shows(date, time);
CREATE INDEX IF NOT EXISTS shows_employee ON shows(employee_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  role        TEXT NOT NULL,
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notices (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  seen        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notices_employee ON notices(employee_id, seen);
CREATE TABLE IF NOT EXISTS karma_events (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS log (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  details TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imports (
  id         INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  trigger    TEXT NOT NULL,
  status     TEXT NOT NULL,
  message    TEXT NOT NULL DEFAULT '',
  proposal   TEXT
);
CREATE TABLE IF NOT EXISTS admin_actions (
  id          INTEGER PRIMARY KEY,
  created_at  TEXT NOT NULL,
  description TEXT NOT NULL,
  undo        TEXT NOT NULL,
  undone      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chat_proposals (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  actions    TEXT NOT NULL,
  summary    TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);
`);

/** Führt fn in einer Transaktion aus. Bei einem Fehler wird alles zurückgerollt. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();

// ---------- Einstellungen ----------

export const DEFAULT_SETTINGS = {
  shift_minutes_before: 30,
  release_enabled: true,
  release_weekday: 0, // 0 = Sonntag
  release_time: '21:00',
  karma_far_days: 7,
  karma_near_days: 3,
  karma_far: 10,
  karma_mid: 20,
  karma_near: 40,
  karma_same_day: 60,
  karma_bonus: 10,
  karma_warn: 100,
  import_auto: true,
  import_url: 'https://kino-murnau.de/programm-uebersicht',
  import_pdf_url: 'https://kino-murnau.de/wp-content/uploads/programm/programm.pdf',
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) s[r.key] = JSON.parse(r.value);
  }
  return s;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function getSecret(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

// ---------- Passwörter (nur als Hash gespeichert) ----------

export function hashSecret(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifySecret(plain, stored) {
  if (!stored || typeof plain !== 'string') return false;
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(plain, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// Asynchrone Varianten: Die Prüfung läuft im Hintergrund, der Server bleibt für alle anderen flüssig.
const scryptAsync = promisify(crypto.scrypt);

export async function hashSecretAsync(plain) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(plain), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifySecretAsync(plain, stored) {
  if (!stored || typeof plain !== 'string') return false;
  const [saltHex, hashHex] = stored.split(':');
  const hash = await scryptAsync(plain, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export function setPassword(kind, plain) {
  setSetting(`${kind}_password_hash`, hashSecret(plain));
}

export function checkPassword(kind, plain) {
  return verifySecretAsync(plain, getSecret(`${kind}_password_hash`));
}

/** Beim allerersten Start: Passwörter aus den Umgebungsvariablen übernehmen. */
export function ensurePasswords() {
  // Notfall: Admin-Passwort vergessen -> ADMIN_PASSWORD_RESET setzen, neu starten, danach Variable löschen.
  if (process.env.ADMIN_PASSWORD_RESET) {
    setPassword('admin', process.env.ADMIN_PASSWORD_RESET);
    db.prepare(`DELETE FROM sessions WHERE role = 'admin'`).run();
    addLog('System', 'Admin-Passwort zurückgesetzt', 'Über ADMIN_PASSWORD_RESET beim Start');
    console.log('>>> Admin-Passwort wurde über ADMIN_PASSWORD_RESET neu gesetzt. Bitte die Variable jetzt wieder löschen.');
  }
  for (const kind of ['admin', 'shared']) {
    if (getSecret(`${kind}_password_hash`)) continue;
    const envName = kind === 'admin' ? 'ADMIN_PASSWORD' : 'SHARED_PASSWORD';
    const fromEnv = process.env[envName];
    if (fromEnv) {
      setPassword(kind, fromEnv);
    } else {
      const generated = crypto.randomBytes(4).toString('hex');
      setPassword(kind, generated);
      console.log(`\n>>> ${envName} war nicht gesetzt. Vorläufiges Passwort: ${generated}\n`);
    }
  }
}

// ---------- Protokoll & Hinweise ----------

export function addLog(actor, action, details) {
  db.prepare('INSERT INTO log(at, actor, action, details) VALUES(?, ?, ?, ?)').run(nowIso(), actor, action, details);
}

export function addNotice(employeeId, text) {
  if (!employeeId) return;
  db.prepare('INSERT INTO notices(employee_id, text, created_at) VALUES(?, ?, ?)').run(employeeId, text, nowIso());
}

export function employeeName(e) {
  return e ? `${e.first_name} ${e.last_name}` : '';
}

export function getEmployee(id) {
  return id ? db.prepare('SELECT * FROM employees WHERE id = ?').get(id) : undefined;
}

export function getShow(id) {
  return db.prepare('SELECT * FROM shows WHERE id = ?').get(id);
}

export function nameKey(first, last) {
  return `${first} ${last}`.toLocaleLowerCase('de-DE').replace(/\s+/g, ' ').trim();
}
