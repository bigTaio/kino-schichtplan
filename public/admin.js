// Admin-Bereich für den Kinobesitzer.
import { $, esc, api, toast, toastError, modal, confirmDialog, busy, ICONS, dayTitle, berlinToday } from './common.js';

const view = $('#view');
const tabsEl = $('#tabs');
const who = $('#who');

const TABS = [
  ['uebersicht', 'Übersicht'],
  ['vorstellungen', 'Vorstellungen'],
  ['mitarbeiter', 'Mitarbeiter'],
  ['assistent', 'Assistent'],
  ['einstellungen', 'Einstellungen'],
  ['protokoll', 'Protokoll'],
];
const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

const state = {
  tab: sessionStorage.getItem('atab') || 'uebersicht',
  chat: JSON.parse(sessionStorage.getItem('achat') || '[]'),
  employees: null,
  showDays: 21,
  aiEnabled: null,
};

function handleError(err) {
  if (err.status === 401) return showLogin();
  toastError(err);
}

/** Änderung ausführen, Meldung zeigen und "Rückgängig" anbieten. */
async function act(promiseFn, { rerender = true } = {}) {
  try {
    const r = await promiseFn();
    toast(r.message || 'Erledigt.', r.actionId ? { action: 'Rückgängig', onAction: () => undo(r.actionId) } : {});
  } catch (err) { handleError(err); }
  if (rerender) await rerenderInPlace();
}

async function undo(id) {
  try {
    const r = await api('POST', `/api/admin/actions/${id}/undo`);
    toast(r.message);
  } catch (err) { handleError(err); }
  await rerenderInPlace();
}

/** Neu zeichnen, ohne dass die Seite nach oben springt. */
async function rerenderInPlace() {
  const y = window.scrollY;
  await render();
  window.scrollTo({ top: y });
}

// ---------- Anmeldung ----------

let needsLogin = false;

function showLogin() {
  needsLogin = true;
  drawnTab = null;
  tabsEl.hidden = true;
  who.innerHTML = '';
  view.innerHTML = `
    <section class="login">
      <div class="hero"><div class="brand-mark" aria-hidden="true">K</div>
        <h1>Verwaltung</h1><p>Nur für den Kinobesitzer.</p></div>
      <form class="card" id="loginForm">
        <label class="field"><span>Admin-Passwort</span>
          <input class="input" name="password" type="password" autocomplete="current-password" required autofocus></label>
        <button class="btn primary block" type="submit">Anmelden</button>
      </form>
      <div class="center" style="margin-top:22px"><a class="btn small ghost" href="/">← Zurück zur Mitarbeiter-Anmeldung</a></div>
    </section>`;
  const form = $('#loginForm');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('button'), async () => {
      try { await api('POST', '/api/admin/login', { password: form.password.value }); start(); } catch (err) { toastError(err); }
    });
  });
}

// ---------- Rahmen ----------

