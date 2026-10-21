// Mitarbeiter-Seite: Anmeldung, Kalender, Meine Schichten, Assistent, Punkte.
import { $, esc, api, toast, toastError, confirmDialog, busy, ICONS, dayTitle, berlinToday } from './common.js';

const view = $('#view');
const tabbar = $('#tabbar');
const who = $('#who');

const TABS = [
  { id: 'kalender', label: 'Kalender', icon: ICONS.calendar },
  { id: 'meine', label: 'Meine Schichten', icon: ICONS.mine },
  { id: 'assistent', label: 'Assistent', icon: ICONS.chat },
  { id: 'punkte', label: 'Punkte', icon: ICONS.star },
];

const state = {
  tab: sessionStorage.getItem('tab') || 'kalender',
  onlyFree: false,
  cal: null,
  chat: JSON.parse(sessionStorage.getItem('chat') || '[]'),
};

// Das Gerät merkt sich nur den Namen (nicht das Passwort), um das Anmelden zu erleichtern.
const remembered = () => { try { return JSON.parse(localStorage.getItem('kino_name')); } catch { return null; } };

function handleError(err) {
  if (err.status === 401) return showLogin();
  toastError(err);
}

// ---------- Anmeldung ----------

function showLogin(forgetName = false) {
  if (forgetName) localStorage.removeItem('kino_name');
  // Nichts von der vorherigen Person im Speicher lassen (geteilte Geräte).
  state.cal = null;
  state.my = null;
  state.chat = [];
  sessionStorage.removeItem('chat');
  tabbar.hidden = true;
  who.innerHTML = '';
  const known = remembered();
  view.innerHTML = `
    <section class="login">
      <div class="hero">
        <div class="brand-mark" aria-hidden="true">K</div>
        <h1>${known ? `Hallo ${esc(known.first)}!` : 'Willkommen!'}</h1>
        <p>${known ? 'Schön, dass du wieder da bist.' : 'Hier trägst du dich für deine Schichten im Kino ein.'}</p>
      </div>
      <form class="card" id="loginForm" novalidate>
        <div class="name-row" ${known ? 'hidden' : ''}>
          <label class="field"><span>Vorname</span>
            <input class="input" name="firstName" autocomplete="given-name" required value="${esc(known?.first || '')}"></label>
          <label class="field"><span>Nachname</span>
            <input class="input" name="lastName" autocomplete="family-name" required value="${esc(known?.last || '')}"></label>
        </div>
        <label class="field"><span>Kino-Passwort</span>
          <input class="input" name="password" type="password" autocomplete="current-password" required>
          <small>Das gemeinsame Passwort bekommst du vom Kinobesitzer.</small></label>
        <button class="btn primary block" type="submit">Anmelden</button>
        ${known ? `<p class="center small" style="margin:14px 0 0"><a href="#" id="notMe">Ich bin nicht ${esc(known.first)}</a></p>` : ''}
      </form>
      <div class="center" style="margin-top:22px">
        <a class="btn small ghost" href="/admin">🔑 Kinobesitzer</a>
      </div>
    </section>`;
  $('#notMe')?.addEventListener('click', (e) => { e.preventDefault(); showLogin(true); });
  const form = $('#loginForm');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!data.firstName?.trim() || !data.lastName?.trim()) return toast('Bitte gib deinen Vor- und Nachnamen ein.', { type: 'err' });
    if (!data.password) return toast('Bitte gib das Kino-Passwort ein.', { type: 'err' });
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        const r = await api('POST', '/api/login', data);
        localStorage.setItem('kino_name', JSON.stringify({ first: r.firstName, last: r.lastName }));
        toast(r.isNew ? `Willkommen im Team, ${r.firstName}!` : `Hallo ${r.firstName}!`);
        start();
      } catch (err) { toastError(err); }
    });
  });
}

// ---------- Rahmen ----------

function renderTabs() {
  tabbar.hidden = false;
  tabbar.innerHTML = TABS.map((t) => `<button type="button" data-tab="${t.id}" ${state.tab === t.id ? 'aria-current="page"' : ''}>${t.icon}<span>${t.label}</span></button>`).join('');
}
tabbar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) go(b.dataset.tab);
});

function go(tab) {
  state.tab = tab;
  sessionStorage.setItem('tab', tab);
  renderTabs();
  window.scrollTo({ top: 0 });
  render();
}

