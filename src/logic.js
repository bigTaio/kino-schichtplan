// Kernregeln: Kalender, Eintragen, Absagen, Karma und alle Änderungen des Kinobesitzers.
import {
  db, tx, nowIso, getSettings, addLog, addNotice, employeeName, getEmployee, getShow,
} from './db.js';
import {
  berlinParts, berlinToDate, addDays, weekdayOf, shiftStart, formatDateShort,
  WEEKDAYS, isValidDate, isValidTime, normalizeTime, todayBerlin,
} from './time.js';

export const CALENDAR_DAYS = 14;

/** Fehler, deren Text direkt (freundlich) angezeigt werden darf. */
export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.userMessage = message; }
}

export function showLabel(show) {
  return `${formatDateShort(show.date)}, ${show.time} Uhr („${show.film}“)`;
}

// ---------- Freigabe zum Eintragen ----------

/** Ab wann sind Schichten an diesem Datum buchbar? null = immer. */
export function releaseMoment(dateStr, s) {
  if (!s.release_enabled) return null;
  const wd = weekdayOf(dateStr);
  const monday = addDays(dateStr, -((wd + 6) % 7));
  const daysBack = ((1 - s.release_weekday + 7) % 7) || 7;
  const relDate = addDays(monday, -daysBack);
  return { date: relDate, time: s.release_time, at: berlinToDate(relDate, s.release_time) };
}

export function releaseRuleText(s) {
  if (!s.release_enabled) return 'Eintragen ist jederzeit möglich.';
  return `Jeden ${WEEKDAYS[s.release_weekday]} um ${s.release_time} Uhr wird die folgende Woche (Montag bis Sonntag) freigegeben.`;
}

// ---------- Karma ----------

export function cancelPenalty(show, s, now = new Date()) {
  const start = shiftStart(show.date, show.time, s.shift_minutes_before).at;
  if (show.date === berlinParts(now).date) return { points: s.karma_same_day, level: 'same_day' };
  const days = (start.getTime() - now.getTime()) / 86400000;
  if (days < s.karma_near_days) return { points: s.karma_near, level: 'near' };
  if (days <= s.karma_far_days) return { points: s.karma_mid, level: 'mid' };
  return { points: s.karma_far, level: 'far' };
}

export function karmaExplanation(s) {
  return [
    `Du kannst deine Schichten jederzeit selbst absagen. Damit das nicht zu oft passiert, gibt es Minuspunkte:`,
    `mehr als ${s.karma_far_days} Tage vorher: ${s.karma_far} Punkt${s.karma_far === 1 ? '' : 'e'}`,
    `${s.karma_near_days} bis ${s.karma_far_days} Tage vorher: ${s.karma_mid} Punkte`,
    `weniger als ${s.karma_near_days} Tage vorher: ${s.karma_near} Punkte`,
    `am selben Tag: ${s.karma_same_day} Punkte`,
    `Wenn du eine Schicht übernimmst, die kurzfristig frei geworden ist, bekommst du ${s.karma_bonus} Punkt${s.karma_bonus === 1 ? '' : 'e'} zurück.`,
    `Streicht der Kinobesitzer eine Vorstellung oder nimmt dich aus einer Schicht, gibt es keine Minuspunkte.`,
  ];
}

// ---------- Ansicht einer Schicht ----------

export function shiftView(show, s, viewerId, now = new Date(), names = new Map()) {
  const ss = shiftStart(show.date, show.time, s.shift_minutes_before);
  const started = now >= ss.at;
  const rel = releaseMoment(show.date, s);
  const released = !rel || now >= rel.at;
  const active = show.status === 'active';
  const mine = !!viewerId && show.employee_id === viewerId;
  return {
    id: show.id,
    film: show.film,
    date: show.date,
    time: show.time,
    note: show.note,
    cancelled: !active,
    shiftStart: ss.time,
    shiftStartDate: ss.date,
    assignee: show.employee_id ? (names.get(show.employee_id) || 'Unbekannt') : null,
    mine,
    past: started,
    canBook: active && !show.employee_id && !started && released,
    lockedUntil: active && !show.employee_id && !started && !released
      ? `${formatDateShort(rel.date)}, ${rel.time} Uhr` : null,
    canCancel: active && mine && !started,
    penalty: active && mine && !started ? cancelPenalty(show, s, now).points : null,
    bonus: active && !show.employee_id && !!show.short_notice_free && show.freed_by !== viewerId,
  };
}