function renderTabs() {
  tabsEl.hidden = false;
  tabsEl.innerHTML = TABS.map(([id, label]) => `<button type="button" data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ''}>${label}</button>`).join('');
  tabsEl.querySelector('[aria-current]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  who.innerHTML = `<a class="btn small ghost" href="/" title="Mitarbeiter-Ansicht">Kalender</a>
    <button class="btn small ghost" id="logout" type="button">Abmelden</button>`;
  $('#logout').onclick = async () => { await api('POST', '/api/admin/logout').catch(() => {}); showLogin(); };
}
tabsEl.addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab); });

function go(tab) {
  state.tab = tab;
  sessionStorage.setItem('atab', tab);
  renderTabs();
  window.scrollTo({ top: 0 });
  render();
}

// Welcher Reiter gerade fertig angezeigt wird. Beim Neuzeichnen desselben Reiters bleibt der
// alte Inhalt stehen, bis die neuen Daten da sind – kein Flackern, kein Springen.
let drawnTab = null;

async function render() {
  const tab = state.tab;
  await ({
    uebersicht: renderOverview, vorstellungen: renderShows, mitarbeiter: renderEmployees,
    assistent: renderChat, einstellungen: renderSettings, protokoll: renderLog,
  })[tab]?.();
  if (state.tab === tab && !needsLogin) drawnTab = tab;
}

const loading = () => { if (drawnTab !== state.tab) view.innerHTML = '<div class="spinner"></div>'; };

function shiftLine(s, { clickable = false } = {}) {
  const status = s.cancelled ? '<span class="chip red">gestrichen</span>'
    : s.assignee ? `<span class="chip ${s.past ? '' : 'gold'}">${esc(s.assignee)}</span>`
      : s.past ? '<span class="chip">nicht besetzt</span>' : '<span class="chip green">frei</span>';
  return `<div class="list-item ${clickable ? 'show-row' : ''}" ${clickable ? `data-show="${s.id}" role="button" tabindex="0"` : ''}>
      <span class="t">${esc(s.time)}</span>
      <div class="grow"><b>${esc(s.film)}</b><div class="sub">Schicht ab ${esc(s.shiftStart)} Uhr${s.note ? ` · ${esc(s.note)}` : ''}${s.source === 'import' ? ' · aus Programm' : ''}</div></div>
      ${status}
    </div>`;
}

// ---------- Übersicht ----------

async function renderOverview() {
  loading();
  let o, actions;
  try { [o, { actions }] = await Promise.all([api('GET', '/api/admin/overview'), api('GET', '/api/admin/actions')]); } catch (err) { return handleError(err); }
  if (state.tab !== 'uebersicht') return;
  const day = (d, title) => `<div class="card"><h2>${title} <span class="muted small">${esc(d.label)}</span></h2>
      ${d.shifts.length ? d.shifts.map((s) => shiftLine(s)).join('') : '<p class="muted" style="margin:0">Keine Vorstellungen.</p>'}</div>`;
  view.innerHTML = `
    <h1 class="page-title">Guten Tag!</h1>
    ${!o.hasUpcomingShows && !o.pendingImport ? `<div class="card gold row" style="justify-content:space-between"><div><b>Noch keine Vorstellungen im Kalender.</b><br><span class="muted">Hol dir das Programm von der Kino-Website.</span></div>
      <button class="btn primary" type="button" data-goto="vorstellungen">Programm holen</button></div>` : ''}
    ${o.pendingImport ? `<div class="card gold row" style="justify-content:space-between"><div><b>Neues Kinoprogramm gefunden.</b><br><span class="muted">Bitte prüfen und bestätigen.</span></div>
      <button class="btn primary" type="button" data-goto="vorstellungen">Ansehen</button></div>` : ''}
    ${o.warnings.map((w) => `<div class="card warn">
      <h2>⚠ ${esc(w.name)} hat ${w.points} Minuspunkte</h2>
      <p class="muted" style="margin:0 0 12px">Die Warnstufe liegt bei ${o.warnAt} Punkten. Du entscheidest, was passiert.</p>
      <div class="row"><button class="btn danger" type="button" data-block="${w.id}">Sperren</button>
        <button class="btn" type="button" data-reset="${w.id}">Punkte auf 0 setzen</button></div></div>`).join('')}
    <div class="kpis">
      <div class="kpi ${o.free.length ? 'green' : ''}"><b>${o.free.length}</b><span>freie Schichten (14 Tage)</span></div>
      <div class="kpi ${o.warnings.length ? 'red' : ''}"><b>${o.warnings.length}</b><span>Warnungen</span></div>
      <div class="kpi gold"><b>${o.recentCancels.length}</b><span>Absagen (7 Tage)</span></div>
    </div>
    <div class="grid2">${day(o.today, 'Heute')}${day(o.tomorrow, 'Morgen')}</div>
    <div class="grid2">
      <div class="card"><h2>Freie Schichten</h2>
        ${o.free.length ? o.free.slice(0, 12).map((s) => `<div class="list-item"><span class="t">${esc(s.time)}</span>
          <div class="grow"><b>${esc(s.film)}</b><div class="sub">${esc(dateLabel(s.date))}</div></div>
          <button class="btn small" type="button" data-assign="${s.id}">Eintragen …</button></div>`).join('')
          + (o.free.length > 12 ? `<p class="muted small">… und ${o.free.length - 12} weitere.</p>` : '')
          : '<p class="muted" style="margin:0">Alle Schichten sind besetzt. 🎉</p>'}
      </div>
      <div class="card"><h2>Letzte Absagen</h2>
        ${o.recentCancels.length ? o.recentCancels.map((c) => `<div class="log-entry"><b>${esc(c.actor)}</b>: ${esc(c.details)}<div class="when">${esc(fmt(c.at))}</div></div>`).join('')
          : '<p class="muted" style="margin:0">Keine Absagen in den letzten 7 Tagen.</p>'}
      </div>
    </div>
    ${undoCard(actions)}
    ${o.hasDemo ? `<div class="card"><h2>Beispieldaten</h2><p class="muted">Zum Ausprobieren sind erfundene Mitarbeiter angelegt (z. B. Anna Berger). Vor dem echten Start bitte löschen.</p>
      <button class="btn danger" type="button" id="delDemo">Beispieldaten löschen</button></div>` : ''}`;
  $('#delDemo')?.addEventListener('click', async () => {
    if (await confirmDialog({ title: 'Beispieldaten löschen?', text: 'Die erfundenen Beispiel-Mitarbeiter werden entfernt. Vorstellungen und echte Mitarbeiter bleiben.', yes: 'Ja, löschen', danger: true })) {
      act(() => api('POST', '/api/admin/demo/remove'));
    }
  });
}

function undoCard(actions) {
  const open = (actions || []).filter((a) => !a.undone).slice(0, 6);
  if (!open.length) return '';
  return `<div class="card"><h2>Letzte Änderungen</h2>
    ${open.map((a) => `<div class="list-item"><div class="grow">${esc(a.description)}<div class="sub">${esc(a.when)}</div></div>
      <button class="btn small" type="button" data-undo="${a.id}">Rückgängig</button></div>`).join('')}</div>`;
}

function dateLabel(d) {
  const [y, m, day] = d.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  return `${WEEKDAYS[wd].slice(0, 2)}. ${String(day).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
}
function fmt(iso) {
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) + ' Uhr';
}

// ---------- Vorstellungen ----------

let showsCache = [];

async function renderShows() {
  loading();
  let data, imp;
  try { [data, imp] = await Promise.all([api('GET', `/api/admin/shows?days=${state.showDays}`), api('GET', '/api/admin/import')]); } catch (err) { return handleError(err); }
  if (state.tab !== 'vorstellungen') return;
  showsCache = data.days.flatMap((d) => d.shifts);
  const today = berlinToday(); const tomorrow = berlinToday(1);
  view.innerHTML = `
    <h1 class="page-title">Vorstellungen</h1>
    ${importCard(imp)}
    <button class="btn primary block" type="button" id="addShow" style="margin-bottom:14px">+ Vorstellung von Hand hinzufügen</button>
    <p class="muted small" style="margin:0 2px 12px">Tippe auf eine Vorstellung, um sie zu ändern, zu streichen oder jemanden einzutragen.</p>
    ${data.days.map((d) => `<div class="card"><h2>${dayTitle(d, today, tomorrow)} <span class="muted small">${esc(d.label)}</span></h2>
      ${d.shifts.length ? d.shifts.map((s) => shiftLine(s, { clickable: true })).join('') : '<p class="muted" style="margin:0">Keine Vorstellungen.</p>'}</div>`).join('')}
    ${state.showDays < 90 ? '<button class="btn block" type="button" id="moreDays">Weitere 3 Wochen anzeigen</button>' : ''}`;
  $('#addShow').addEventListener('click', () => showForm());
  $('#moreDays')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    state.showDays = Math.min(state.showDays + 21, 90);
    await rerenderInPlace();
  }));
  bindImport(imp);
}

