// Tests der Kernregeln. Start: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATABASE_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'kino-test-')), 'test.db');
process.env.SEED_DEMO = 'false';

const T = await import('../src/time.js');
const { db, setSetting, getSettings, nowIso, getEmployee, getShow, nameKey, hashSecret } = await import('../src/db.js');
const L = await import('../src/logic.js');
const { diffProgram, htmlToText, parseStructured: parseStructuredRef } = await import('../src/importer.js');

function makeEmployee(first, last) {
  return Number(db.prepare('INSERT INTO employees(first_name, last_name, name_key, pin_hash, created_at) VALUES(?, ?, ?, ?, ?)')
    .run(first, last, nameKey(first, last), hashSecret('1234'), nowIso()).lastInsertRowid);
}
function makeShow(date, time, film = 'Testfilm', source = 'manual') {
  return Number(db.prepare('INSERT INTO shows(film, date, time, source, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(film, date, time, source, nowIso(), nowIso()).lastInsertRowid);
}
const today = T.todayBerlin();

// ---------- Zeitzone ----------

test('Sommerzeit/Winterzeit: 20:00 Uhr Berlin ist vor und nach der Umstellung richtig', () => {
  // Umstellung am 25.10.2026 (letzter Sonntag im Oktober)
  assert.equal(T.berlinToDate('2026-10-24', '20:00').toISOString(), '2026-10-24T18:00:00.000Z'); // Sommerzeit UTC+2
  assert.equal(T.berlinToDate('2026-10-26', '20:00').toISOString(), '2026-10-26T19:00:00.000Z'); // Winterzeit UTC+1
  assert.equal(T.berlinToDate('2027-03-27', '20:00').toISOString(), '2027-03-27T19:00:00.000Z');
  assert.equal(T.berlinToDate('2027-03-29', '20:00').toISOString(), '2027-03-29T18:00:00.000Z');
});

test('Schichtbeginn über Mitternacht und über die Zeitumstellung', () => {
  const a = T.shiftStart('2026-11-05', '00:15', 30);
  assert.equal(a.date, '2026-11-04');
  assert.equal(a.time, '23:45');
  // In der Nacht der Umstellung: 03:30 Uhr minus 90 Minuten = 02:00 Uhr (Winterzeit), echte Zeit 1,5 h früher
  const b = T.shiftStart('2026-10-25', '03:30', 90);
  assert.equal(T.berlinToDate('2026-10-25', '03:30').getTime() - b.at.getTime(), 90 * 60000);
});

test('Freigabe: Sonntag 21:00 Uhr gibt die folgende Woche frei', () => {
  const s = { release_enabled: true, release_weekday: 0, release_time: '21:00' };
  const r = L.releaseMoment('2026-10-28', s); // Mittwoch
  assert.equal(r.date, '2026-10-25');
  assert.equal(r.at.toISOString(), '2026-10-25T20:00:00.000Z'); // 21:00 Winterzeit
  assert.equal(L.releaseMoment('2026-10-26', s).date, '2026-10-25'); // Montag
  assert.equal(L.releaseMoment('2026-11-01', s).date, '2026-10-25'); // Sonntag gehört zur selben Woche
  // Donnerstag 18:00 als Freigabetag
  const s2 = { release_enabled: true, release_weekday: 4, release_time: '18:00' };
  assert.equal(L.releaseMoment('2026-10-28', s2).date, '2026-10-22');
  assert.equal(L.releaseMoment('2026-10-28', { release_enabled: false }), null);
});

test('Uhrzeiten werden vereinheitlicht', () => {
  assert.equal(T.normalizeTime('20.15'), '20:15');
  assert.equal(T.normalizeTime('9:30'), '09:30');
  assert.equal(T.normalizeTime('25:00'), null);
  assert.equal(T.isValidDate('2026-02-30'), false);
});

// ---------- Karma ----------

test('Minuspunkte je nach Zeitpunkt der Absage (Standardwerte 10/20/40/60)', () => {
  const s = { ...getSettings(), shift_minutes_before: 30 };
  assert.equal(s.karma_bonus, 10);
  assert.equal(s.karma_warn, 100);
  const now = T.berlinToDate('2026-11-10', '10:00');
  const p = (date, time) => L.cancelPenalty({ date, time }, s, now).points;
  assert.equal(p('2026-11-10', '20:00'), 60); // selber Tag
  assert.equal(p('2026-11-11', '20:00'), 40); // weniger als 3 Tage
  assert.equal(p('2026-11-15', '20:00'), 20); // 3 bis 7 Tage
  assert.equal(p('2026-11-25', '20:00'), 10); // mehr als 7 Tage
});

// ---------- Eintragen ----------

test('Doppelbuchung ist unmöglich: nur die erste Person bekommt die Schicht', async () => {
  setSetting('release_enabled', false);
  const a = makeEmployee('Erika', 'Eins');
  const b = makeEmployee('Bernd', 'Zwei');
  const show = makeShow(T.addDays(today, 5), '20:15');
  const results = await Promise.allSettled([
    Promise.resolve().then(() => L.bookShift(a, show)),
    Promise.resolve().then(() => L.bookShift(b, show)),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.userMessage, 'Diese Schicht ist leider schon vergeben.');
  assert.equal(getShow(show).employee_id, a);
});

test('Vor der Freigabe ist Eintragen gesperrt', () => {
  setSetting('release_enabled', true);
  setSetting('release_weekday', 0);
  setSetting('release_time', '21:00');
  const e = makeEmployee('Frieda', 'Früh');
  const far = T.addDays(today, 13);
  const show = makeShow(far, '20:00');
  const rel = L.releaseMoment(far, { release_enabled: true, release_weekday: 0, release_time: '21:00' });
  if (new Date() < rel.at) {
    assert.throws(() => L.bookShift(e, show), /erst ab/);
  }
  setSetting('release_enabled', false);
});

test('Absagen gibt Minuspunkte, Einspringen gibt einen Punkt zurück', () => {
  setSetting('release_enabled', false);
  const a = makeEmployee('Anna', 'Absage');
  const b = makeEmployee('Ben', 'Bonus');
  db.prepare('UPDATE employees SET minus_points = 30 WHERE id = ?').run(b);
  const show = makeShow(T.addDays(today, 1), '20:00');
  L.bookShift(a, show);
  L.cancelOwnShift(a, show);
  assert.equal(getEmployee(a).minus_points, 40);
  assert.equal(getShow(show).employee_id, null);
  assert.equal(getShow(show).short_notice_free, 1);
  // Wer selbst abgesagt hat, bekommt beim Wieder-Eintragen keinen Bonus
  L.bookShift(a, show);
  assert.equal(getEmployee(a).minus_points, 40);
  L.cancelOwnShift(a, show);
  assert.equal(getEmployee(a).minus_points, 80);
  const r = L.bookShift(b, show);
  assert.match(r.message, /10 Minuspunkte erlassen/);
  assert.equal(getEmployee(b).minus_points, 20);
});

test('Man kann nur eigene Schichten absagen', () => {
  const a = makeEmployee('Olga', 'Owner');
  const b = makeEmployee('Igor', 'Intruder');
  const show = makeShow(T.addDays(today, 9), '18:00');
  L.bookShift(a, show);
  assert.throws(() => L.cancelOwnShift(b, show), /nicht eingetragen/);
  assert.equal(getShow(show).employee_id, a);
});

// ---------- Kinobesitzer ----------

test('Streichen durch den Kinobesitzer: keine Minuspunkte, Hinweis an die Person, rückgängig machbar', () => {
  const a = makeEmployee('Paula', 'Plan');
  const show = makeShow(T.addDays(today, 2), '20:00');
  L.bookShift(a, show);
  const before = getEmployee(a).minus_points;
  const r = L.runAdminAction('test', { showIds: [show] }, () => L.ops.cancelShow(show));
  assert.equal(getShow(show).status, 'cancelled');
  assert.equal(getShow(show).employee_id, null);
  assert.equal(getEmployee(a).minus_points, before);
  const notices = db.prepare('SELECT text FROM notices WHERE employee_id = ?').all(a);
  assert.ok(notices.some((n) => /fällt aus/.test(n.text)));
  L.undoAdminAction(r.actionId);
  assert.equal(getShow(show).status, 'active');
  assert.equal(getShow(show).employee_id, a);
  assert.throws(() => L.undoAdminAction(r.actionId), /schon rückgängig/);
});

test('Rückgängig wird verweigert, wenn sich inzwischen etwas geändert hat', () => {
  const a = makeEmployee('Karl', 'Konflikt');
  const show = makeShow(T.addDays(today, 4), '17:30');
  const r = L.runAdminAction('test', { showIds: [show] }, () => L.ops.updateShow(show, { time: '18:00' }));
  L.bookShift(a, show);
  assert.throws(() => L.undoAdminAction(r.actionId), /nicht mehr möglich/);
  assert.equal(getShow(show).employee_id, a);
});

test('Neu angelegte Vorstellung lässt sich rückgängig machen', () => {
  const date = T.addDays(today, 6);
  const r = L.runAdminAction('neu', {}, () => L.ops.addShow({ film: 'Rückgängig-Film', date, time: '19:00' }));
  assert.ok(db.prepare('SELECT 1 FROM shows WHERE film = ?').get('Rückgängig-Film'));
  L.undoAdminAction(r.actionId);
  assert.equal(db.prepare('SELECT 1 FROM shows WHERE film = ?').get('Rückgängig-Film'), undefined);
});

test('Gesperrte Mitarbeiter können sich nicht eintragen', () => {
  const a = makeEmployee('Sven', 'Sperre');
  L.runAdminAction('sperren', { employeeIds: [a] }, () => L.ops.setBlocked(a, true));
  const show = makeShow(T.addDays(today, 3), '21:00');
  assert.throws(() => L.bookShift(a, show), /gesperrt/);
});

// ---------- Import ----------

test('Programmvergleich erkennt neu, geändert und entfallen', () => {
  db.prepare('DELETE FROM shows').run();
  const d1 = T.addDays(today, 2);
  const d2 = T.addDays(today, 3);
  const e = makeEmployee('Ida', 'Import');
  makeShow(d1, '17:30', 'Alte Liebe', 'import');
  const moved = makeShow(d1, '20:00', 'Föhnlage', 'import');
  db.prepare('UPDATE shows SET employee_id = ? WHERE id = ?').run(e, moved);
  makeShow(d2, '20:00', 'Gestrichener Film', 'import');
  makeShow(d2, '18:00', 'Von Hand', 'manual');
  const diff = diffProgram([
    { film: 'Alte Liebe', date: d1, time: '17:30', note: '' },
    { film: 'Föhnlage', date: d1, time: '20:30', note: '' },
    { film: 'Neuer Film', date: d2, time: '21:00', note: 'Premiere' },
  ]);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].film, 'Neuer Film');
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].to.time, '20:30');
  assert.equal(diff.changed[0].assignee, 'Ida Import');
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].film, 'Gestrichener Film'); // "Von Hand" bleibt unangetastet
});