export function employeeNames() {
  const map = new Map();
  for (const e of db.prepare('SELECT id, first_name, last_name FROM employees').all()) map.set(e.id, employeeName(e));
  return map;
}

export function calendarFor(viewerId, { from = todayBerlin(), days = CALENDAR_DAYS } = {}) {
  const s = getSettings();
  const to = addDays(from, days - 1);
  const shows = db.prepare('SELECT * FROM shows WHERE date BETWEEN ? AND ? ORDER BY date, time, film').all(from, to);
  const names = employeeNames();
  const now = new Date();
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    out.push({ date, label: formatDateShort(date), weekday: WEEKDAYS[weekdayOf(date)], shifts: [] });
  }
  const byDate = new Map(out.map((d) => [d.date, d]));
  for (const sh of shows) byDate.get(sh.date)?.shifts.push(shiftView(sh, s, viewerId, now, names));
  return out;
}

// ---------- Mitarbeiter: Eintragen & Absagen ----------

export function bookShift(employeeId, showId) {
  return tx(() => {
    const s = getSettings();
    const emp = getEmployee(employeeId);
    if (!emp) throw new UserError('Dein Zugang wurde nicht gefunden. Bitte melde dich neu an.', 401);
    if (emp.blocked) throw new UserError('Dein Zugang ist gesperrt. Bitte sprich mit dem Kinobesitzer.', 403);
    const show = getShow(showId);
    if (!show) throw new UserError('Diese Vorstellung gibt es nicht mehr.', 404);
    if (show.status !== 'active') throw new UserError('Diese Vorstellung fällt leider aus.', 409);
    if (show.employee_id === employeeId) throw new UserError('Du bist hier schon eingetragen.', 409);
    if (show.employee_id) throw new UserError('Diese Schicht ist leider schon vergeben.', 409);
    const now = new Date();
    if (now >= shiftStart(show.date, show.time, s.shift_minutes_before).at) {
      throw new UserError('Diese Schicht hat schon begonnen.', 409);
    }
    const rel = releaseMoment(show.date, s);
    if (rel && now < rel.at) {
      throw new UserError(`Eintragen ist erst ab ${formatDateShort(rel.date)}, ${rel.time} Uhr möglich.`, 409);
    }
    // Die Bedingung "employee_id IS NULL" macht das Eintragen atomar:
    // Klicken zwei Personen gleichzeitig, bekommt nur die erste die Schicht.
    const res = db.prepare(`UPDATE shows SET employee_id = ?, assigned_at = ?, short_notice_free = 0, freed_by = NULL,
      version = version + 1, updated_at = ? WHERE id = ? AND employee_id IS NULL AND status = 'active'`)
      .run(employeeId, nowIso(), nowIso(), showId);
    if (res.changes !== 1) throw new UserError('Diese Schicht ist leider schon vergeben.', 409);

    let message = 'Du bist eingetragen. Danke!';
    if (show.short_notice_free && show.freed_by !== employeeId && s.karma_bonus > 0) {
      const newPoints = Math.max(0, emp.minus_points - s.karma_bonus);
      const delta = newPoints - emp.minus_points;
      if (delta !== 0) {
        db.prepare('UPDATE employees SET minus_points = ?, version = version + 1 WHERE id = ?').run(newPoints, employeeId);
        db.prepare('INSERT INTO karma_events(employee_id, delta, reason, created_at) VALUES(?, ?, ?, ?)')
          .run(employeeId, delta, `Eingesprungen: ${showLabel(show)}`, nowIso());
        addLog(employeeName(emp), 'Punkte', `${-delta} Minuspunkt(e) erlassen fürs Einspringen bei ${showLabel(show)}`);
        message = `Danke fürs Einspringen! Dir wurde${-delta === 1 ? ' 1 Minuspunkt' : ` ${-delta} Minuspunkte`} erlassen.`;
      } else {
        message = 'Danke fürs Einspringen!';
      }
    }
    addLog(employeeName(emp), 'Eintragen', showLabel(show));
    return { message };
  });
}