function importCard(imp) {
  const l = imp.latest;
  let body = '';
  if (l?.status === 'pending') {
    const affected = [...l.changed, ...l.removed].filter((x) => x.assignee);
    body = `
      <p style="font-size:19px;margin:0 0 10px"><b>Neu: ${l.added.length} · geändert: ${l.changed.length} · entfallen: ${l.removed.length}</b></p>
      ${affected.length ? `<div class="card warn" style="margin:0 0 12px;padding:12px"><b>⚠ Achtung, hier sind schon Leute eingetragen:</b>
        <ul class="diff-list">${affected.map((x) => `<li class="affected">${esc(x.assignee)}: ${esc(dateLabel(x.from?.date || x.date))}, ${esc(x.from?.time || x.time)} Uhr „${esc(x.from?.film || x.film)}“</li>`).join('')}</ul>
        <span class="small">Diese Personen werden informiert und bekommen keine Minuspunkte.</span></div>` : ''}
      ${l.added.length ? `<details class="more"><summary>Neue Vorstellungen (${l.added.length})</summary><ul class="diff-list">${l.added.map((a) => `<li>${esc(dateLabel(a.date))}, ${esc(a.time)} Uhr – ${esc(a.film)}${a.note ? ` (${esc(a.note)})` : ''}</li>`).join('')}</ul></details>` : ''}
      ${l.changed.length ? `<details class="more" open><summary>Geändert (${l.changed.length})</summary><ul class="diff-list">${l.changed.map((c) => `<li>${esc(dateLabel(c.from.date))} ${esc(c.from.time)} „${esc(c.from.film)}“ → <b>${esc(dateLabel(c.to.date))} ${esc(c.to.time)} „${esc(c.to.film)}“</b></li>`).join('')}</ul></details>` : ''}
      ${l.removed.length ? `<details class="more" open><summary>Entfallen (${l.removed.length})</summary><ul class="diff-list">${l.removed.map((r) => `<li>${esc(dateLabel(r.date))}, ${esc(r.time)} Uhr – ${esc(r.film)}</li>`).join('')}</ul></details>` : ''}
      <div class="row" style="margin-top:12px"><button class="btn primary" type="button" id="applyImport">Übernehmen</button>
        <button class="btn ghost" type="button" id="discardImport">Verwerfen</button></div>`;
  } else if (l) {
    const txt = l.status === 'failed' ? `Letzter Versuch hat nicht geklappt: ${esc(l.message)}`
      : l.status === 'nochange' ? 'Zuletzt geprüft: alles aktuell.' : l.status === 'applied' ? `Zuletzt übernommen: ${esc(l.message)}` : 'Zuletzt geprüft.';
    body = `<p class="muted" style="margin:0">${txt}<br><span class="small">${esc(fmt(l.created_at))}</span></p>`;
  } else {
    body = '<p class="muted" style="margin:0">Noch nie abgeglichen.</p>';
  }
  return `<div class="card ${l?.status === 'pending' ? 'gold' : ''}"><div class="row" style="justify-content:space-between;margin-bottom:10px">
      <h2 style="margin:0">Programm der Kino-Website</h2>
      <button class="btn" type="button" id="runImport">Programm aktualisieren</button></div>${body}
      <p class="muted small" style="margin:10px 0 0">Neue Vorstellungen werden erst nach deiner Bestätigung übernommen. Von Hand eintragen geht immer.</p></div>`;
}