test('Heute schon gelaufene Vorstellungen: ergänzt, nie doppelt, nie verwechselt, nie "entfallen"', { skip: T.berlinParts().time > '23:50' }, () => {
  db.prepare('DELETE FROM shows').run();
  makeShow(today, '00:02', 'Schon gelaufen und vorhanden', 'import');
  makeShow(today, '00:03', 'Vorbei, nicht mehr auf der Kinoseite', 'import');
  makeShow(today, '23:58', 'Spätfilm', 'import');
  const diff = diffProgram([
    { film: 'Schon gelaufen und vorhanden', date: today, time: '00:02', note: '' },
    { film: 'Spätfilm', date: today, time: '00:01', note: '' }, // gelaufen, fehlt im Kalender
    { film: 'Spätfilm', date: today, time: '23:58', note: '' },
  ]);
  assert.deepEqual(diff.added.map((a) => a.time), ['00:01']); // ergänzt, nicht als "Spätfilm geändert"
  assert.equal(diff.changed.length, 0);
  assert.equal(diff.removed.length, 0); // 00:03 ist vorbei -> gilt nicht als entfallen
});

test('Spielzeiten werden direkt aus den Reservierungs-Knöpfen gelesen', () => {
  const html = `<div class="schedule-list" data-day="1"><div class="schedule-item"><div><span class="show-time">20:00 Uhr</span>
    <span class="highlight-chip highlight-premiere"> Premiere </span></div>
    <button class="reservation-button" data-show-uuid="x" data-date="21.10.2026" data-time="20:00" data-free-seats=190 data-show-movie="Der perfekte Urlaub">Tickets</button></div></div>
    <div class="schedule-list" data-day="2"><div class="schedule-item"><div><span class="show-time">15:00 Uhr</span><span class="highlight-chip highlight-normal">Normal</span></div>
    <button class="reservation-button" data-date="22.10.2026" data-time="15:00" data-show-movie="Shaun das Schaf &amp; Co">Tickets</button></div>
    <div class="schedule-item even-show"><button class="reservation-button" data-date="22.10.2026" data-time="18:00" data-show-movie="Shaun das Schaf &amp; Co">x</button></div></div>`;
  assert.deepEqual(parseStructuredRef(html), [
    { film: 'Der perfekte Urlaub', date: '2026-10-21', time: '20:00', note: 'Premiere' },
    { film: 'Shaun das Schaf & Co', date: '2026-10-22', time: '15:00', note: '' },
    { film: 'Shaun das Schaf & Co', date: '2026-10-22', time: '18:00', note: '' },
  ]);
});

test('HTML wird zu lesbarem Text', () => {
  const t = htmlToText('<script>x()</script><h2>Alte&nbsp;Liebe</h2><div>Fr 23.10.</div><div>20:15</div>');
  assert.equal(t, 'Alte Liebe\nFr 23.10.\n20:15');
});