export function cancelOwnShift(employeeId, showId) {
  return tx(() => {
    const s = getSettings();
    const emp = getEmployee(employeeId);
    if (!emp) throw new UserError('Dein Zugang wurde nicht gefunden. Bitte melde dich neu an.', 401);
    const show = getShow(showId);
    if (!show || show.employee_id !== employeeId) throw new UserError('Du bist in dieser Schicht nicht eingetragen.', 409);
    if (show.status !== 'active') throw new UserError('Diese Vorstellung fällt ohnehin aus.', 409);
    const now = new Date();
    if (now >= shiftStart(show.date, show.time, s.shift_minutes_before).at) {
      throw new UserError('Die Schicht hat schon begonnen. Bitte ruf den Kinobesitzer direkt an.', 409);
    }
    const pen = cancelPenalty(show, s, now);
    const shortNotice = pen.level === 'near' || pen.level === 'same_day' ? 1 : 0;
    const res = db.prepare(`UPDATE shows SET employee_id = NULL, assigned_at = NULL, short_notice_free = ?, freed_by = ?,
      version = version + 1, updated_at = ? WHERE id = ? AND employee_id = ?`)
      .run(shortNotice, employeeId, nowIso(), showId, employeeId);
    if (res.changes !== 1) throw new UserError('Das hat nicht geklappt. Bitte lade die Seite neu.', 409);
    if (pen.points > 0) {
      db.prepare('UPDATE employees SET minus_points = minus_points + ?, version = version + 1 WHERE id = ?').run(pen.points, employeeId);
      db.prepare('INSERT INTO karma_events(employee_id, delta, reason, created_at) VALUES(?, ?, ?, ?)')
        .run(employeeId, pen.points, `Abgesagt: ${showLabel(show)}`, nowIso());
    }
    addLog(employeeName(emp), 'Absage', `${showLabel(show)} – ${pen.points} Minuspunkt(e)`);
    return { message: `Abgesagt. Die Schicht ist wieder frei. (${pen.points} Minuspunkt${pen.points === 1 ? '' : 'e'})` };
  });
}

// ---------- Änderungen durch den Kinobesitzer (alle rückgängig machbar) ----------

function cleanText(v, max = 120) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export function validateShowInput({ film, date, time, note }) {
  const f = cleanText(film);
  const t = normalizeTime(time);
  if (!f) throw new UserError('Bitte gib einen Filmtitel ein.');
  if (!isValidDate(date)) throw new UserError('Bitte wähle ein gültiges Datum.');
  if (!t) throw new UserError('Bitte gib die Uhrzeit so ein: 20:15');
  return { film: f, date, time: t, note: cleanText(note, 80) };
}

function shiftLine(show, s) {
  const ss = shiftStart(show.date, show.time, s.shift_minutes_before);
  return `Schicht ab ${ss.time} Uhr`;
}

