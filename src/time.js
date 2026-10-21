// Alle Zeitrechnungen laufen über die Zeitzone Europe/Berlin.
// Vorstellungen werden als lokales Datum ("2026-10-23") und lokale Uhrzeit ("20:15")
// gespeichert, so wie das Kino sie veröffentlicht. Für Vergleiche wird daraus der
// echte Zeitpunkt berechnet – dadurch stimmen Sommer- und Winterzeit automatisch.

export const TZ = 'Europe/Berlin';

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
export const WEEKDAYS_SHORT = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];

/** Datum/Uhrzeit eines Zeitpunkts in Berlin. */
export function berlinParts(at = new Date()) {
  const p = Object.fromEntries(partsFmt.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second,
  };
}

export function todayBerlin() {
  return berlinParts().date;
}

/** Berliner Ortszeit -> echter Zeitpunkt (Date). Berücksichtigt Sommer-/Winterzeit. */
export function berlinToDate(dateStr, timeStr = '00:00') {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = berlinParts(new Date(guess));
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    const diff = wanted - shown;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "Fr. 23.10." */
export function formatDateShort(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${WEEKDAYS_SHORT[weekdayOf(dateStr)]} ${d}.${m}.`;
}

/** "Freitag, 23.10.2026" */
export function formatDateLong(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${WEEKDAYS[weekdayOf(dateStr)]}, ${d}.${m}.${y}`;
}

/** Zeitpunkt (Date) -> "23.10.2026, 20:15 Uhr" in Berliner Zeit */
export function formatInstant(at) {
  const p = berlinParts(at);
  const [y, m, d] = p.date.split('-');
  return `${d}.${m}.${y}, ${p.time} Uhr`;
}

/** Schichtbeginn (Berliner Ortszeit) = Filmbeginn minus X Minuten. */
export function shiftStart(dateStr, timeStr, minutesBefore) {
  const start = new Date(berlinToDate(dateStr, timeStr).getTime() - minutesBefore * 60000);
  return { at: start, ...berlinParts(start) };
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** Akzeptiert "20.15", "20:15", "9:30", "2015" und macht daraus "20:15". */
export function normalizeTime(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,2})[:.]?(\d{2})$/);
  if (!m) return null;
  const t = `${m[1].padStart(2, '0')}:${m[2]}`;
  return isValidTime(t) ? t : null;
}