function bindImport(imp) {
  $('#runImport')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    toast('Das Programm wird gelesen …', { ms: 4000 });
    try { const r = await api('POST', '/api/admin/import/run'); toast(r.message); } catch (err) { handleError(err); }
    renderShows();
  }));
  $('#applyImport')?.addEventListener('click', (e) => busy(e.currentTarget, () => act(() => api('POST', `/api/admin/import/${imp.latest.id}/apply`))));
  $('#discardImport')?.addEventListener('click', () => act(() => api('POST', `/api/admin/import/${imp.latest.id}/discard`)));
}

async function showForm(s = null) {
  await modal(`
    <h2>${s ? 'Vorstellung ändern' : 'Neue Vorstellung'}</h2>
    <form id="showForm">
      <label class="field"><span>Film</span><input class="input" name="film" required maxlength="120" value="${esc(s?.film || '')}"></label>
      <div class="name-row">
        <label class="field"><span>Datum</span><input class="input" type="date" name="date" required value="${esc(s?.date || berlinToday())}"></label>
        <label class="field"><span>Uhrzeit</span><input class="input" type="time" name="time" required step="300" value="${esc(s?.time || '20:00')}"></label>
      </div>
      <label class="field"><span>Hinweis (freiwillig)</span><input class="input" name="note" maxlength="80" placeholder="z. B. Premiere, Kinderkino" value="${esc(s?.note || '')}"></label>
      ${s?.assignee ? `<p class="muted small">${esc(s.assignee)} ist eingetragen und wird über Änderungen informiert (keine Minuspunkte).</p>` : ''}
      <div class="actions"><button class="btn primary block" type="submit">Speichern</button>
        <button class="btn ghost block" type="button" data-close="">Abbrechen</button></div>
    </form>`, {
    onOpen(el, close) {
      el.querySelector('#showForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(e.target));
        busy(e.target.querySelector('[type=submit]'), async () => {
          try {
            const r = s ? await api('PUT', `/api/admin/shows/${s.id}`, body) : await api('POST', '/api/admin/shows', body);
            close();
            toast(r.message, { action: 'Rückgängig', onAction: () => undo(r.actionId) });
            rerenderInPlace();
          } catch (err) { handleError(err); }
        });
      });
    },
  });
}

async function showSheet(id) {
  const s = showsCache.find((x) => x.id === id);
  if (!s) return;
  const choice = await modal(`
    <h2>${esc(s.film)}</h2>
    <p class="muted" style="margin:0">${esc(dateLabel(s.date))}, ${esc(s.time)} Uhr · Schicht ab ${esc(s.shiftStart)} Uhr<br>
      ${s.cancelled ? 'Gestrichen' : s.assignee ? `Eingetragen: <b>${esc(s.assignee)}</b>` : 'Noch frei'}</p>
    <div class="actions">
      ${s.cancelled ? '<button class="btn primary block" data-close="restore">Findet doch statt</button>' : `
        <button class="btn primary block" data-close="assign">${s.assignee ? 'Andere Person eintragen' : 'Jemanden eintragen'}</button>
        ${s.assignee ? '<button class="btn block" data-close="unassign">Person austragen (keine Minuspunkte)</button>' : ''}
        <button class="btn block" data-close="edit">Film, Datum oder Uhrzeit ändern</button>
        <button class="btn danger block" data-close="cancel">Vorstellung streichen (fällt aus)</button>`}
      <button class="btn ghost block" data-close="delete">Ganz löschen (z. B. Tippfehler)</button>
      <button class="btn ghost block" data-close="">Schließen</button>
    </div>`);
  if (choice === 'edit') return showForm(s);
  if (choice === 'assign') return assignDialog(s.id);
  if (choice === 'unassign') return act(() => api('POST', `/api/admin/shows/${s.id}/unassign`));
  if (choice === 'restore') return act(() => api('POST', `/api/admin/shows/${s.id}/restore`));
  if (choice === 'cancel') {
    if (await confirmDialog({ title: 'Vorstellung streichen?', text: s.assignee ? `${esc(s.assignee)} wird informiert und bekommt keine Minuspunkte.` : 'Die Vorstellung wird im Kalender als „fällt aus“ angezeigt.', yes: 'Ja, streichen', danger: true })) {
      act(() => api('POST', `/api/admin/shows/${s.id}/cancel`));
    }
  }
  if (choice === 'delete') {
    if (await confirmDialog({ title: 'Vorstellung ganz löschen?', text: 'Sie verschwindet komplett aus dem Kalender. Für ausfallende Vorstellungen besser „streichen“ nehmen.', yes: 'Ja, löschen', danger: true })) {
      act(() => api('DELETE', `/api/admin/shows/${s.id}`));
    }
  }
}