export const ops = {
  addShow(input, source = 'manual') {
    const v = validateShowInput(input);
    const dup = db.prepare(`SELECT id FROM shows WHERE date = ? AND time = ? AND lower(film) = lower(?) AND status = 'active'`)
      .get(v.date, v.time, v.film);
    if (dup) throw new UserError('Diese Vorstellung gibt es schon.');
    const info = db.prepare(`INSERT INTO shows(film, date, time, note, source, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)`)
      .run(v.film, v.date, v.time, v.note, source, nowIso(), nowIso());
    const id = Number(info.lastInsertRowid);
    addLog('Kinobesitzer', 'Vorstellung neu', showLabel(v));
    return { createdShowIds: [id] };
  },

  updateShow(id, input) {
    const show = getShow(id);
    if (!show) throw new UserError('Diese Vorstellung gibt es nicht mehr.', 404);
    const v = validateShowInput({ ...show, ...input });
    db.prepare(`UPDATE shows SET film = ?, date = ?, time = ?, note = ?, version = version + 1, updated_at = ? WHERE id = ?`)
      .run(v.film, v.date, v.time, v.note, nowIso(), id);
    const changedTime = v.date !== show.date || v.time !== show.time;
    if (show.employee_id && (changedTime || v.film !== show.film)) {
      addNotice(show.employee_id, `Geändert: Deine Schicht ${showLabel(show)} ist jetzt am ${showLabel(v)}. ${shiftLine(v, getSettings())}. Keine Minuspunkte.`);
    }
    addLog('Kinobesitzer', 'Vorstellung geändert', `${showLabel(show)} → ${showLabel(v)}`);
    return {};
  },

  cancelShow(id) {
    const show = getShow(id);
    if (!show) throw new UserError('Diese Vorstellung gibt es nicht mehr.', 404);
    if (show.status !== 'active') throw new UserError('Diese Vorstellung ist schon gestrichen.');
    db.prepare(`UPDATE shows SET status = 'cancelled', employee_id = NULL, assigned_at = NULL, short_notice_free = 0,
      version = version + 1, updated_at = ? WHERE id = ?`).run(nowIso(), id);
    if (show.employee_id) {
      addNotice(show.employee_id, `Die Vorstellung ${showLabel(show)} fällt aus. Du musst nicht kommen. Keine Minuspunkte.`);
    }
    const who = show.employee_id ? ` (betroffen: ${employeeName(getEmployee(show.employee_id))})` : '';
    addLog('Kinobesitzer', 'Vorstellung gestrichen', showLabel(show) + who);
    return {};
  },

  restoreShow(id) {
    const show = getShow(id);
    if (!show) throw new UserError('Diese Vorstellung gibt es nicht mehr.', 404);
    if (show.status === 'active') throw new UserError('Diese Vorstellung findet bereits statt.');
    db.prepare(`UPDATE shows SET status = 'active', version = version + 1, updated_at = ? WHERE id = ?`).run(nowIso(), id);
    addLog('Kinobesitzer', 'Vorstellung wieder aufgenommen', showLabel(show));
    return {};
  },

  deleteShow(id) {
    const show = getShow(id);
    if (!show) throw new UserError('Diese Vorstellung gibt es nicht mehr.', 404);
    if (show.employee_id && show.status === 'active') {
      addNotice(show.employee_id, `Die Vorstellung ${showLabel(show)} wurde entfernt. Du musst nicht kommen. Keine Minuspunkte.`);
    }
    db.prepare('DELETE FROM shows WHERE id = ?').run(id);
    addLog('Kinobesitzer', 'Vorstellung gelöscht', showLabel(show));
    return {};
  },

  assign(showId, employeeId) {
    const show = getShow(showId);
    const emp = getEmployee(employeeId);
    if (!show) throw new UserError('Diese Vorstellung gibt es nicht mehr.', 404);
    if (!emp) throw new UserError('Diesen Mitarbeiter gibt es nicht.', 404);
    if (show.status !== 'active') throw new UserError('Diese Vorstellung ist gestrichen.');
    if (emp.blocked) throw new UserError(`${employeeName(emp)} ist gesperrt. Bitte zuerst entsperren.`);
    if (show.employee_id === employeeId) throw new UserError(`${employeeName(emp)} ist hier schon eingetragen.`);
    const s = getSettings();
    if (show.employee_id) {
      addNotice(show.employee_id, `Der Kinobesitzer hat dich aus der Schicht ${showLabel(show)} genommen. Keine Minuspunkte.`);
    }
    db.prepare(`UPDATE shows SET employee_id = ?, assigned_at = ?, short_notice_free = 0, freed_by = NULL,
      version = version + 1, updated_at = ? WHERE id = ?`).run(employeeId, nowIso(), nowIso(), showId);
    addNotice(employeeId, `Der Kinobesitzer hat dich eingetragen: ${showLabel(show)}. ${shiftLine(show, s)}.`);
    addLog('Kinobesitzer', 'Eingetragen', `${employeeName(emp)} → ${showLabel(show)}`);
    return {};
  },

  unassign(showId) {
    const show = getShow(showId);
    if (!show) throw new UserError('Diese Vorstellung gibt es nicht mehr.', 404);
    if (!show.employee_id) throw new UserError('In dieser Schicht ist niemand eingetragen.');
    const emp = getEmployee(show.employee_id);
    db.prepare(`UPDATE shows SET employee_id = NULL, assigned_at = NULL, short_notice_free = 0, freed_by = NULL,
      version = version + 1, updated_at = ? WHERE id = ?`).run(nowIso(), showId);
    addNotice(show.employee_id, `Der Kinobesitzer hat dich aus der Schicht ${showLabel(show)} genommen. Keine Minuspunkte.`);
    addLog('Kinobesitzer', 'Aus Schicht genommen', `${employeeName(emp)} ← ${showLabel(show)} (keine Minuspunkte)`);
    return {};
  },

  setBlocked(employeeId, blocked) {
    const emp = getEmployee(employeeId);
    if (!emp) throw new UserError('Diesen Mitarbeiter gibt es nicht.', 404);
    db.prepare('UPDATE employees SET blocked = ?, version = version + 1 WHERE id = ?').run(blocked ? 1 : 0, employeeId);
    if (blocked) db.prepare('DELETE FROM sessions WHERE employee_id = ?').run(employeeId);
    addLog('Kinobesitzer', blocked ? 'Gesperrt' : 'Entsperrt', employeeName(emp));
    return {};
  },

  setPoints(employeeId, points) {
    const emp = getEmployee(employeeId);
    if (!emp) throw new UserError('Diesen Mitarbeiter gibt es nicht.', 404);
    const p = Number(points);
    if (!Number.isInteger(p) || p < 0 || p > 100000) throw new UserError('Bitte eine ganze Zahl ab 0 eingeben.');
    if (p !== emp.minus_points) {
      db.prepare('UPDATE employees SET minus_points = ?, version = version + 1 WHERE id = ?').run(p, employeeId);
      db.prepare('INSERT INTO karma_events(employee_id, delta, reason, created_at) VALUES(?, ?, ?, ?)')
        .run(employeeId, p - emp.minus_points, 'Vom Kinobesitzer korrigiert', nowIso());
    }
    addLog('Kinobesitzer', 'Punkte geändert', `${employeeName(emp)}: ${emp.minus_points} → ${p}`);
    return {};
  },

  resetPoints(employeeId) {
    const emp = getEmployee(employeeId);
    if (!emp) throw new UserError('Diesen Mitarbeiter gibt es nicht.', 404);
    if (emp.minus_points !== 0) {
      db.prepare('UPDATE employees SET minus_points = 0, version = version + 1 WHERE id = ?').run(employeeId);
      db.prepare('INSERT INTO karma_events(employee_id, delta, reason, created_at) VALUES(?, ?, ?, ?)')
        .run(employeeId, -emp.minus_points, 'Vom Kinobesitzer zurückgesetzt', nowIso());
    }
    addLog('Kinobesitzer', 'Punkte zurückgesetzt', `${employeeName(emp)} (vorher ${emp.minus_points})`);
    return {};
  },
};

