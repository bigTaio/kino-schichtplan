// Programm-Import von der Kino-Website.
// 1. Seite (oder ersatzweise das PDF) holen  2. Claude macht daraus eine saubere Liste
// 3. Vergleich mit dem Kalender -> Vorschau  4. Erst nach Bestätigung wird etwas geändert.
import { db, nowIso, getSettings, addLog, getShow, employeeName, getEmployee } from './db.js';
import { ops, runAdminAction, UserError } from './logic.js';
import { berlinParts, berlinToDate, formatDateLong, todayBerlin, addDays, isValidDate, normalizeTime } from './time.js';
import { askClaude, aiAvailable } from './ai.js';

const UA = 'Mozilla/5.0 (Schichtplan Kino Murnau; Programm-Abgleich)';

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', bdquo: '„', ldquo: '“', rdquo: '”', hellip: '…' };
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n] ?? m);
}

/** HTML -> lesbarer Text mit Zeilenumbrüchen (Reihenfolge bleibt erhalten). */
export function htmlToText(html) {
  const body = html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|ul|ol|table|span)>/gi, '\n')
    .replace(/<(td|th)[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(body)
    .split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean)
    .join('\n');
}

/**
 * Direkter Weg: Die Kinoseite schreibt an jeden "Tickets reservieren"-Knopf Datum, Uhrzeit
 * und Film (data-date, data-time, data-show-movie). Das wird ohne KI ausgelesen.
 */
export function parseStructured(html) {
  const out = [];
  const items = html.split(/class="schedule-item(?=[\s"])/).slice(1);
  for (const chunk of items) {
    const tag = chunk.match(/<button[^>]*class="[^"]*reservation-button[^"]*"[^>]*>/i)?.[0];
    if (!tag) continue;
    const attr = (name) => tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1];
    const d = attr('data-date')?.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    const time = normalizeTime(attr('data-time') || '');
    const film = decodeEntities(attr('data-show-movie') || '').replace(/\s+/g, ' ').trim();
    if (!d || !time || !film) continue;
    const date = `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}`;
    const chip = chunk.match(/class="[^"]*highlight-chip[^"]*"[^>]*>\s*([^<]+?)\s*</i)?.[1];
    const note = chip && !/^normal$/i.test(chip.trim()) ? decodeEntities(chip.trim()) : '';
    out.push({ film, date, time, note });
  }
  return out;
}