async function assignDialog(showId) {
  let list;
  try { list = (await api('GET', '/api/admin/employees')).employees.filter((e) => !e.blocked); } catch (err) { return handleError(err); }
  if (!list.length) return toast('Es gibt noch keine Mitarbeiter. Sie erscheinen nach ihrer ersten Anmeldung.', { type: 'err' });
  const choice = await modal(`
    <h2>Wen eintragen?</h2>
    <div class="actions">${list.map((e) => `<button class="btn block" data-close="${e.id}">${esc(e.name)}</button>`).join('')}
      <button class="btn ghost block" data-close="">Abbrechen</button></div>`);
  if (choice) act(() => api('POST', `/api/admin/shows/${showId}/assign`, { employeeId: Number(choice) }));
}

// ---------- Mitarbeiter ----------

async function renderEmployees() {
  loading();
  let data;
  try { data = await api('GET', '/api/admin/employees'); } catch (err) { return handleError(err); }
  if (state.tab !== 'mitarbeiter') return;
  view.innerHTML = `
    <h1 class="page-title">Mitarbeiter</h1>
    <p class="page-sub">Neue Mitarbeiter erscheinen hier, sobald sie sich zum ersten Mal mit dem Kino-Passwort angemeldet haben.</p>
    ${data.employees.length ? data.employees.map((e) => `
      <div class="card ${e.warn && !e.blocked ? 'warn' : ''}">
        <div class="row" style="justify-content:space-between">
          <div><h2 style="margin:0">${esc(e.name)}</h2>
            <span class="muted small">${e.upcoming} kommende Schicht${e.upcoming === 1 ? '' : 'en'}${e.demo ? ' · Beispiel' : ''}</span></div>
          <div class="row">${e.blocked ? '<span class="chip red">gesperrt</span>' : ''}
            <span class="chip ${e.points === 0 ? 'green' : e.warn ? 'red' : 'gold'}">${e.points} Minuspunkte</span></div>
        </div>
        ${e.warn && !e.blocked ? `<p style="margin:10px 0 0"><b>⚠ Warnstufe erreicht (ab ${data.warnAt} Punkten).</b></p>` : ''}
        <div class="row" style="margin-top:12px">
          ${e.blocked ? `<button class="btn small" type="button" data-unblock="${e.id}">Entsperren</button>` : `<button class="btn small danger" type="button" data-block="${e.id}">Sperren</button>`}
          <button class="btn small" type="button" data-points="${e.id}" data-current="${e.points}" data-name="${esc(e.name)}">Punkte ändern</button>
          <button class="btn small" type="button" data-reset="${e.id}" ${e.points === 0 ? 'disabled' : ''}>Punkte auf 0</button>
          <button class="btn small ghost" type="button" data-delemp="${e.id}" data-name="${esc(e.name)}">Löschen</button>
        </div>
      </div>`).join('') : '<div class="card empty"><span class="big">👋</span>Noch niemand angemeldet.</div>'}`;
}

// ---------- Einstellungen ----------