/**
 * Führt Änderungen des Kinobesitzers aus und merkt sich den vorherigen Zustand,
 * damit sie später mit einem Klick rückgängig gemacht werden können.
 */
export function runAdminAction(description, { showIds = [], employeeIds = [] }, fn) {
  return tx(() => {
    const uniq = (a) => [...new Set(a.filter((x) => x != null).map(Number))];
    const before = {
      shows: uniq(showIds).map(getShow).filter(Boolean),
      employees: uniq(employeeIds).map(getEmployee).filter(Boolean),
    };
    const result = fn() || {};
    const created = result.createdShowIds || [];
    const after = {
      shows: Object.fromEntries([...uniq(showIds), ...created].map((id) => [id, getShow(id)?.version ?? null])),
      employees: Object.fromEntries(uniq(employeeIds).map((id) => [id, getEmployee(id)?.version ?? null])),
    };
    const info = db.prepare('INSERT INTO admin_actions(created_at, description, undo) VALUES(?, ?, ?)')
      .run(nowIso(), description, JSON.stringify({ before, after, created }));
    return { ...result, actionId: Number(info.lastInsertRowid) };
  });
}

const SHOW_COLS = ['id', 'film', 'date', 'time', 'note', 'status', 'source', 'employee_id', 'assigned_at',
  'short_notice_free', 'freed_by', 'is_demo', 'version', 'created_at', 'updated_at'];