function renderWho() {
  if (!state.cal) return;
  const { points: p, warnAt } = state.cal.me;
  // Farbe relativ zur Warnstufe, damit sie bei jeder Punkte-Skala passt
  who.innerHTML = `<span class="chip ${p === 0 ? 'green' : p >= warnAt / 2 ? 'red' : 'gold'} points-chip" title="Deine Minuspunkte">${p} Pkt.</span>
    <button class="btn small ghost" id="logout" type="button">Abmelden</button>`;
  who.querySelector('.points-chip').onclick = () => go('punkte');
  $('#logout').onclick = async () => {
    if (!(await confirmDialog({ title: 'Abmelden?', text: 'Du musst dich danach mit Namen und Kino-Passwort neu anmelden.', yes: 'Abmelden' }))) return;
    await api('POST', '/api/logout').catch(() => {});
    showLogin();
  };
}

async function loadCalendar(quiet = false) {
  state.cal = await api('GET', '/api/calendar', undefined, { quiet });
  renderWho();
  return state.cal;
}

function render() {
  ({ kalender: renderCalendar, meine: renderMine, assistent: renderChat, punkte: renderPoints })[state.tab]?.();
}

// ---------- Hinweise ----------

function noticesHtml(cal) {
  if (!cal.notices.length) return '';
  return `<div id="notices">${cal.notices.map((n) => `
      <div class="notice"><span class="ic" aria-hidden="true">🔔</span>
        <div><p>${esc(n.text)}</p><span class="small muted">${esc(n.when)}</span></div></div>`).join('')}
    <button class="btn block" id="seen" type="button" style="margin-bottom:16px">Verstanden</button></div>`;
}

function bindNotices() {
  $('#seen')?.addEventListener('click', async () => {
    await api('POST', '/api/notices/seen').catch(() => {});
    state.cal.notices = [];
    $('#notices')?.remove();
  });
}

// ---------- Kalender ----------

function shiftHtml(s) {
  const cls = ['shift', s.cancelled ? 'cancelled' : s.mine ? 'mine' : s.assignee ? 'taken' : 'free', s.past ? 'past' : ''].join(' ');
  let action;
  if (s.cancelled) action = `<span class="chip red">Fällt aus</span>`;
  else if (s.mine) {
    action = `<div class="person"><span class="dot"></span>Du</div>
      ${s.canCancel ? `<button class="btn small danger" data-cancel="${s.id}" type="button">Absagen</button>` : ''}`;
  } else if (s.assignee) action = `<div class="person"><span class="dot"></span>${esc(s.assignee)}</div>`;
  else if (s.past) action = `<div class="person muted">Nicht besetzt</div>`;
  else if (s.canBook) {
    action = `<div class="person"><span class="dot"></span>Frei${s.bonus ? ' <span class="chip gold">+ Bonus</span>' : ''}</div>
      <button class="btn primary" data-book="${s.id}" type="button">Eintragen</button>`;
  } else {
    action = `<div class="person"><span class="dot"></span>Frei</div>
      <span class="lock">${ICONS.lock} ab ${esc(s.lockedUntil)}</span>`;
  }
  return `<article class="${cls}">
      <div class="time">${esc(s.time)}<small>Uhr</small></div>
      <div><h3>${esc(s.film)}</h3><div class="meta">Schicht ab ${esc(s.shiftStart)} Uhr${s.note ? ` · ${esc(s.note)}` : ''}</div></div>
      <div class="act">${action}</div>
    </article>`;
}

/**
 * Zeigt sofort den letzten bekannten Stand und holt im Hintergrund den neuen.
 * Neu gezeichnet wird nur, wenn sich wirklich etwas geändert hat.
 * silent = automatische Aktualisierung: keine Fehlermeldung bei kurzem Verbindungsaussetzer.
 */
async function renderCalendar({ silent = false } = {}) {
  if (!state.cal) view.innerHTML = '<div class="spinner"></div>';
  else if (!silent) drawCalendar();
  const before = JSON.stringify(state.cal);
  try { await loadCalendar(silent); } catch (err) { return silent ? undefined : handleError(err); }
  if (state.tab !== 'kalender') return;
  if (JSON.stringify(state.cal) === before && view.querySelector('.day')) return;
  drawCalendar();
}

/** Nach Eintragen/Absagen: Der Server schickt den neuen Kalender gleich mit. */
function applyCalendar(cal) {
  if (!cal) return render();
  state.cal = cal;
  renderWho();
  if (state.tab === 'kalender') drawCalendar(); else render();
}