async function renderSettings() {
  loading();
  let s, aiEnabled;
  try { ({ settings: s, aiEnabled } = await api('GET', '/api/admin/settings')); } catch (err) { return handleError(err); }
  if (state.tab !== 'einstellungen') return;
  const num = (name, min, max) => `<input class="input num" type="number" inputmode="numeric" name="${name}" min="${min}" max="${max}" value="${s[name]}">`;
  view.innerHTML = `
    <h1 class="page-title">Einstellungen</h1>
    <form id="settingsForm">
      <div class="card"><h2>Schichtbeginn</h2>
        <div class="setting-line"><span>Die Schicht beginnt so viele Minuten vor dem Film:</span>${num('shift_minutes_before', 0, 240)}</div>
      </div>
      <div class="card"><h2>Ab wann darf man sich eintragen?</h2>
        <label class="check"><input type="checkbox" name="release_enabled" ${s.release_enabled ? 'checked' : ''}> Erst ab einem festen Zeitpunkt (sonst jederzeit)</label>
        <div id="releaseBox" class="name-row" style="margin-top:8px">
          <label class="field"><span>Wochentag</span><select class="input" name="release_weekday">${WEEKDAYS.map((w, i) => `<option value="${i}" ${i === s.release_weekday ? 'selected' : ''}>${w}</option>`).join('')}</select></label>
          <label class="field"><span>Uhrzeit</span><input class="input" type="time" name="release_time" value="${esc(s.release_time)}"></label>
        </div>
        <p class="muted" id="releasePreview" style="margin:0"></p>
      </div>
      <div class="card"><h2>Minuspunkte beim Absagen</h2>
        <div class="setting-line"><span>Mehr als ${num('karma_far_days', 1, 60)} Tage vorher</span>${num('karma_far', 0, 500)}</div>
        <div class="setting-line"><span>Zwischen <b data-near>${s.karma_near_days}</b> und <b data-far>${s.karma_far_days}</b> Tagen vorher</span>${num('karma_mid', 0, 500)}</div>
        <div class="setting-line"><span>Weniger als ${num('karma_near_days', 1, 60)} Tage vorher</span>${num('karma_near', 0, 500)}</div>
        <div class="setting-line"><span>Am selben Tag</span>${num('karma_same_day', 0, 500)}</div>
        <div class="setting-line"><span>Bonus: so viele Punkte zurück, wenn jemand eine kurzfristig frei gewordene Schicht übernimmt</span>${num('karma_bonus', 0, 500)}</div>
        <div class="setting-line"><span>Warnung an mich ab so vielen Minuspunkten</span>${num('karma_warn', 1, 5000)}</div>
      </div>
      <div class="card"><h2>Programm-Import</h2>
        ${aiEnabled ? '' : '<p class="muted">Hinweis: Ohne KI-Schlüssel ist der Import ausgeschaltet.</p>'}
        <label class="check"><input type="checkbox" name="import_auto" ${s.import_auto ? 'checked' : ''}> Einmal täglich automatisch nach neuen Vorstellungen suchen</label>
        <details class="more"><summary>Adressen der Kino-Website</summary>
          <label class="field"><span>Programmseite</span><input class="input" name="import_url" value="${esc(s.import_url)}"></label>
          <label class="field"><span>Programm als PDF (Ersatz)</span><input class="input" name="import_pdf_url" value="${esc(s.import_pdf_url)}"></label>
        </details>
      </div>
      <button class="btn primary block" type="submit" style="margin-bottom:24px">Einstellungen speichern</button>
    </form>

    <div class="card"><h2>Kino-Passwort für Mitarbeiter</h2>
      <form id="sharedPw">
        <label class="field"><span>Neues Kino-Passwort</span><input class="input" name="password" type="text" autocomplete="off" minlength="4" required></label>
        <label class="check"><input type="checkbox" name="logoutAll"> Alle Mitarbeiter abmelden (sie müssen das neue Passwort eingeben)</label>
        <button class="btn block" type="submit" style="margin-top:10px">Kino-Passwort ändern</button>
      </form>
    </div>
    <div class="card"><h2>Datensicherung</h2>
      <p class="muted" style="margin-top:0">Lädt eine Kopie aller Daten (Vorstellungen, Schichten, Mitarbeiter, Punkte, Protokoll) auf dieses Gerät. Am besten einmal pro Woche.</p>
      <a class="btn block" href="/api/admin/backup" download>Sicherung herunterladen</a>
    </div>
    <div class="card"><h2>Mein Admin-Passwort</h2>
      <form id="adminPw">
        <label class="field"><span>Neues Admin-Passwort (mindestens 8 Zeichen)</span><input class="input" name="password" type="password" autocomplete="new-password" minlength="8" required></label>
        <button class="btn block" type="submit">Admin-Passwort ändern</button>
      </form>
    </div>`;

  const form = $('#settingsForm');
  const preview = () => {
    const on = form.release_enabled.checked;
    $('#releaseBox').hidden = !on;
    $('#releasePreview').textContent = on
      ? `Jeden ${WEEKDAYS[form.release_weekday.value]} um ${form.release_time.value || '–'} Uhr wird die folgende Woche (Montag bis Sonntag) zum Eintragen freigegeben.`
      : 'Alle Schichten können jederzeit eingetragen werden.';
    view.querySelector('[data-near]').textContent = form.karma_near_days.value;
    view.querySelector('[data-far]').textContent = form.karma_far_days.value;
  };
  form.addEventListener('input', preview);
  preview();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {};
    for (const [k, v] of fd) body[k] = ['release_time', 'import_url', 'import_pdf_url'].includes(k) ? v : Number(v);
    body.release_enabled = form.release_enabled.checked;
    body.import_auto = form.import_auto.checked;
    busy(form.querySelector('[type=submit]'), async () => {
      try { const r = await api('PUT', '/api/admin/settings', body); toast(r.message); } catch (err) { handleError(err); }
    });
  });
  for (const [id, kind] of [['#sharedPw', 'shared'], ['#adminPw', 'admin']]) {
    const f = $(id);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(f.querySelector('[type=submit]'), async () => {
        try {
          const r = await api('POST', '/api/admin/password', { kind, password: f.password.value, logoutAll: f.logoutAll?.checked });
          toast(r.message); f.reset();
        } catch (err) { handleError(err); }
      });
    });
  }
}

