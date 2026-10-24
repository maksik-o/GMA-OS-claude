import { state, MODES, today, esc } from './store.js';
import { openSearch } from './search.js';
import { kbNotes } from './kb.js';
import { getPeople } from './contacts.js';

/* ══════════════ ЛЕВОЕ МЕНЮ ══════════════
   На компьютере и планшете шапки нет: всё, что в ней было, живёт в
   закреплённом меню слева. Кнопки разделов, виджетов, облака и
   настроек не копируются, а переезжают сюда как есть — с их
   обработчиками, состоянием «.on», точкой синхронизации и зоной
   «убрать в панель виджетов». Режимы — свои кнопки, нажимают
   скрытые кнопки шапки, чтобы смена шла с той же анимацией.
   Меню сворачивается в тонкий столбик иконок; выбор запоминается.
   На телефоне всё возвращается в шапку и нижнюю пилюлю. */

const $ = id => document.getElementById(id);
const mqMobile = matchMedia('(max-width: 720px)');
const MINI_KEY = 'rl_sb_mini';
const VIEW_IDS = ['homeBtn', 'tasksBtn', 'kbBtn', 'finBtn', 'ctBtn'];
const TOOL_IDS = ['widgetsBtn', 'syncBtn', 'settingsBtn'];
let _home = null;   // исходные места кнопок в шапке

const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const ICON_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m14.5 6-6 6 6 6"/></svg>';
const item = (cls, ico, label, attrs = '') =>
  `<button type="button" class="sb-it ${cls}" ${attrs} title="${esc(label)}" aria-label="${esc(label)}"><span class="tb-ico">${ico}</span><span class="tb-lab"><span>${esc(label)}</span></span></button>`;

function build() {
  let sb = $('sidebar');
  if (sb) return sb;
  sb = document.createElement('aside');
  sb.id = 'sidebar';
  sb.className = 'sidebar';
  sb.setAttribute('aria-label', 'Меню');
  sb.innerHTML = `
    <div class="sb-head"><span class="sb-logo">G</span><b class="sb-name">GMA-OS</b></div>
    <button type="button" class="sb-collapse" aria-label="Свернуть меню" title="Свернуть меню">${ICON_CHEV}</button>
    <div class="sb-scroll">
      <div class="sb-sec sb-views"></div>
      <div class="sb-cap sb-modes-cap">Режимы</div>
      <div class="sb-sec sb-modes"></div>
    </div>
    <div class="sb-sec sb-tools">${item('sb-search', ICON_SEARCH, 'Поиск')}</div>`;
  document.body.insertBefore(sb, $('app'));
  sb.querySelector('.sb-collapse').onclick = () => setMini(!document.body.classList.contains('sb-mini'));
  sb.querySelector('.sb-search').onclick = () => openSearch();
  sb.querySelector('.sb-modes').addEventListener('click', e => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    const real = document.querySelector(`#modes button[data-m="${b.dataset.m}"]`);
    if (real) real.click();
  });
  return sb;
}
function setMini(on) {
  document.body.classList.toggle('sb-mini', on);
  try { localStorage.setItem(MINI_KEY, on ? '1' : ''); } catch (e) {}
  const c = document.querySelector('#sidebar .sb-collapse');
  if (c) c.setAttribute('aria-label', on ? 'Развернуть меню' : 'Свернуть меню');
  if (c) c.title = on ? 'Развернуть меню' : 'Свернуть меню';
  /* ширина контента изменилась — пусть всё, что меряет себя, перемерится */
  setTimeout(() => dispatchEvent(new Event('resize')), 380);
}

/* Кнопки шапки ↔ меню */
function rememberHome() {
  if (_home) return;
  _home = [...VIEW_IDS, ...TOOL_IDS].map(id => {
    const el = $(id);
    return el ? { el, parent: el.parentNode, next: el.nextSibling, cls: el.className } : null;
  }).filter(Boolean);
}
function place() {
  const sb = build();
  rememberHome();
  const desk = !mqMobile.matches;
  document.body.classList.toggle('has-sidebar', desk);
  if (desk) {
    const views = sb.querySelector('.sb-views'), tools = sb.querySelector('.sb-tools');
    for (const h of _home) {
      const host = VIEW_IDS.includes(h.el.id) ? views : tools;
      if (h.el.parentNode !== host) host.appendChild(h.el);
      /* Классы шапки (icon-btn, tb-btn) тянут за собой оформление тем —
         в меню у кнопки своё; .sync оставляем ради точки статуса */
      h.el.className = 'sb-it' + (h.el.classList.contains('on') ? ' on' : '') + (h.el.id === 'syncBtn' ? ' sync' : '');
    }
  } else {
    for (const h of _home.slice().reverse()) {
      const on = h.el.classList.contains('on');
      h.el.className = h.cls;
      h.el.classList.toggle('on', on);
      if (h.el.parentNode !== h.parent) h.parent.insertBefore(h.el, h.next && h.next.parentNode === h.parent ? h.next : null);
    }
  }
  renderSidebar();
}

/* Счётчики и режимы — после каждой перерисовки экрана */
export function renderSidebar() {
  const sb = $('sidebar');
  if (!sb || mqMobile.matches) return;
  const d = today();
  const open = t => { const s = (t.days || {})[d]; return s === 'todo' || s === 'started'; };
  const live = state.tasks.filter(t => !t.deleted);
  const counts = {
    tasksBtn: live.filter(t => open(t) && (state.mode === 'all' || t.mode === state.mode)).length,
    kbBtn: kbNotes().length,
    ctBtn: getPeople('all').length,
  };
  for (const id of VIEW_IDS) {
    const b = $(id);
    if (!b) continue;
    let n = b.querySelector('.sb-n');
    const v = counts[id] || 0;
    if (!v) { if (n) n.remove(); continue; }
    if (!n) { n = document.createElement('span'); n.className = 'sb-n'; b.appendChild(n); }
    n.textContent = v;
  }
  const modes = sb.querySelector('.sb-modes');
  const html = MODES.map(m => {
    const n = m.id === 'all' ? live.filter(open).length : live.filter(t => t.mode === m.id && open(t)).length;
    return `<button type="button" class="sb-it sb-mode${state.mode === m.id ? ' sel' : ''}" data-m="${m.id}" title="${esc(m.label)}" aria-label="${esc(m.label)}" aria-pressed="${state.mode === m.id}" style="--mc:var(--mode-${m.id})">
      <span class="tb-ico"><i class="sb-mdot"></i></span><span class="tb-lab"><span>${esc(m.label)}</span></span>${n ? `<span class="sb-n">${n}</span>` : ''}</button>`;
  }).join('');
  if (modes.innerHTML !== html) modes.innerHTML = html;
}

export function sidebarInit() {
  try { if (localStorage.getItem(MINI_KEY) === '1') document.body.classList.add('sb-mini'); } catch (e) {}
  place();
  if (mqMobile.addEventListener) mqMobile.addEventListener('change', place);
  document.addEventListener('mode-labels-changed', renderSidebar);
}