/** Für den KI-Weg: HTML verkleinern, aber Aufbau und data-Angaben behalten. */
function simplifyHtml(html) {
  return html.replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(\w+)((?:\s+[^>]*?)?)\s*(\/?)>/g, (m, tag, attrs, self) => {
      const keep = (attrs.match(/\s(?:class|data-[\w-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g) || []).join('');
      return `<${tag}${keep}${self ? ' /' : ''}>`;
    })
    .replace(/\s+/g, ' ');
}

async function fetchWithTimeout(url, ms = 25000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

const IMPORT_SCHEMA = {
  type: 'object',
  properties: {
    shows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          film: { type: 'string' },
          date: { type: 'string', description: 'JJJJ-MM-TT' },
          time: { type: 'string', description: 'HH:MM, 24 Stunden' },
          note: { type: 'string', description: 'z. B. Sonderveranstaltung, Premiere, OmU, Festival – sonst leer' },
        },
        required: ['film', 'date', 'time', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['shows'],
  additionalProperties: false,
};

function importSystem() {
  const p = berlinParts();
  return `Du liest das Programm des Kinos Murnau und machst daraus eine saubere Liste aller Vorstellungen.
Heute ist ${formatDateLong(p.date)}.

So ist das Programm aufgebaut: Es ist nach Filmen sortiert. Unter jedem Film stehen die Spieltage und darunter (getrennt) die Uhrzeiten. Ordne die Uhrzeiten den Tagen in der Reihenfolge zu, in der sie stehen. Ein Film kann an einem Tag mehrmals laufen – dann ist jede Uhrzeit eine eigene Vorstellung.
Es gibt auch Sonderveranstaltungen (Festivals, Premieren, Vormittagsvorstellungen). Nimm sie auf und schreib die Art kurz in "note".

Regeln:
- Eine Zeile pro Vorstellung: film, date (JJJJ-MM-TT), time (HH:MM, 24-Stunden-Format), note.
- Fehlt die Jahreszahl, nimm das Jahr, in dem das Datum ab heute als Nächstes vorkommt.
- Filmtitel so schreiben, wie sie im Programm stehen, ohne Zusätze wie Altersfreigabe oder Laufzeit.
- Nur Vorstellungen, die eindeutig im Programm stehen. Nichts erfinden. Im Zweifel weglassen.
- Vorstellungen, die vor heute liegen, weglassen.`;
}

async function extractShows() {
  const s = getSettings();
  let html = '';
  try {
    html = await (await fetchWithTimeout(s.import_url)).text();
  } catch (err) {
    console.error('Programmseite nicht erreichbar:', err.message);
  }

  let result = null;
  const structured = html ? parseStructured(html) : [];
  if (structured.length) {
    result = { shows: structured, method: 'direkt' };
  } else if (html && htmlToText(html).length > 300) {
    if (!aiAvailable()) throw new UserError('Die Kino-Website hat ihren Aufbau geändert. Zum Auslesen wird jetzt der KI-Schlüssel gebraucht.', 503);
    result = await askClaude({
      system: importSystem(),
      messages: `Hier ist die (vereinfachte) Programmseite ${s.import_url}. Die Zuordnung von Uhrzeiten zu Tagen steckt im HTML-Aufbau (z. B. data-day, data-date).\n\n<programm>\n${simplifyHtml(html).slice(0, 150000)}\n</programm>`,
      effort: 'medium', schema: IMPORT_SCHEMA, maxTokens: 32000,
    });
    result.method = 'KI';
  }
  // Ersatzweg: PDF-Programm, falls die Seite nichts Brauchbares geliefert hat.
  if (!result?.shows?.length && s.import_pdf_url && aiAvailable()) {
    try {
      const buf = Buffer.from(await (await fetchWithTimeout(s.import_pdf_url, 40000)).arrayBuffer());
      result = await askClaude({
        system: importSystem(),
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
            { type: 'text', text: 'Das ist das Programm als PDF. Erstelle daraus die Liste.' },
          ],
        }],
        effort: 'medium', schema: IMPORT_SCHEMA, maxTokens: 32000,
      });
      result.method = 'KI (PDF)';
    } catch (err) {
      if (err instanceof UserError) throw err;
      console.error('Programm-PDF nicht erreichbar:', err.message);
    }
  }
  if (!result) throw new UserError('Die Kino-Website war nicht erreichbar. Bitte später noch einmal versuchen oder Vorstellungen von Hand eintragen.', 502);

  // Ergebnis prüfen und bereinigen – nur gültige ab heute, ohne Doppelte.
  // Heutige Vorstellungen, die schon vorbei sind, bleiben drin: Sie erscheinen ausgegraut,
  // damit der Kalender "heute" nicht fälschlich leer aussieht.
  const today = todayBerlin();
  const maxDate = addDays(today, 120);
  const seen = new Set();
  const clean = [];
  for (const r of result.shows || []) {
    const film = String(r.film || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const time = normalizeTime(String(r.time || ''));
    if (!film || !time || !isValidDate(r.date) || r.date < today || r.date > maxDate) continue;
    const key = `${r.date}|${time}|${norm(film)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ film, date: r.date, time, note: String(r.note || '').trim().slice(0, 80) });
  }
  return { shows: clean, method: result.method };
}

const norm = (s) => s.toLocaleLowerCase('de-DE').replace(/[^a-z0-9äöüß]/g, '');

/** Vergleicht die importierte Liste mit dem Kalender. */
export function diffProgram(imported) {
  const today = todayBerlin();
  if (!imported.length) return { added: [], changed: [], removed: [] };
  const maxDate = imported.reduce((m, x) => (x.date > m ? x.date : m), today);
  const now = Date.now();
  const started = (o) => berlinToDate(o.date, o.time).getTime() <= now;
  const existing = db.prepare(`SELECT * FROM shows WHERE status = 'active' AND date BETWEEN ? AND ? ORDER BY date, time`)
    .all(today, maxDate);

  // Bereits begonnene Vorstellungen (heute früher): fehlen sie im Kalender, werden sie nur ergänzt
  // (damit "heute" vollständig ist), aber nie mit anderen verwechselt. Vorhandene begonnene werden
  // nie geändert oder als "entfallen" gemeldet – die Kinoseite blendet sie oft aus.
  const same = (o, n) => o.date === n.date && o.time === n.time && norm(o.film) === norm(n.film);
  const pastAdded = imported.filter((n) => started(n) && !existing.some((o) => same(o, n)));
  const newLeft = imported.filter((n) => !started(n));
  const oldLeft = existing.filter((o) => !started(o));
  const take = (arr, pred) => { const i = arr.findIndex(pred); return i >= 0 ? arr.splice(i, 1)[0] : null; };

  // 1. Exakt gleich (Film, Datum, Uhrzeit) -> nichts zu tun.
  for (const n of [...newLeft]) {
    if (take(oldLeft, (o) => o.date === n.date && o.time === n.time && norm(o.film) === norm(n.film))) {
      newLeft.splice(newLeft.indexOf(n), 1);
    }
  }
  const changed = [];
  const pushChange = (o, n) => changed.push({
    show_id: o.id, from: { film: o.film, date: o.date, time: o.time, note: o.note }, to: n,
    assignee: o.employee_id ? employeeName(getEmployee(o.employee_id)) : null,
  });
  // 2. Gleicher Film am gleichen Tag, andere Uhrzeit -> geändert.
  for (const n of [...newLeft]) {
    const o = take(oldLeft, (x) => x.source === 'import' && x.date === n.date && norm(x.film) === norm(n.film));
    if (o) { pushChange(o, n); newLeft.splice(newLeft.indexOf(n), 1); }
  }
  // 3. Gleiche Zeit, anderer Titel (z. B. Tippfehler korrigiert) -> geändert.
  for (const n of [...newLeft]) {
    const o = take(oldLeft, (x) => x.source === 'import' && x.date === n.date && x.time === n.time);
    if (o) { pushChange(o, n); newLeft.splice(newLeft.indexOf(n), 1); }
  }
  // Von Hand eingetragene Vorstellungen werden nie automatisch entfernt.
  const removed = oldLeft.filter((o) => o.source === 'import').map((o) => ({
    show_id: o.id, film: o.film, date: o.date, time: o.time,
    assignee: o.employee_id ? employeeName(getEmployee(o.employee_id)) : null,
  }));
  return { added: [...pastAdded, ...newLeft], changed, removed };
}

let running = false;

export async function runImport(trigger) {
  if (running) throw new UserError('Das Programm wird gerade schon aktualisiert. Bitte einen Moment warten.', 409);
  running = true;
  try {
    const { shows: imported, method } = await extractShows();
    if (!imported.length) {
      db.prepare('INSERT INTO imports(created_at, trigger, status, message) VALUES(?, ?, ?, ?)')
        .run(nowIso(), trigger, 'failed', 'Keine Vorstellungen gefunden');
      addLog('System', 'Import', 'Fehlgeschlagen: keine Vorstellungen gefunden');
      throw new UserError('Auf der Kino-Website wurden keine Vorstellungen gefunden. Am Kalender wurde nichts geändert.', 502);
    }
    const diff = diffProgram(imported);
    const total = diff.added.length + diff.changed.length + diff.removed.length;
    // Ältere, nicht bestätigte Vorschläge sind damit überholt.
    db.prepare(`UPDATE imports SET status = 'discarded' WHERE status = 'pending'`).run();
    const status = total ? 'pending' : 'nochange';
    const message = `Neu: ${diff.added.length}, geändert: ${diff.changed.length}, entfallen: ${diff.removed.length}`;
    const info = db.prepare('INSERT INTO imports(created_at, trigger, status, message, proposal) VALUES(?, ?, ?, ?, ?)')
      .run(nowIso(), trigger, status, message, JSON.stringify(diff));
    addLog('System', 'Import', `${trigger === 'auto' ? 'Automatisch' : 'Von Hand'} geprüft (${imported.length} Vorstellungen gelesen, ${method}) – ${total ? message : 'keine Änderungen'}`);
    return { id: Number(info.lastInsertRowid), status, message, ...diff, found: imported.length };
  } finally {
    running = false;
  }
}

export function latestImport() {
  const row = db.prepare('SELECT * FROM imports ORDER BY id DESC LIMIT 1').get();
  if (!row) return null;
  return { id: row.id, created_at: row.created_at, trigger: row.trigger, status: row.status, message: row.message, ...(row.proposal ? JSON.parse(row.proposal) : {}) };
}

export function applyImport(importId) {
  const row = db.prepare('SELECT * FROM imports WHERE id = ?').get(importId);
  if (!row || row.status !== 'pending') throw new UserError('Dieser Import ist nicht mehr aktuell. Bitte „Programm aktualisieren“ neu drücken.', 409);
  const diff = JSON.parse(row.proposal);
  const showIds = [...diff.changed.map((c) => c.show_id), ...diff.removed.map((r) => r.show_id)];
  const skipped = [];
  const result = runAdminAction(`Programm übernommen (${row.message})`, { showIds }, () => {
    const created = [];
    for (const a of diff.added) {
      try { created.push(...ops.addShow(a, 'import').createdShowIds); } catch (e) { if (e instanceof UserError) skipped.push(a); else throw e; }
    }
    for (const c of diff.changed) {
      const cur = getShow(c.show_id);
      if (!cur || cur.status !== 'active') { skipped.push(c.to); continue; }
      ops.updateShow(c.show_id, c.to);
    }
    for (const r of diff.removed) {
      const cur = getShow(r.show_id);
      if (!cur || cur.status !== 'active') continue;
      ops.cancelShow(r.show_id);
    }
    db.prepare(`UPDATE imports SET status = 'applied' WHERE id = ?`).run(importId);
    addLog('Kinobesitzer', 'Import bestätigt', row.message);
    return { createdShowIds: created };
  });
  return { message: `Programm übernommen. ${row.message}.${skipped.length ? ` ${skipped.length} übersprungen.` : ''}`, actionId: result.actionId };
}

export function discardImport(importId) {
  db.prepare(`UPDATE imports SET status = 'discarded' WHERE id = ? AND status = 'pending'`).run(importId);
  addLog('Kinobesitzer', 'Import verworfen', `Import ${importId}`);
  return { message: 'Vorschlag verworfen. Am Kalender wurde nichts geändert.' };
}

/** Einmal täglich (ab 6 Uhr morgens) automatisch prüfen. */
export function startDailyImport() {
  const check = async () => {
    try {
      const s = getSettings();
      if (!s.import_auto) return;
      const p = berlinParts();
      if (p.h < 6) return;
      const last = db.prepare(`SELECT created_at FROM imports WHERE trigger = 'auto' ORDER BY id DESC LIMIT 1`).get();
      if (last && berlinParts(new Date(last.created_at)).date === p.date) return;
      await runImport('auto');
    } catch (err) {
      console.error('Automatischer Import:', err.userMessage || err.message);
      if (!(err instanceof UserError) || !/keine Vorstellungen/.test(err.userMessage)) {
        db.prepare('INSERT INTO imports(created_at, trigger, status, message) VALUES(?, ?, ?, ?)')
          .run(nowIso(), 'auto', 'failed', err.userMessage || 'Unbekannter Fehler');
      }
    }
  };
  setTimeout(check, 30000);
  setInterval(check, 15 * 60000);
}
