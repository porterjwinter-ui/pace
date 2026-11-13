// DOM helpers. Every piece of user or imported text goes through esc() before reaching innerHTML.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Tagged template that escapes interpolations unless wrapped with raw(). */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    if (Array.isArray(v)) out += v.map((x) => (x && x.__raw !== undefined ? x.__raw : esc(x))).join('');
    else if (v && v.__raw !== undefined) out += v.__raw;
    else if (v === false || v === null || v === undefined) out += '';
    else out += esc(v);
    out += strings[i + 1];
  });
  return { __raw: out };
}
export const raw = (s) => ({ __raw: String(s) });
export const render = (el, tpl) => { el.innerHTML = tpl.__raw ?? tpl; return el; };

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) node.append(c?.nodeType ? c : document.createTextNode(c ?? ''));
  return node;
}

// ---- Icons (24×24, stroke) ----
const P = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  sparkle: '<path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5Z"/><path d="M18.5 15.5c.25 1.6 1 2.35 2.5 2.5-1.5.25-2.25 1-2.5 2.5-.25-1.5-1-2.25-2.5-2.5 1.5-.15 2.25-.9 2.5-2.5Z"/>',
  send: '<path d="M5 12h13M13 6l6 6-6 6"/>',
  upload: '<path d="M12 15V4M7 9l5-5 5 5M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 10.5 3.75 3.75 0 0 0 7 18Z"/>',
  cloudCheck: '<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 10.5 3.75 3.75 0 0 0 7 18Z"/><path d="m9.5 13.5 2 2 3.5-3.5"/>',
  cloudOff: '<path d="M4 4l16 16"/><path d="M9 6.2A6 6 0 0 1 17.6 10a4 4 0 0 1 2 6.9M16 18H7a3.75 3.75 0 0 1-1-7.4"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4Z"/><path d="M12 10v4M12 17h.01"/>',
  device: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2.5 19h19"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  repeat: '<path d="M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3 3-3"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  pin: '<path d="M9 4h6l-1 6 3 3v1H7v-1l3-3ZM12 14v6"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  list: '<path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M4 4l16 16M10 5.7A9.8 9.8 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-2.6 3.4M6.4 6.6C3.9 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
  task: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.8-5"/>',
  event: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16"/>',
};
export const icon = (name, cls = '') => raw(`<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`);

// ---- Toasts ----
let toastTimer;
export function toast(message, { action, onAction, timeout = 5000, tone = '' } = {}) {
  let host = $('#toast');
  if (!host) { host = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(host); }
  render(host, html`<div class="toast ${tone}"><span>${message}</span>${action ? html`<button class="btn-text" data-act>${action}</button>` : ''}</div>`);
  host.classList.add('show');
  const btn = $('[data-act]', host);
  if (btn) btn.onclick = () => { host.classList.remove('show'); onAction?.(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('show'), timeout);
}

// ---- Popover anchored to a rect ----
let activePop = null;
export const isPhone = () => window.innerWidth < 760;
export function closePopover() {
  if (activePop) { activePop.scrim?.remove(); activePop.remove(); activePop.cleanup?.(); activePop = null; }
}
/** Anchored popover on wide screens; a bottom sheet on phones. */
export function popover(anchor, content, { cls = '', width = 340, onClose } = {}) {
  closePopover();
  const pop = el('div', { class: `popover ${cls}`, role: 'dialog' });
  if (typeof content === 'string' || content.__raw !== undefined) render(pop, content); else pop.append(content);
  if (isPhone()) {
    pop.classList.add('as-sheet');
    pop.prepend(el('div', { class: 'sheet-grip', 'aria-hidden': 'true' }));
    const scrim = el('div', { class: 'sheet-scrim' });
    document.body.append(scrim, pop);
    pop.scrim = scrim;
  } else {
    pop.style.width = `${Math.min(width, window.innerWidth - 24)}px`;
    document.body.append(pop);
  }
  if (!pop.classList.contains('as-sheet')) placePopover(pop, anchor);
  const onDown = (e) => { if (!pop.contains(e.target)) { e.stopPropagation(); closePopover(); } };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  setTimeout(() => { document.addEventListener('pointerdown', onDown, true); }, 0);
  document.addEventListener('keydown', onKey, true);
  pop.cleanup = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  activePop = pop;
  pop.querySelector('[autofocus]')?.focus();
  return pop;
}

function placePopover(pop, anchor) {
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  let left, top;
  if (r.right + 10 + pw <= vw - 12) { left = r.right + 10; top = r.top; }
  else if (r.left - 10 - pw >= 12) { left = r.left - pw - 10; top = r.top; }
  else {
    left = clamp(r.left + r.width / 2 - pw / 2, 12, vw - pw - 12);
    top = r.bottom + 8;
    if (top + ph > vh - 12) top = r.top - ph - 8;
  }
  top = clamp(top, 12, Math.max(12, vh - ph - 12));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

// ---- Modal dialogs (native <dialog>) ----
export function modal(content, { cls = '', onClose, label = 'Dialog' } = {}) {
  closePopover();
  const dlg = el('dialog', { class: `modal ${cls}`, 'aria-label': label });
  if (content.__raw !== undefined) render(dlg, content); else dlg.append(content);
  document.body.append(dlg);
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();
  dlg.querySelector('[autofocus]')?.focus();
  return dlg;
}

export function confirmDialog({ title, body = '', confirm = 'Confirm', danger = false, choices = null }) {
  return new Promise((resolve) => {
    const buttons = choices || [{ value: true, label: confirm, danger }];
    const dlg = modal(html`
      <form method="dialog" class="confirm">
        <h2>${title}</h2>
        ${body ? html`<p class="muted">${body}</p>` : ''}
        <div class="row end gap">
          <button class="btn" value="">Cancel</button>
          ${buttons.map((b, i) => html`<button class="btn ${b.danger ? 'danger' : 'primary'}" value="${i}" ${i === buttons.length - 1 ? raw('autofocus') : ''}>${b.label}</button>`)}
        </div>
      </form>`, { cls: 'small', onClose: () => resolve(dlg.returnValue === '' ? null : buttons[+dlg.returnValue]?.value ?? null) });
  });
}

/** Minimal, safe markdown for assistant replies. */
export function markdown(src) {
  const lines = esc(src).split('\n');
  const out = [];
  let list = null, para = [], code = null;
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line)) { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = null; } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) { flushPara(); flushList(); code = []; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const ul = line.match(/^\s*[-*•]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (h) { flushPara(); flushList(); out.push(`<h4>${inline(h[2])}</h4>`); }
    else if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ||= { tag, items: [] };
      list.items.push((ul || ol)[1]);
    } else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line.trim()); }
  }
  if (code !== null) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
  flushPara(); flushList();
  return out.join('');
}
