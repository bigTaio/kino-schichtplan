// Gemeinsame Helfer für Mitarbeiter- und Admin-Seite. Enthält keine Geheimnisse.

export const $ = (sel, root = document) => root.querySelector(sel);

/** Text sicher in HTML einsetzen (Namen und Filmtitel kommen von Menschen). */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Dünner Ladebalken oben, sobald eine Anfrage länger als 150 ms dauert (kurze sieht man gar nicht).
let pending = 0;
let barTimer = null;
function loadingStart() {
  pending++;
  if (pending === 1) barTimer = setTimeout(() => document.body.classList.add('is-loading'), 150);
}
function loadingEnd() {
  pending = Math.max(0, pending - 1);
  if (pending === 0) { clearTimeout(barTimer); document.body.classList.remove('is-loading'); }
}

/** quiet = Hintergrund-Anfrage ohne Ladebalken */
export async function api(method, url, body, { quiet = false } = {}) {
  if (quiet) return request(method, url, body);
  loadingStart();
  try {
    return await request(method, url, body);
  } finally {
    loadingEnd();
  }
}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kino' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('Keine Verbindung. Bitte prüfe dein Internet und versuch es noch einmal.', 0);
  }
  let data = {};
  try { data = await res.json(); } catch { /* leer */ }
  if (!res.ok) throw new ApiError(data.error || 'Da ist leider etwas schiefgegangen.', res.status);
  return data;
}

// ---------- Kurze Meldungen unten am Bildschirm ----------

let toastArea;
export function toast(text, { type = 'ok', action, onAction, ms = 4500 } = {}) {
  if (!toastArea) {
    toastArea = document.createElement('div');
    toastArea.className = 'toast-area';
    toastArea.setAttribute('role', 'status');
    toastArea.setAttribute('aria-live', 'polite');
    document.body.append(toastArea);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="grow">${esc(text)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  const close = () => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; setTimeout(() => el.remove(), 200); };
  if (action) el.querySelector('button').onclick = () => { close(); onAction?.(); };
  toastArea.append(el);
  setTimeout(close, action ? Math.max(ms, 9000) : ms);
}

export const toastError = (err) => toast(err?.message || String(err), { type: 'err', ms: 6000 });

// ---------- Dialog (unten aufklappend auf dem Handy) ----------

export function modal(html, { onOpen } = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    const close = (value) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    back.addEventListener('click', (e) => {
      if (e.target === back) return close(null);
      const btn = e.target.closest('[data-close]');
      if (btn) close(btn.dataset.close);
    });
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    onOpen?.(back.firstElementChild, close);
    back.querySelector('input, select, textarea, button')?.focus({ preventScroll: true });
  });
}

export function confirmDialog({ title, text, yes = 'Ja', no = 'Abbrechen', danger = false }) {
  return modal(`
    <h2>${esc(title)}</h2>
    ${text ? `<p class="muted">${text}</p>` : ''}
    <div class="actions">
      <button class="btn block ${danger ? 'danger' : 'primary'}" data-close="yes">${esc(yes)}</button>
      <button class="btn block ghost" data-close="no">${esc(no)}</button>
    </div>`).then((v) => v === 'yes');
}

/** Button während einer Anfrage sperren, damit nicht doppelt geklickt wird. */
export async function busy(btn, fn) {
  if (btn?.disabled) return;
  const old = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'; }
  try { return await fn(); } finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
}

export const ICONS = {
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>',
  mine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1L3.2 9.4l6.1-.8z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

export function dayTitle(day, todayStr, tomorrowStr) {
  if (day.date === todayStr) return 'Heute';
  if (day.date === tomorrowStr) return 'Morgen';
  return day.weekday;
}

export function berlinToday(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