// ---------- Protokoll ----------

async function renderLog(q = '') {
  loading();
  let log, actions;
  try {
    [log, { actions }] = await Promise.all([api('GET', `/api/admin/log?q=${encodeURIComponent(q)}`), api('GET', '/api/admin/actions')]);
  } catch (err) { return handleError(err); }
  if (state.tab !== 'protokoll') return;
  view.innerHTML = `
    <h1 class="page-title">Protokoll</h1>
    <p class="page-sub">Hier steht alles, was passiert ist – mit Zeit und Namen.</p>
    ${undoCard(actions)}
    <form id="logSearch" class="row" style="margin-bottom:12px"><input class="input" name="q" placeholder="Suchen, z. B. einen Namen" value="${esc(q)}" style="flex:1"><button class="btn" type="submit">Suchen</button></form>
    <div class="card">${log.entries.length ? log.entries.map((e) => `<div class="log-entry"><div class="when">${esc(e.when)} · ${esc(e.actor)}</div>
      <b>${esc(e.action)}</b>${e.details ? `: ${esc(e.details)}` : ''}</div>`).join('') : '<p class="muted" style="margin:0">Keine Einträge.</p>'}</div>`;
  $('#logSearch').addEventListener('submit', (e) => { e.preventDefault(); renderLog(e.target.q.value.trim()); });
}

// ---------- Assistent ----------

const ADMIN_SUGGESTIONS = ['Morgen fällt der Film um 20 Uhr aus.', 'Trag Anna am Samstag um 20:15 Uhr ein.', 'Welche Schichten sind diese Woche noch frei?'];

async function renderChat() {
  if (state.aiEnabled === null) {
    try { state.aiEnabled = (await api('GET', '/api/admin/settings')).aiEnabled; } catch (err) { return handleError(err); }
    if (state.tab !== 'assistent') return;
  }
  const on = state.aiEnabled;
  view.innerHTML = `
    <h1 class="page-title">Assistent</h1>
    <p class="page-sub">Schreib einfach, was du ändern möchtest. Ich zeige dir vorher genau, was passiert – erst nach „Ja, so machen“ wird etwas geändert.</p>
    ${on ? '' : '<div class="card gold"><b>Der Assistent ist noch nicht eingerichtet.</b><br><span class="muted">Dafür fehlt der KI-Schlüssel (siehe Anleitung, Schritt 6). Alles andere kannst du über die Reiter „Vorstellungen“ und „Mitarbeiter“ erledigen.</span></div>'}
    <div class="chat">
      <div class="chat-log" id="chatLog"></div>
      ${state.chat.length || !on ? '' : `<div class="suggest">${ADMIN_SUGGESTIONS.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`}
      <form class="chat-form admin" id="chatForm">
        <input class="input" name="q" placeholder="z. B. Streich Max am Freitag um 18 Uhr" autocomplete="off" maxlength="600" ${on ? '' : 'disabled'}>
        <button class="btn primary" type="submit" aria-label="Senden" ${on ? '' : 'disabled'}>${ICONS.send}</button>
      </form>
    </div>`;
  drawChat();
  view.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.q)));
  $('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); ask(e.target.q.value); });
}

function drawChat(pending = false) {
  const log = $('#chatLog');
  if (!log) return;
  log.innerHTML = state.chat.map((m, i) => {
    if (m.role === 'user') return `<div class="bubble user">${esc(m.text)}</div>`;
    let extra = '';
    if (m.summary) {
      extra = `<div class="proposal"><ul>${m.summary.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        ${m.done ? `<div class="row"><span class="chip green">✓ Erledigt</span>${m.actionId && !m.undone ? `<button class="btn small" type="button" data-chatundo="${i}">Rückgängig</button>` : ''}${m.undone ? '<span class="chip">rückgängig gemacht</span>' : ''}</div>`
          : m.declined ? '<span class="chip">Nicht ausgeführt</span>'
            : `<div class="row"><button class="btn primary" type="button" data-yes="${i}">Ja, so machen</button><button class="btn ghost" type="button" data-no="${i}">Nein</button></div>`}
      </div>`;
    }
    return `<div class="bubble bot${m.error ? ' error' : ''}">${esc(m.text)}${extra}</div>`;
  }).join('') + (pending ? '<div class="bubble bot"><span class="typing"><i></i><i></i><i></i></span></div>' : '');
  log.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

function saveChat() {
  state.chat = state.chat.slice(-30);
  sessionStorage.setItem('achat', JSON.stringify(state.chat));
}

let asking = false;
async function ask(text) {
  const q = text.trim();
  if (!q || asking) return;
  asking = true;
  const history = state.chat.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.summary ? `${m.text}\n${m.summary.join('\n')}${m.done ? '\n(ausgeführt)' : m.declined ? '\n(abgelehnt)' : ''}` : m.text }));
  state.chat.push({ role: 'user', text: q });
  $('.suggest')?.remove();
  $('#chatForm').q.value = '';
  drawChat(true);
  try {
    const r = await api('POST', '/api/admin/chat', { history, question: q });
    state.chat.push({ role: 'assistant', text: r.message, summary: r.summary, proposalId: r.proposalId });
  } catch (err) {
    if (err.status === 401) { asking = false; return showLogin(); }
    state.chat.push({ role: 'assistant', text: err.message, error: true });
  }
  asking = false;
  saveChat();
  drawChat();
}

