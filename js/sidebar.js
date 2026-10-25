import { state, today, esc } from './store.js';
import { openSearch } from './search.js';
import { kbNotes } from './kb.js';
import { getPeople } from './contacts.js';

/* ══════════════ ЛЕВОЕ МЕНЮ ══════════════
   На компьютере и планшете шапки нет: всё, что в ней было, живёт в
   закреплённом меню слева. Кнопки разделов, виджетов, облака и
   настроек не копируются, а переезжают сюда как есть — с их
   обработчиками, состоянием «.on», точкой синхронизации и зоной
   «убрать в панель виджетов».
   Фон меню — SVG-фигура с «вырезом» под открытым разделом: сквозь него
   виден фон приложения или обои, и он плавно переезжает между пунктами.
   Меню сворачивается в тонкий столбик иконок; значки при этом стоят на
   месте — сужается только само меню, подписи гаснут. Выбор запоминается.
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
    <svg class="sb-bg" aria-hidden="true"><defs><linearGradient id="sbGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sb-g0"/><stop offset=".35" class="sb-g1"/><stop offset="1" class="sb-g2"/></linearGradient></defs><path class="sb-bg-fill" fill="url(#sbGrad)"/><path class="sb-bg-edge"/></svg>
    <div class="sb-head"><span class="sb-logo">E</span><b class="sb-name">Essential OS</b></div>
    <button type="button" class="sb-collapse" aria-label="Свернуть меню" title="Свернуть меню">${ICON_CHEV}</button>
    <div class="sb-scroll">
      <div class="sb-sec sb-views"></div>
    </div>
    <div class="sb-sec sb-tools">${item('sb-search', ICON_SEARCH, 'Поиск')}</div>`;
  document.body.insertBefore(sb, $('app'));
  sb.querySelector('.sb-collapse').onclick = () => setMini(!document.body.classList.contains('sb-mini'));
  sb.querySelector('.sb-search').onclick = () => openSearch();
  /* фигура фона пересчитывается при любом изменении размера меню
     (в том числе каждый кадр сворачивания) */
  new ResizeObserver(() => drawBg()).observe(sb);
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
  moveInd(sb);
}

/* ── Фон с вырезом ──
   Скруглённый прямоугольник меню; под открытым разделом из него
   вырезана пилюля, открытая к правому краю, с вогнутыми скруглениями
   в местах стыка с краем меню. */
const R = 30, TAB_H = 44, TAB_R = 22, FIL = 16, TAB_X = 12;
let indY = null, indAnim = 0;
function drawBg() {
  const sb = $('sidebar');
  if (!sb || mqMobile.matches) return;
  const svg = sb.querySelector('.sb-bg');
  const W = sb.offsetWidth, H = sb.offsetHeight;
  if (!svg || !W || !H) return;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  let d;
  if (indY == null) {
    d = `M${R} 0H${W - R}A${R} ${R} 0 0 1 ${W} ${R}V${H - R}A${R} ${R} 0 0 1 ${W - R} ${H}H${R}A${R} ${R} 0 0 1 0 ${H - R}V${R}A${R} ${R} 0 0 1 ${R} 0Z`;
  } else {
    const y = indY, y2 = y + TAB_H, cx = TAB_X + TAB_R;
    d = `M${R} 0H${W - R}A${R} ${R} 0 0 1 ${W} ${R}` +
      `V${y - FIL}A${FIL} ${FIL} 0 0 1 ${W - FIL} ${y}` +          // вогнутое скругление над вырезом
      `H${cx}A${TAB_R} ${TAB_R} 0 0 0 ${cx} ${y2}` +                // скруглённый левый край выреза
      `H${W - FIL}A${FIL} ${FIL} 0 0 1 ${W} ${y2 + FIL}` +           // вогнутое скругление под вырезом
      `V${H - R}A${R} ${R} 0 0 1 ${W - R} ${H}H${R}A${R} ${R} 0 0 1 0 ${H - R}V${R}A${R} ${R} 0 0 1 ${R} 0Z`;
  }
  svg.querySelector('.sb-bg-fill').setAttribute('d', d);
  svg.querySelector('.sb-bg-edge').setAttribute('d', d);
}
/* Вырез переезжает к открытому разделу — плавно, без отскока */
function moveInd(sb) {
  const on = sb.querySelector('.sb-views .sb-it.on');
  if (!on) { indY = null; drawBg(); return; }
  const target = on.getBoundingClientRect().top - sb.getBoundingClientRect().top;
  cancelAnimationFrame(indAnim);
  if (indY == null || Math.abs(target - indY) < 1 || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    indY = target; drawBg(); return;
  }
  const from = indY, t0 = performance.now(), DUR = 520;
  const step = now => {
    const p = Math.min(1, (now - t0) / DUR);
    const e = 1 - Math.pow(1 - p, 4);
    indY = from + (target - from) * e;
    drawBg();
    if (p < 1) indAnim = requestAnimationFrame(step);
  };
  indAnim = requestAnimationFrame(step);
}

export function sidebarInit() {
  try { if (localStorage.getItem(MINI_KEY) === '1') document.body.classList.add('sb-mini'); } catch (e) {}
  place();
  if (mqMobile.addEventListener) mqMobile.addEventListener('change', place);
}