function drawCalendar() {
  const cal = state.cal;
  const today = berlinToday(); const tomorrow = berlinToday(1);
  const days = cal.days.map((d) => ({ ...d, shifts: state.onlyFree ? d.shifts.filter((s) => s.canBook || s.lockedUntil) : d.shifts }));
  const anyLocked = cal.days.some((d) => d.shifts.some((s) => s.lockedUntil));
  view.innerHTML = `
    ${noticesHtml(cal)}
    <h1 class="page-title">Hallo ${esc(cal.me.firstName)}!</h1>
    <div class="filterbar" role="group" aria-label="Filter">
      <button type="button" data-filter="all" aria-pressed="${!state.onlyFree}">Alle Schichten</button>
      <button type="button" data-filter="free" aria-pressed="${state.onlyFree}">Nur freie</button>
    </div>
    ${anyLocked ? `<div class="release-note">${ICONS.lock}<span>${esc(cal.releaseRule)}</span></div>` : ''}
    ${days.map((d) => `
      <section class="day">
        <div class="day-head"><h2>${dayTitle(d, today, tomorrow)}</h2><span class="muted">${esc(d.label)}</span></div>
        ${d.shifts.length ? d.shifts.map(shiftHtml).join('') : `<div class="day-empty">${state.onlyFree ? 'Keine freien Schichten.' : 'Keine Vorstellungen.'}</div>`}
      </section>`).join('')}`;
  bindNotices();
}

view.addEventListener('click', async (e) => {
  const f = e.target.closest('[data-filter]');
  if (f) { state.onlyFree = f.dataset.filter === 'free'; return drawCalendar(); }

  const book = e.target.closest('[data-book]');
  if (book) {
    return busy(book, async () => {
      try {
        const r = await api('POST', `/api/shifts/${book.dataset.book}/book`);
        toast(r.message);
        state.my = null;
        applyCalendar(r.calendar);
      } catch (err) {
        handleError(err);
        if (err.status !== 401) renderCalendar(); // zeigt, wer die Schicht bekommen hat
      }
    });
  }

  const cancel = e.target.closest('[data-cancel]');
  if (cancel) {
    const s = findShift(Number(cancel.dataset.cancel));
    if (!s) return;
    const ok = await confirmDialog({
      title: 'Schicht wirklich absagen?',
      text: `${esc(s.dayLabel)}, ${esc(s.time)} Uhr – „${esc(s.film)}“<br><br>
        Wenn du jetzt absagst, bekommst du <b>${s.penalty} Minuspunkt${s.penalty === 1 ? '' : 'e'}</b>. Die Schicht ist danach sofort wieder frei.`,
      yes: 'Ja, absagen', no: 'Doch nicht', danger: true,
    });
    if (!ok) return;
    try {
      const r = await api('POST', `/api/shifts/${s.id}/cancel`);
      toast(r.message);
      state.my = null;
      applyCalendar(r.calendar);
    } catch (err) {
      handleError(err);
      if (err.status !== 401) render();
    }
  }
});

function findShift(id) {
  for (const d of state.cal?.days || []) {
    const s = d.shifts.find((x) => x.id === id);
    if (s) return { ...s, dayLabel: d.label };
  }
  for (const s of state.my?.upcoming || []) if (s.id === id) return { ...s, dayLabel: s.dateLabel };
  return null;
}

// ---------- Meine Schichten ----------

/** Holt "Meine Schichten" + Punkte; zeigt bis dahin den letzten Stand statt eines Lade-Kreisels. */
async function loadMy(tab, draw) {
  if (state.my && state.cal) draw(); else view.innerHTML = '<div class="spinner"></div>';
  try {
    [state.my] = await Promise.all([api('GET', '/api/my'), loadCalendar()]);
  } catch (err) { return handleError(err); }
  if (state.tab === tab) draw();
}

const renderMine = () => loadMy('meine', drawMine);
const renderPoints = () => loadMy('punkte', drawPoints);

function drawMine() {
  const list = state.my.upcoming;
  view.innerHTML = `
    ${noticesHtml(state.cal)}
    <h1 class="page-title">Meine Schichten</h1>
    ${list.length ? list.map((s) => `
      <div class="day-head" style="position:static"><h2>${esc(s.dateLabel)}</h2></div>
      ${shiftHtml(s)}`).join('') : `
      <div class="card empty"><span class="big">🎬</span>Du hast gerade keine Schichten.<br>
        <button class="btn primary" style="margin-top:14px" type="button" id="toCal">Freie Schichten ansehen</button></div>`}`;
  bindNotices();
  $('#toCal')?.addEventListener('click', () => { state.onlyFree = true; go('kalender'); });
}

// ---------- Punkte ----------