view.addEventListener('click', async (e) => {
  const t = e.target;
  const goto = t.closest('[data-goto]');
  if (goto) return go(goto.dataset.goto);
  const showRow = t.closest('[data-show]');
  if (showRow) return showSheet(Number(showRow.dataset.show));
  const assign = t.closest('[data-assign]');
  if (assign) return assignDialog(Number(assign.dataset.assign));
  const undoBtn = t.closest('[data-undo]');
  if (undoBtn) return busy(undoBtn, () => undo(Number(undoBtn.dataset.undo)));

  const block = t.closest('[data-block]');
  if (block) {
    if (await confirmDialog({ title: 'Mitarbeiter sperren?', text: 'Die Person kann sich nicht mehr anmelden und nicht mehr eintragen. Bereits eingetragene Schichten bleiben bestehen.', yes: 'Ja, sperren', danger: true })) {
      act(() => api('POST', `/api/admin/employees/${block.dataset.block}/block`));
    }
    return;
  }
  const unblock = t.closest('[data-unblock]');
  if (unblock) return act(() => api('POST', `/api/admin/employees/${unblock.dataset.unblock}/unblock`));
  const reset = t.closest('[data-reset]');
  if (reset) return act(() => api('POST', `/api/admin/employees/${reset.dataset.reset}/reset-points`));
  const pts = t.closest('[data-points]');
  if (pts) {
    await modal(`
      <h2>Punkte von ${esc(pts.dataset.name)}</h2>
      <form id="pointsForm">
        <label class="field"><span>Neuer Punktestand</span>
          <input class="input" name="points" type="number" inputmode="numeric" min="0" step="1" value="${esc(pts.dataset.current)}" required></label>
        <div class="actions"><button class="btn primary block" type="submit">Speichern</button>
          <button class="btn ghost block" type="button" data-close="">Abbrechen</button></div>
      </form>`, {
      onOpen(el, close) {
        el.querySelector('#pointsForm').addEventListener('submit', (e) => {
          e.preventDefault();
          const points = Number(e.target.points.value);
          close();
          act(() => api('POST', `/api/admin/employees/${pts.dataset.points}/points`, { points }));
        });
      },
    });
    return;
  }
  const del = t.closest('[data-delemp]');
  if (del) {
    if (await confirmDialog({ title: `${esc(del.dataset.name)} löschen?`, text: 'Der Name wird entfernt, kommende Schichten werden frei. Das kann nicht rückgängig gemacht werden. Im Protokoll bleibt der Name stehen.', yes: 'Endgültig löschen', danger: true })) {
      act(() => api('DELETE', `/api/admin/employees/${del.dataset.delemp}`));
    }
    return;
  }

  const yes = t.closest('[data-yes]');
  if (yes) {
    const m = state.chat[Number(yes.dataset.yes)];
    return busy(yes, async () => {
      try {
        const r = await api('POST', '/api/admin/chat/confirm', { proposalId: m.proposalId });
        m.done = true; m.actionId = r.actionId;
        toast('Erledigt.');
      } catch (err) { handleError(err); }
      saveChat(); drawChat();
    });
  }
  const no = t.closest('[data-no]');
  if (no) { state.chat[Number(no.dataset.no)].declined = true; saveChat(); drawChat(); return; }
  const cu = t.closest('[data-chatundo]');
  if (cu) {
    const m = state.chat[Number(cu.dataset.chatundo)];
    return busy(cu, async () => {
      try { const r = await api('POST', `/api/admin/actions/${m.actionId}/undo`); m.undone = true; toast(r.message); } catch (err) { handleError(err); }
      saveChat(); drawChat();
    });
  }
});
view.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-show]')) showSheet(Number(e.target.dataset.show));
});

// ---------- Start ----------

async function start() {
  // Direkt den Reiter laden (spart eine Anfrage). Nicht angemeldet → die Anfrage meldet 401 → Anmeldung.
  needsLogin = false;
  await render();
  if (!needsLogin) renderTabs();
}

start();
