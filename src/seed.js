// Beispiel-Mitarbeiter zum Ausprobieren. Sie sind mit is_demo = 1 markiert und lassen sich
// im Admin-Bereich mit einem Klick ("Beispieldaten löschen") entfernen.
// Erfundene Vorstellungen gibt es bewusst nicht: Die kommen nur aus dem echten Kinoprogramm
// ("Programm aktualisieren") oder werden von Hand eingetragen – so stimmen die Zeiten immer.
import { db, tx, nowIso, nameKey, addLog } from './db.js';

const PEOPLE = [
  ['Anna', 'Berger', 20], ['Max', 'Mustermann', 110], ['Lena', 'Huber', 0], ['Tobias', 'Maier', 40], ['Max', 'Moser', 0],
];

export function seedDemoIfEmpty() {
  if (process.env.SEED_DEMO === 'false') return;
  const hasData = db.prepare('SELECT (SELECT COUNT(*) FROM employees) + (SELECT COUNT(*) FROM shows) AS n').get().n > 0;
  if (hasData) return;
  tx(() => {
    const insert = db.prepare(`INSERT INTO employees(first_name, last_name, name_key, minus_points, is_demo, created_at)
      VALUES(?, ?, ?, ?, 1, ?)`);
    for (const [first, last, points] of PEOPLE) insert.run(first, last, nameKey(first, last), points, nowIso());
    addLog('System', 'Beispieldaten', 'Beispiel-Mitarbeiter angelegt');
  });
  console.log('Beispiel-Mitarbeiter angelegt. Vorstellungen: im Admin-Bereich "Programm aktualisieren".');
}

export function removeDemoData() {
  return tx(() => {
    // Ältere Installationen hatten noch erfundene Vorstellungen – die werden mit entfernt.
    const shows = db.prepare('DELETE FROM shows WHERE is_demo = 1').run().changes;
    db.prepare('UPDATE shows SET employee_id = NULL, assigned_at = NULL WHERE employee_id IN (SELECT id FROM employees WHERE is_demo = 1)').run();
    const people = db.prepare('DELETE FROM employees WHERE is_demo = 1').run().changes;
    addLog('Kinobesitzer', 'Beispieldaten gelöscht', `${people} Mitarbeiter${shows ? `, ${shows} Vorstellungen` : ''}`);
    return { message: `Beispieldaten gelöscht (${people} Beispiel-Mitarbeiter${shows ? `, ${shows} Vorstellungen` : ''}).` };
  });
}