function drawPoints() {
  const my = state.my;
  const p = my.points;
  const level = p === 0 ? 'ok' : p < my.warnAt / 2 ? 'mid' : 'high';
  const msg = p === 0 ? 'Super, du hast keine Minuspunkte!' : p < my.warnAt / 2 ? 'Alles im grünen Bereich.' : 'Bitte sag nur ab, wenn es wirklich nicht anders geht.';
  view.innerHTML = `
    <h1 class="page-title">Meine Punkte</h1>
    <div class="card score ${level}"><div class="num">${p}</div><div class="lbl">Minuspunkte</div><p style="margin:12px 0 0">${msg}</p></div>
    <div class="card"><h2>So funktioniert es</h2>
      <p style="margin:0">${esc(my.explanation[0])}</p>
      <ul class="rules">${my.explanation.slice(1, 5).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${my.explanation.slice(5).map((x) => `<p style="margin:10px 0 0">${esc(x)}</p>`).join('')}
    </div>
    <div class="card"><h2>Zuletzt</h2>
      ${my.events.length ? `<ul class="clean">${my.events.map((e) => `<li><span>${esc(e.reason)}<br><span class="small muted">${esc(e.when)}</span></span>
        <b style="color:${e.delta > 0 ? 'var(--red)' : 'var(--green)'}">${e.delta > 0 ? '+' : ''}${e.delta}</b></li>`).join('')}</ul>` : '<p class="muted" style="margin:0">Noch keine Einträge.</p>'}
    </div>`;
}

// ---------- Assistent ----------

const SUGGESTIONS = ['Wann ist meine nächste Schicht?', 'Welche Schichten sind noch frei?', 'Was läuft heute?', 'Wann muss ich am Samstag da sein?'];

function renderChat() {
  const enabled = state.cal?.aiEnabled !== false;
  view.innerHTML = `
    <h1 class="page-title">Frag den Assistenten</h1>
    <p class="page-sub">Er kennt den Kalender und deine Schichten. Eintragen und Absagen geht weiter über die Buttons.</p>
    <div class="chat">
      <div class="chat-log" id="chatLog"></div>
      ${state.chat.length ? '' : `<div class="suggest">${SUGGESTIONS.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`}
      <form class="chat-form" id="chatForm">
        <input class="input" name="q" placeholder="${enabled ? 'Deine Frage …' : 'Der Assistent ist noch nicht eingerichtet.'}" autocomplete="off" maxlength="600" ${enabled ? '' : 'disabled'}>
        <button class="btn primary" type="submit" aria-label="Senden" ${enabled ? '' : 'disabled'}>${ICONS.send}</button>
      </form>
    </div>`;
  drawChat();
  const form = $('#chatForm');
  view.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.q)));
  form.addEventListener('submit', (e) => { e.preventDefault(); ask(form.q.value); });
}

function drawChat(pending = false) {
  const log = $('#chatLog');
  if (!log) return;
  log.innerHTML = state.chat.map((m) => `<div class="bubble ${m.role === 'user' ? 'user' : 'bot'}${m.error ? ' error' : ''}">${esc(m.text)}</div>`).join('')
    + (pending ? '<div class="bubble bot"><span class="typing"><i></i><i></i><i></i></span></div>' : '');
  log.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

let asking = false;
async function ask(text) {
  const q = text.trim();
  if (!q || asking) return;
  asking = true;
  const history = state.chat.filter((m) => !m.error).map(({ role, text: t }) => ({ role, text: t }));
  state.chat.push({ role: 'user', text: q });
  $('.suggest')?.remove();
  const form = $('#chatForm');
  if (form) form.q.value = '';
  drawChat(true);
  try {
    const r = await api('POST', '/api/chat', { history, question: q });
    state.chat.push({ role: 'assistant', text: r.answer });
  } catch (err) {
    if (err.status === 401) { asking = false; return showLogin(); }
    state.chat.push({ role: 'assistant', text: err.message, error: true });
  }
  state.chat = state.chat.slice(-20);
  sessionStorage.setItem('chat', JSON.stringify(state.chat));
  asking = false;
  drawChat();
}

// ---------- Start ----------

async function start() {
  // Direkt den Kalender holen (spart eine Anfrage). Nicht angemeldet → Anmeldung.
  try {
    await loadCalendar();
  } catch (err) {
    if (err.status === 401) return showLogin();
    view.innerHTML = `<div class="card empty"><span class="big">📶</span>${esc(err.message)}<br>
      <button class="btn primary" type="button" style="margin-top:14px" id="retry">Noch einmal versuchen</button></div>`;
    $('#retry').addEventListener('click', () => location.reload());
    return;
  }
  renderTabs();
  if (state.tab === 'kalender') drawCalendar(); else render();
}

// Kalender regelmäßig auffrischen, damit man sieht, was andere eingetragen haben.
setInterval(() => { if (!document.hidden && state.tab === 'kalender' && !tabbar.hidden && !document.querySelector('.modal-back')) renderCalendar({ silent: true }); }, 45000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !tabbar.hidden && state.tab === 'kalender') renderCalendar({ silent: true }); });

start();