export function undoAdminAction(actionId) {
  return tx(() => {
    const a = db.prepare('SELECT * FROM admin_actions WHERE id = ?').get(actionId);
    if (!a) throw new UserError('Diese Änderung wurde nicht gefunden.', 404);
    if (a.undone) throw new UserError('Diese Änderung wurde schon rückgängig gemacht.');
    const u = JSON.parse(a.undo);
    const conflict = () => new UserError('Inzwischen hat sich hier noch etwas anderes geändert. Rückgängig ist nicht mehr möglich – bitte von Hand korrigieren.', 409);
    for (const [id, ver] of Object.entries(u.after.shows)) {
      if ((getShow(Number(id))?.version ?? null) !== ver) throw conflict();
    }
    for (const [id, ver] of Object.entries(u.after.employees)) {
      if ((getEmployee(Number(id))?.version ?? null) !== ver) throw conflict();
    }
    const beforeIds = new Set(u.before.shows.map((s) => s.id));
    for (const id of u.created) {
      if (beforeIds.has(id)) continue;
      const cur = getShow(id);
      if (cur?.employee_id) addNotice(cur.employee_id, `Die Vorstellung ${showLabel(cur)} wurde entfernt. Keine Minuspunkte.`);
      db.prepare('DELETE FROM shows WHERE id = ?').run(id);
    }
    for (const old of u.before.shows) {
      const cur = getShow(old.id);
      const row = { ...old, version: (cur?.version ?? old.version) + 1, updated_at: nowIso() };
      if (cur) {
        db.prepare(`UPDATE shows SET ${SHOW_COLS.slice(1).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
          .run(...SHOW_COLS.slice(1).map((c) => row[c]), old.id);
      } else {
        db.prepare(`INSERT INTO shows(${SHOW_COLS.join(', ')}) VALUES(${SHOW_COLS.map(() => '?').join(', ')})`)
          .run(...SHOW_COLS.map((c) => row[c]));
      }
      const wasActive = old.status === 'active';
      const curEmp = cur?.status === 'active' ? cur.employee_id : null;
      const oldEmp = wasActive ? old.employee_id : null;
      if (curEmp && curEmp !== oldEmp) addNotice(curEmp, `Änderung zurückgenommen: Du bist nicht mehr eingetragen bei ${showLabel(old)}. Keine Minuspunkte.`);
      if (oldEmp && oldEmp !== curEmp) addNotice(oldEmp, `Änderung zurückgenommen: Du bist wieder eingetragen bei ${showLabel(old)}.`);
      else if (oldEmp && cur && (cur.date !== old.date || cur.time !== old.time)) {
        addNotice(oldEmp, `Geändert: Deine Schicht ist wieder am ${showLabel(old)}.`);
      }
    }
    for (const old of u.before.employees) {
      db.prepare('UPDATE employees SET minus_points = ?, blocked = ?, pin_hash = ?, version = version + 1 WHERE id = ?')
        .run(old.minus_points, old.blocked, old.pin_hash, old.id);
    }
    db.prepare('UPDATE admin_actions SET undone = 1 WHERE id = ?').run(actionId);
    addLog('Kinobesitzer', 'Rückgängig gemacht', a.description);
    return { message: 'Die Änderung wurde rückgängig gemacht.' };
  });
}

// ---------- Mitarbeiter löschen (nicht rückgängig machbar) ----------

export function deleteEmployee(employeeId) {
  return tx(() => {
    const emp = getEmployee(employeeId);
    if (!emp) throw new UserError('Diesen Mitarbeiter gibt es nicht.', 404);
    db.prepare(`UPDATE shows SET employee_id = NULL, assigned_at = NULL, version = version + 1, updated_at = ?
      WHERE employee_id = ?`).run(nowIso(), employeeId);
    db.prepare('DELETE FROM employees WHERE id = ?').run(employeeId);
    addLog('Kinobesitzer', 'Mitarbeiter gelöscht', employeeName(emp));
    return { message: `${employeeName(emp)} wurde gelöscht.` };
  });
}

// ---------- Übersicht für den Kinobesitzer ----------

export function adminOverview() {
  const s = getSettings();
  const today = todayBerlin();
  const names = employeeNames();
  const now = new Date();
  const view = (sh) => shiftView(sh, s, null, now, names);
  const showsOn = (d) => db.prepare('SELECT * FROM shows WHERE date = ? ORDER BY time').all(d).map(view);
  const free = db.prepare(`SELECT * FROM shows WHERE date BETWEEN ? AND ? AND status = 'active' AND employee_id IS NULL ORDER BY date, time`)
    .all(today, addDays(today, CALENDAR_DAYS - 1)).map(view).filter((x) => !x.past);
  const warnings = db.prepare('SELECT * FROM employees WHERE minus_points >= ? AND blocked = 0 ORDER BY minus_points DESC')
    .all(s.karma_warn).map((e) => ({ id: e.id, name: employeeName(e), points: e.minus_points }));
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const recentCancels = db.prepare(`SELECT at, actor, details FROM log WHERE action = 'Absage' AND at >= ? ORDER BY at DESC LIMIT 20`).all(since);
  const pendingImport = db.prepare(`SELECT id, created_at FROM imports WHERE status = 'pending' ORDER BY id DESC LIMIT 1`).get();
  return {
    today: { date: today, label: formatDateShort(today), shifts: showsOn(today) },
    tomorrow: { date: addDays(today, 1), label: formatDateShort(addDays(today, 1)), shifts: showsOn(addDays(today, 1)) },
    free,
    warnings,
    warnAt: s.karma_warn,
    recentCancels,
    pendingImport: pendingImport || null,
    hasUpcomingShows: !!db.prepare(`SELECT 1 FROM shows WHERE date >= ? AND status = 'active'`).get(today),
    hasDemo: !!db.prepare('SELECT 1 FROM employees WHERE is_demo = 1 UNION SELECT 1 FROM shows WHERE is_demo = 1').get(),
  };
}

/** Räumt alte Daten weg, damit nicht mehr gespeichert wird als nötig. */
export function cleanupOldData() {
  const cutoffDate = addDays(todayBerlin(), -60);
  db.prepare('DELETE FROM shows WHERE date < ?').run(cutoffDate);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString();
  db.prepare('DELETE FROM log WHERE at < ?').run(yearAgo);
  db.prepare('DELETE FROM karma_events WHERE created_at < ?').run(yearAgo);
  db.prepare('DELETE FROM notices WHERE created_at < ? AND seen = 1').run(new Date(Date.now() - 30 * 86400000).toISOString());
  db.prepare('DELETE FROM admin_actions WHERE created_at < ?').run(new Date(Date.now() - 30 * 86400000).toISOString());
  db.prepare('DELETE FROM chat_proposals WHERE created_at < ?').run(new Date(Date.now() - 86400000).toISOString());
  db.prepare(`DELETE FROM imports WHERE created_at < ? AND status != 'pending'`).run(new Date(Date.now() - 60 * 86400000).toISOString());
}
