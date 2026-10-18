import {
  state, WEEKDAYS, addDays, today, iso, TYPE_LABEL, PRIORITY_LABEL,
  getTagsDict, getTagColor, addTagsToDict, createTask, updateTask, removeTask, getTask,
  addSubtask, toggleSubtask, delSubtask,
  esc, MONTHS, taskPlans, setTaskPlan, removeTaskPlan, hmToMin, minToHM,
} from './store.js';
import { attachFile, openTaskFile, removeTaskFile, fmtSize } from './files.js';
import { limitNote } from './attach.js';
import { quickStyle, setQuickStyle, renderQuickAlt, QUICK_STYLES } from './quick.js';
import { renderAll } from './week.js';
import { createCalDrum, calTitle } from './cal.js';
import * as tm from './timer.js';

const $ = id => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const sheet = $('sheet'), editor = $('editor'), daySheet = $('daySheet');
let editId = null;
let edDrum = null;
export const sheetOpen = () =>
  (sheet && sheet.classList.contains('open')) ||
  (editor && editor.classList.contains('open')) ||
  (daySheet && daySheet.classList.contains('open'));
export function refreshBackdrop() {
  const backdrop = $('backdrop');
  if (!backdrop) return;
  const anyOpen = document.querySelector('.sheet.open, .auth.open, .drawer.open, .editor.open, .searchpanel.open');
  backdrop.classList.toggle('open', !!anyOpen);
}
function mkChip(label, on, cls, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip' + (cls ? ' ' + cls : '') + (on ? ' on' : '');
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}
function growEl(el) { if (!el) return; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
export function openSheet(task) { if (task) openEditor(task); else openQuick(); }
export function closeSheet() {
  hidePicker();
  if (sheet) {
    sheet.classList.remove('open', 'drag');
    sheet.style.transform = '';
  }
  if (editor) editor.classList.remove('open');
  refreshBackdrop();
}
export function closeDay() {
  if (daySheet) {
    daySheet.classList.remove('open', 'drag');
    daySheet.style.transform = '';
  }
  refreshBackdrop();
}
function openQuick() {
  editId = null;
  qStyle = quickStyle();
  renderQuick();
  if (sheet) sheet.classList.add('open');
  resetPicker();
  refreshBackdrop();
}
let qStyle = 'builder';
function renderQuick() {
  if (sheet) sheet.dataset.qs = qStyle;
  renderQuickAlt($('qAlt'), { style: qStyle, close: closeSheet, openEditor, rerender: renderAll });
}

/* ══════════ Окно режимов панели ввода ══════════
   На краю панели — «пупырка» со стрелкой (компьютер: справа по центру,
   телефон: сверху в правом углу). Нажали — пупырка разглаживается, а из-
   под панели выезжает окно режимов; на его краю, обращённом к панели,
   появляется такая же пупырка — закрыть. Выбор режима меняет только
   содержимое панели, окно остаётся. У выбранной строки — «По умолчанию»:
   этот режим открывается по «＋» всегда. «?» показывает справку в окне.
   Окно закрывается, если начать печатать, прокрутить или кликнуть мимо. */
let picker = null, pickerRO = null, helpFor = '', pickOpen = false, tab = null;
const CHEV = '<svg class="qp-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
/* «Пупырка» — продолжение края панели: от края плавная S-образная
   кривая выходит наружу и так же плавно возвращается. Два слоя:
   — .qp-bump-strip: полоска 4px заливкой панели поверх её рамки на стыке,
     чтобы рамка «расступилась» без шва;
   — .qp-bump: сама выпуклость с линией края и тенью панели; тень обрезана
     по стыку, чтобы не ложилась на панель (выпуклость с ней в одной
     плоскости). Стык — по средней линии рамки панели.
   Размер 24×76 (или 76×24), выступ — 20px. side: куда смотрит выпуклость. */
const BUMP = {   // [выпуклость, линия края, полоска на стыке, w, h]
  right: ['M4 0C4 12 24 8 24 22V54C24 68 4 64 4 76Z', 'M4 0C4 12 24 8 24 22V54C24 68 4 64 4 76', 'M0 0H4V76H0Z', 24, 76],
  left: ['M20 0C20 12 0 8 0 22V54C0 68 20 64 20 76Z', 'M20 0C20 12 0 8 0 22V54C0 68 20 64 20 76', 'M20 0H24V76H20Z', 24, 76],
  up: ['M0 20C12 20 8 0 22 0H54C68 0 64 20 76 20Z', 'M0 20C12 20 8 0 22 0H54C68 0 64 20 76 20', 'M0 20H76V24H0Z', 76, 24],
  down: ['M0 4C12 4 8 24 22 24H54C68 24 64 4 76 4Z', 'M0 4C12 4 8 24 22 24H54C68 24 64 4 76 4', 'M0 0H76V4H0Z', 76, 24],
};
function bumpHTML(side) {
  const [shape, line, strip, w, h] = BUMP[side];
  const svg = (cls, inner) => `<svg class="${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${inner}</svg>`;
  return svg('qp-bump-strip', `<path class="qp-bump-fill" d="${strip}"/>`)
    + svg('qp-bump', `<path class="qp-bump-fill" d="${shape}"/><path class="qp-bump-line" d="${line}"/>`) + CHEV;
}
function setBump(el, side) {
  if (!el || el.dataset.side === side) return;
  el.dataset.side = side;
  el.innerHTML = bumpHTML(side);
}
/* Оформление пупырки = оформление её панели (по вычисленному стилю):
   заливка — фон панели; линия — её рамка, а если рамки нет — кольцо из
   box-shadow (так обведена панель в «Коралле»); тень — внешние тени
   панели (жёсткая тень «Лего», мягкие у «Стекла», свечение «Неона»). */
function splitShadows(v) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of v || '') {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && !depth) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function parseShadow(sh) {
  const color = (sh.match(/(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})/i) || [])[0] || '';
  const [x, y, blur, spread] = (sh.replace(color, '').match(/-?[\d.]+px/g) || []).map(parseFloat).concat([0, 0, 0, 0]);
  const clear = !color || /rgba\([^)]*,\s*0\)|\/\s*0\)/.test(color);
  return { inset: /\binset\b/.test(sh), x, y, blur, spread, color, clear };
}
function skinBump(el, panel) {
  if (!el || !panel) return;
  const cs = getComputedStyle(panel);
  const bw = parseFloat(cs.borderRightWidth) || 0;
  let line = 'transparent', lw = 0;
  if (bw > 0 && cs.borderRightStyle !== 'none') { line = cs.borderRightColor; lw = bw; }
  const drops = [];
  for (const sh of splitShadows(cs.boxShadow === 'none' ? '' : cs.boxShadow).map(parseShadow)) {
    if (sh.inset || sh.clear) continue;
    if (!sh.x && !sh.y && !sh.blur && sh.spread > 0) { if (!lw) { line = sh.color; lw = sh.spread; } continue; }
    drops.push(`drop-shadow(${sh.x}px ${sh.y}px ${sh.blur / 2}px ${sh.color})`);
  }
  el.style.setProperty('--qpb-fill', cs.backgroundColor);
  el.style.setProperty('--qpb-line', line);
  el.style.setProperty('--qpb-lw', lw + 'px');
  el.style.setProperty('--qpb-bw', bw + 'px');   // стык — по средней линии рамки
  el.style.setProperty('--qpb-shadow', drops.join(' ') || 'none');
}
const GAP_SIDE = 26;   // зазор окна и панели на компьютере
const GAP_TOP = 22;    // на телефоне — над панелью
const isSide = () => innerWidth > 720;
function ensurePicker() {
  if (picker) return picker;
  picker = document.createElement('aside');
  picker.className = 'qpick glass';
  picker.setAttribute('aria-label', 'Режим панели ввода');
  /* в тот же контейнер, что и панель: иначе её z-index живёт в другом
     слое (#app) и окно оказывалось поверх панели, а не под ней */
  (sheet && sheet.parentNode ? sheet.parentNode : document.body).insertBefore(picker, sheet || null);
  picker.addEventListener('click', onPickerClick);
  picker.addEventListener('keydown', e => {
    const o = e.target.closest('.qp-opt');
    if (o && (e.key === 'Enter' || e.key === ' ') && e.target === o) { e.preventDefault(); switchQuick(o.dataset.qs); }
  });
  /* пупырка на панели ввода */
  tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'qp-tab';
  tab.title = 'Режим панели';
  tab.setAttribute('aria-label', 'Выбрать режим панели');
  tab.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openPicker(); });
  if (sheet) sheet.appendChild(tab);
  if (window.ResizeObserver && sheet) { pickerRO = new ResizeObserver(placePicker); pickerRO.observe(sheet); }
  addEventListener('resize', placePicker);
  return picker;
}
function renderPicker() {
  const p = ensurePicker();
  const def = quickStyle();
  const help = QUICK_STYLES.find(x => x.id === helpFor);
  p.innerHTML = `<button type="button" class="qp-close" title="Скрыть" aria-label="Скрыть режимы"></button>
    <div class="qp-head">Режим панели</div>
    <div class="qp-list"${help ? ' hidden' : ''}>${QUICK_STYLES.map(x => `
      <div class="qp-opt${x.id === qStyle ? ' on' : ''}" data-qs="${x.id}" role="button" tabindex="0" aria-pressed="${x.id === qStyle}">
        <span class="qp-ico">${x.icon}</span><span class="qp-name">${esc(x.label)}</span>
        <button type="button" class="qp-help" data-help="${x.id}" title="Справка: ${esc(x.label)}" aria-label="Справка: ${esc(x.label)}">?</button>
        ${x.id === qStyle ? `<button type="button" class="qp-def${x.id === def ? ' on' : ''}" aria-pressed="${x.id === def}" title="Открывать этот режим по «＋»"><i></i>По умолчанию</button>` : ''}
      </div>`).join('')}</div>
    ${help ? `<div class="qp-helpbox"><button type="button" class="qp-x" aria-label="Закрыть справку">✕</button>
      <b><span class="qp-ico">${help.icon}</span>${esc(help.label)}</b>
      <p>${esc(help.desc)}</p><ul>${help.how.map(h => `<li>${esc(h)}</li>`).join('')}</ul></div>` : ''}`;
  placePicker();
}
/* Окно стоит у панели: справа по центру её высоты (компьютер) или над
   её правым краем (телефон). Геометрия панели — без её transform. */
function placePicker() {
  if (!picker || !sheet) return;
  const sw = sheet.offsetWidth, sh = sheet.offsetHeight;
  const sl = (innerWidth - sw) / 2;
  const side = isSide();
  picker.classList.toggle('qp-side', side);
  picker.classList.toggle('qp-top', !side);
  if (tab) { tab.classList.toggle('qp-tab-top', !side); setBump(tab, side ? 'right' : 'up'); skinBump(tab, sheet); }
  const close = picker.querySelector('.qp-close');
  if (close) { close.dataset.side = ''; setBump(close, side ? 'left' : 'down'); skinBump(close, picker); }
  if (side) {
    /* окно не выше панели: выезжает из-под неё целиком (у «Умной строки»
       панель низкая — окно ограничено её высотой, длинная справка тает) */
    picker.style.width = '';
    const maxH = Math.max(150, sh - 16);
    picker.style.maxHeight = '';
    picker.classList.remove('qp-compact');
    /* не влезает в высоту панели — компактные строки без заголовка */
    if (!helpFor && picker.scrollHeight > maxH) picker.classList.add('qp-compact');
    /* справке даём больше места: она временная, окно может подрасти */
    picker.style.maxHeight = (helpFor ? Math.max(maxH, 360) : maxH) + 'px';
    picker.style.left = (sl + sw + GAP_SIDE) + 'px';
    picker.style.right = 'auto';
    picker.style.bottom = Math.max(8, (sh - picker.offsetHeight) / 2) + 'px';
    picker.style.setProperty('--qp-hide', `translateX(${-(picker.offsetWidth + GAP_SIDE + 24)}px)`);
  } else {
    picker.style.maxHeight = '';
    picker.classList.remove('qp-compact');
    picker.style.width = Math.min(sw - 24, 320) + 'px';
    picker.style.left = 'auto';
    picker.style.right = (innerWidth - sl - sw + 12) + 'px';
    picker.style.bottom = (sh + GAP_TOP) + 'px';
    picker.style.setProperty('--qp-hide', `translateY(${picker.offsetHeight + GAP_TOP + 24}px)`);
    picker.style.setProperty('--qp-avail', Math.max(140, innerHeight - sh - GAP_TOP - 90) + 'px');
  }
}
/* Новое открытие панели: окно спрятано, видна пупырка */
function resetPicker() {
  helpFor = '';
  ensurePicker();
  setPickOpen(false, true);
  renderPicker();
}
function setPickOpen(on, instant) {
  pickOpen = on;
  if (!picker) return;
  if (instant) { picker.classList.add('qp-instant'); requestAnimationFrame(() => picker && picker.classList.remove('qp-instant')); }
  picker.classList.toggle('open', on);
  if (tab) tab.classList.toggle('flat', on);
  if (on) armClosers(); else disarmClosers();
}
function openPicker() {
  if (!sheet || !sheet.classList.contains('open')) return;
  renderPicker();
  setPickOpen(true);
}
function closePicker() {
  closeHelp(true);
  setPickOpen(false);
}
function hidePicker() {
  closeHelp(true);
  if (picker) setPickOpen(false, true);
}
/* Закрыть окно: начали печатать, прокрутили или кликнули мимо него */
const outsidePick = e => e.target && picker && !picker.contains(e.target) && !(tab && tab.contains(e.target));
const pickCloser = e => {
  if (!pickOpen) return;
  if (e.type === 'keydown') {
    if (picker.contains(e.target) && (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab')) return;
    closePicker(); return;
  }
  /* прокрутка закрывает в любом месте, клик — только мимо окна */
  if (e.type !== 'pointerdown' || outsidePick(e)) closePicker();
};
function armClosers() {
  setTimeout(() => {
    if (!pickOpen) return;
    ['pointerdown', 'wheel', 'touchmove', 'scroll'].forEach(t => document.addEventListener(t, pickCloser, { capture: true, passive: true }));
    document.addEventListener('keydown', pickCloser, true);
    document.addEventListener('input', pickCloser, true);
  }, 0);
}
function disarmClosers() {
  ['pointerdown', 'wheel', 'touchmove', 'scroll'].forEach(t => document.removeEventListener(t, pickCloser, { capture: true }));
  document.removeEventListener('keydown', pickCloser, true);
  document.removeEventListener('input', pickCloser, true);
}
function onPickerClick(e) {
  if (e.target.closest('.qp-close')) { closePicker(); return; }
  const h = e.target.closest('.qp-help');
  if (h) { e.stopPropagation(); openHelp(h.dataset.help); return; }
  const d = e.target.closest('.qp-def');
  if (d) { setQuickStyle(qStyle); renderPicker(); return; }
  const o = e.target.closest('.qp-opt');
  if (o) switchQuick(o.dataset.qs);
}
/* Справка: любой клик (в том числе по ней), прокрутка или Esc — закрыть
   справку (окно режимов при этом остаётся, если клик был в нём) */
const helpCloser = e => { if (e.type !== 'keydown' || e.key === 'Escape') closeHelp(); };
function openHelp(id) {
  helpFor = id;
  renderPicker();
  setTimeout(() => {
    if (!helpFor) return;
    ['pointerdown', 'wheel', 'touchmove'].forEach(t => document.addEventListener(t, helpCloser, { capture: true, passive: true }));
    document.addEventListener('scroll', helpCloser, { capture: true, passive: true });
    document.addEventListener('keydown', helpCloser, true);
  }, 0);
}
function closeHelp(silent) {
  ['pointerdown', 'wheel', 'touchmove', 'scroll'].forEach(t => document.removeEventListener(t, helpCloser, { capture: true }));
  document.removeEventListener('keydown', helpCloser, true);
  if (!helpFor) return;
  helpFor = '';
  if (!silent) renderPicker();
}
/* Смена режима: окно на месте, в панели плавно сменяется содержимое */
let switching = false;
async function switchQuick(st) {
  if (!sheet || switching || st === qStyle || !QUICK_STYLES.some(x => x.id === st)) return;
  qStyle = st;
  renderPicker();
  const alt = $('qAlt');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !alt || !alt.animate) { renderQuick(); return; }
  switching = true;
  try {
    const out = alt.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px)' }],
      { duration: 130, easing: 'ease-in', fill: 'forwards' });
    await out.finished.catch(() => {});
    renderQuick();
    const inn = alt.animate([{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }],
      { duration: 220, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' });
    out.cancel();
    placePicker();
    await inn.finished.catch(() => {});
  } finally { switching = false; }
}
/* Ввод в панели идёт через quick.js; Enter в поле не должен отправлять форму */
sheet?.addEventListener('submit', e => e.preventDefault());
/* ── Универсальный bindDrag для ЛЮБОГО sheet с grip ── */
function attachDragHandlers(sheetEl, gripEl, onClose) {
  if (!sheetEl || !gripEl) return;
  let startY = 0, dy = 0, activeDrag = false;
  gripEl.addEventListener('pointerdown', e => {
    activeDrag = true;
    dy = 0;
    startY = e.clientY;
    gripEl.setPointerCapture(e.pointerId);
    sheetEl.classList.add('drag');
    gripEl.classList.add('dragging');
  });
  gripEl.addEventListener('pointermove', e => {
    if (!activeDrag) return;
    dy = e.clientY - startY;
    if (dy > 0) {
      sheetEl.style.transform = `translate(-50%, ${dy}px)`;
    }
  });
  const finish = () => {
    if (!activeDrag) return;
    activeDrag = false;
    sheetEl.classList.remove('drag');
    gripEl.classList.remove('dragging');
    sheetEl.style.transform = '';
    if (dy > 120) onClose();
    dy = 0;
  };
  gripEl.addEventListener('pointerup', finish);
  gripEl.addEventListener('pointercancel', finish);
}
// Привязываем drag к sheet (быстрый ввод)
attachDragHandlers(sheet, $('sheetGrip'), closeSheet);
// Привязываем drag к daySheet (открыть день) — закрытие свайпом вниз
attachDragHandlers(daySheet, daySheet?.querySelector('.grip'), closeDay);
/* ── Композиция редактора (один раз при первом открытии):
   ряд 1: календарь 70% + приоритет 30%;
   тип — во всю ширину;
   ряд 2: таймер 50% + подзадачи 50%;
   теги, ссылки — во всю ширину;
   ряд 3: заметки 60% + файлы 40%. ── */
let editorLaidOut = false;
function ensureEditorLayout() {
  if (!editor || editorLaidOut) return;
  const scroll = editor.querySelector('.ed-scroll');
  if (!scroll) return;
  const cardWith = id => { const el = $(id); return el ? el.closest('.ed-card') : null; };
  const calCard = cardWith('edCal') || cardWith('edDays');
  const planCard = cardWith('edPlans');
  const prioCard = cardWith('edPrio');
  const timeCard = cardWith('edSessions');
  const subCard = cardWith('edSub');
  const notesCard = cardWith('edNotes');
  const filesCard = cardWith('edFiles');
  if (!calCard || !prioCard) return;
  const row1 = document.createElement('div');
  row1.className = 'ed-row ed-row-cal';
  scroll.insertBefore(row1, planCard || calCard);
  /* «Планирование» стоит слева от календаря */
  if (planCard) row1.appendChild(planCard);
  row1.appendChild(calCard);
  row1.appendChild(prioCard);
  if (timeCard && subCard) {
    const row2 = document.createElement('div');
    row2.className = 'ed-row ed-row-half';
    scroll.insertBefore(row2, timeCard);
    row2.appendChild(timeCard);
    row2.appendChild(subCard);
  }
  if (notesCard && filesCard) {
    const row3 = document.createElement('div');
    row3.className = 'ed-row ed-row-notes';
    scroll.insertBefore(row3, notesCard);
    row3.appendChild(notesCard);
    row3.appendChild(filesCard);
  }
  const h = calCard.querySelector('h4');
  if (h) h.textContent = 'Календарь';
  editorLaidOut = true;
}
function openEditor(task) {
  editId = task.id;
  const et = $('edTitle');
  if (et) { et.value = task.title; growEl(et); }
  const en = $('edNotes');
  if (en) { en.value = task.notes || ''; growEl(en); }
  ensureEditorLayout();
  renderEditor();
  if (editor) editor.classList.add('open');
  refreshBackdrop();
}
export function closeEditor() {
  if (editor) editor.classList.remove('open');
  refreshBackdrop();
  editId = null;
}
/* ── Блок «Планирование» ──
   Строка на каждый день: во сколько задача начинается и заканчивается
   в таймлайне. Автоматические строки (выведенные из завершённых
   сессий фокусировки) помечены и превращаются в ручные, как только их
   правят. Сессии разных дней дают разные строки — по одной на день. */
function renderEdPlans(t) {
  const box = $('edPlans');
  if (!box) return;
  const plans = taskPlans(t);
  const dayOpts = Object.keys(t.days || {}).sort();
  box.innerHTML = plans.length ? plans.map(p => `<div class="plan-row" data-date="${esc(p.date)}">
      <span class="plan-date">${+p.date.slice(8)} ${MONTHS[+p.date.slice(5, 7) - 1]}${p.auto ? '<i class="plan-auto" title="Из сессий фокусировки">авто</i>' : ''}</span>
      <input class="plan-t plan-s" type="time" step="300" value="${esc(p.start)}">
      <span class="plan-dash">–</span>
      <input class="plan-t plan-e" type="time" step="300" value="${esc(p.end || p.start)}">
      <button type="button" class="plan-del" title="Убрать строку">✕</button>
    </div>`).join('')
    : '<p class="plan-empty">Пока не запланирована. Добавьте строку или запустите таймер фокусировки — время подставится само.</p>';

  box.querySelectorAll('.plan-row').forEach(row => {
    const date = row.dataset.date;
    const commit = async () => {
      const s = row.querySelector('.plan-s').value || '09:00';
      let e = row.querySelector('.plan-e').value || s;
      if (hmToMin(e) <= hmToMin(s)) e = minToHM(hmToMin(s) + 30);
      await setTaskPlan(editId, date, s, e);
      renderEditor();
    };
    row.querySelector('.plan-s').onchange = commit;
    row.querySelector('.plan-e').onchange = commit;
    row.querySelector('.plan-del').onclick = async () => {
      await removeTaskPlan(editId, date);
      renderEditor();
    };
  });
  const add = $('edPlanAdd');
  if (add) add.onclick = async () => {
    const free = dayOpts.find(d => !plans.some(p => p.date === d)) || dayOpts[0] || today();
    await setTaskPlan(editId, free, '09:00', '10:00');
    renderEditor();
  };
}
function renderEditor() {
  const t = getTask(editId);
  if (!t) return;
  renderEdDays(t);
  renderEdPlans(t);
  renderEdPrio(t);
  renderEdType(t);
  renderEdSub(t);
  renderEdTime(t);
  renderEdTags(t);
  renderEdNotesLinks(t);
  renderEdFiles(t);
}
/* ── Календарь редактора: барабан как инлайн в липкой шапке,
   но без полосок под числами; выбранные дни подсвечены.
   ВАЖНО: #edCal в разметке приходит с hidden — снимаем его ДО постройки
   барабана, иначе месяцы измеряются нулевой высотой и календарь не виден. ── */
function renderEdDays(t) {
  const ec = $('edCal');
  if (!ec) return;
  ec.hidden = false;
  if (!edDrum) {
    ec.innerHTML =
      '<div class="cal-head"><span class="cal-title" title="К текущему месяцу"></span></div>' +
      '<div class="cal-m-week">' + ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((w, i) => `<span class="${i >= 5 ? 'we' : ''}">${w}</span>`).join('') + '</div>' +
      '<div class="ed-drum"></div>';
    edDrum = createCalDrum(ec.querySelector('.ed-drum'), {
      cellH: 28,
      week: false,
      markDay: d => (((getTask(editId) || {}).days || {})[d] ? 'on' : ''),
      onDay: d => {
        const task = getTask(editId);
        if (!task) return;
        const days = { ...(task.days || {}) };
        if (days[d]) delete days[d];
        else days[d] = 'todo';
        updateTask(editId, { days }).then(() => {
          edDrum.refresh();
          renderAll();
        });
      },
      onCenter: a => {
        const ti = ec.querySelector('.cal-title');
        if (ti) ti.textContent = calTitle(a);
      },
    });
    const ti = ec.querySelector('.cal-title');
    if (ti) {
      ti.textContent = calTitle(edDrum.currentMonth());
      ti.onclick = () => { edDrum.goCurrent(); edDrum.refresh(); };
    }
  } else {
    edDrum.refresh();
  }
}
function renderEdPrio(t) {
  const fp = $('edPrio');
  if (!fp) return;
  fp.innerHTML = '';
  for (const [v, l] of Object.entries(PRIORITY_LABEL)) {
    fp.appendChild(mkChip(l, t.priority === +v, 'pr' + v, async () => {
      await updateTask(editId, { priority: +v });
      renderEditor();
      renderAll();
    }));
  }
}
function renderEdType(t) {
  const e = $('edType');
  if (!e) return;
  e.innerHTML = '';
  for (const [v, l] of Object.entries(TYPE_LABEL)) {
    e.appendChild(mkChip(l, t.type === v, '', async () => {
      await updateTask(editId, { type: v });
      renderEditor();
      renderAll();
    }));
  }
}
function renderEdSub(t) {
  const box = $('edSub');
  if (!box) return;
  box.innerHTML = '';
  (t.subtasks || []).forEach(s => {
    const row = document.createElement('div');
    row.className = 'sub-row';
    const tog = document.createElement('button');
    tog.type = 'button';
    tog.className = 'cell sub ' + (s.done ? 'c-done' : 'c-todo');
    tog.title = s.done ? 'Выполнено' : 'Запланировано';
    tog.onclick = async () => {
      await toggleSubtask(t.id, s.id);
      renderEdSub(getTask(t.id));
      renderAll();
    };
    const nm = document.createElement('span');
    nm.className = 'sub-text' + (s.done ? ' done' : '');
    nm.textContent = s.text;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'sub-del';
    del.textContent = '✕';
    del.title = 'Удалить подзадачу';
    del.onclick = async () => {
      await delSubtask(t.id, s.id);
      renderEdSub(getTask(t.id));
      renderAll();
    };
    row.append(tog, nm, del);
    box.appendChild(row);
  });
}
async function edAddSub() {
  const inp = $('edSubInput');
  if (!inp) return;
  const v = inp.value.trim();
  if (!v) return;
  await addSubtask(editId, v);
  inp.value = '';
  const task = getTask(editId);
  if (task) renderEdSub(task);
  renderAll();
}
on('edSubAdd', 'click', edAddSub);
on('edSubInput', 'keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); edAddSub(); }
});
function renderEdTime(t) {
  const box = $('edSessions');
  if (!box) return;
  box.innerHTML = '';
  // Чип запуска/остановки таймера прямо в карточке
  const run = tm.activeFor(t.id);
  const chipRow = document.createElement('div');
  chipRow.className = 'chip-row';
  chipRow.appendChild(mkChip(run ? '⏹ Остановить таймер' : '▶ Таймер', run, '', async () => {
    if (tm.activeFor(t.id)) await tm.stop();
    else tm.start(t.id);
    renderEdTime(getTask(editId));
  }));
  box.appendChild(chipRow);
  const sess = t.sessions || [];
  if (sess.length) {
    let total = 0;
    sess.slice().reverse().forEach(s => {
      total += s.min || 0;
      const dm = `${s.date.slice(8, 10)}.${s.date.slice(5, 7)}`;
      const row = document.createElement('div');
      row.className = 'time-session';
      row.textContent = `${dm} с ${s.start} до ${s.end} (${s.min} мин)`;
      box.appendChild(row);
    });
    const tot = document.createElement('div');
    tot.className = 'time-total';
    tot.textContent = `Итого: ${total} мин`;
    box.appendChild(tot);
  } else {
    const dim = document.createElement('div');
    dim.className = 'time-session dim';
    dim.textContent = 'Нет завершённых таймеров';
    box.appendChild(dim);
  }
}
function renderEdTags(t) {
  const e = $('edTags');
  if (!e) return;
  e.innerHTML = '';
  (t.tags || []).forEach(name => {
    const c = getTagColor(name);
    const b = mkChip(name, true, 'tag', async () => {
      await updateTask(editId, { tags: (t.tags || []).filter(x => x !== name) });
      renderEditor();
      renderAll();
    });
    if (c) b.style.setProperty('--tc', c);
    e.appendChild(b);
  });
  getTagsDict().forEach(tg => {
    if ((t.tags || []).includes(tg.name)) return;
    const b = mkChip(tg.name, false, 'tag dim', async () => {
      await updateTask(editId, { tags: [...(t.tags || []), tg.name] });
      renderEditor();
      renderAll();
    });
    if (tg.color) b.style.setProperty('--tc', tg.color);
    e.appendChild(b);
  });
  const inp = $('edTagInput');
  if (!inp) return;
  inp.value = '';
  inp.onkeydown = async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = inp.value.trim();
    if (!v) return;
    await addTagsToDict([v]);
    await updateTask(editId, { tags: [...(t.tags || []), v] });
    renderEditor();
    renderAll();
  };
}
function renderEdNotesLinks(t) {
  const box = $('edLinks');
  if (!box) return;
  box.innerHTML = '';
  ((t.notes || '').match(/https?:\/\/[^\s]+/g) || []).forEach(u => {
    const a = document.createElement('a');
    a.className = 'chip link';
    a.href = u;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = u.replace(/^https?:\/\//, '').slice(0, 34);
    box.appendChild(a);
  });
}
let fileInput = null, uploading = false;
function getFileInput() {
  if (fileInput) return fileInput;
  fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.name = 'taskFile';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f || !editId) return;
    uploading = true;
    const task = getTask(editId);
    if (task) renderEdFiles(task);
    try { await attachFile(editId, f); }
    catch (err) { alert(err.message); }
    uploading = false;
    const t2 = getTask(editId);
    if (t2) renderEdFiles(t2);
    renderAll();
  });
  return fileInput;
}
function renderEdFiles(t) {
  const box = $('edFiles');
  if (!box) return;
  box.innerHTML = '';
  (t.files || []).forEach(f => {
    const row = document.createElement('div');
    row.className = 'file-line';
    const nm = document.createElement('span');
    nm.className = 'fl-name';
    nm.title = f.name;
    nm.textContent = `📎 ${f.name}`;
    const sz = document.createElement('i');
    sz.textContent = fmtSize(f.size || 0);
    nm.appendChild(sz);
    const openB = document.createElement('button');
    openB.type = 'button';
    openB.className = 'fl-btn';
    openB.textContent = 'Открыть';
    openB.onclick = () => openTaskFile(f).catch(err => alert('Не удалось открыть: ' + err.message));
    const delB = document.createElement('button');
    delB.type = 'button';
    delB.className = 'fl-btn del';
    delB.textContent = '✕';
    delB.title = 'Удалить файл';
    delB.onclick = async () => {
      try {
        await removeTaskFile(t.id, f.id);
        const t2 = getTask(t.id);
        if (t2) renderEdFiles(t2);
        renderAll();
      } catch (err) { alert('Не удалось удалить: ' + err.message); }
    };
    row.append(nm, openB, delB);
    box.appendChild(row);
  });
  if (uploading) {
    const up = document.createElement('div');
    up.className = 'file-uploading';
    up.innerHTML = '<span class="upload-spin"></span><span>Загрузка…</span>';
    box.appendChild(up);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'chip';
  add.textContent = '＋ Прикрепить файл';
  add.onclick = () => { if (!uploading) getFileInput().click(); };
  box.appendChild(add);
  const note = limitNote();
  if (note) {
    const hint = document.createElement('p');
    hint.className = 'file-limit';
    hint.textContent = '⚠ ' + note;
    box.appendChild(hint);
  }
}
on('edTitle', 'input', e => {
  if (editId) {
    updateTask(editId, { title: e.target.value });
    growEl(e.target);
  }
});
on('edNotes', 'input', e => {
  if (editId) {
    updateTask(editId, { notes: e.target.value });
    growEl(e.target);
    const t = getTask(editId);
    if (t) renderEdNotesLinks(t);
  }
});
on('edCancel', 'click', closeEditor);
on('edConfirm', 'click', async () => {
  const t = getTask(editId);
  if (!t) return;
  await updateTask(editId, {
    title: $('edTitle')?.value.trim() || t.title,
    notes: $('edNotes')?.value || ''
  });
  closeEditor();
  renderAll();
});
on('edDelete', 'click', async () => {
  if (editId && confirm('Удалить задачу?')) {
    await removeTask(editId);
    closeEditor();
    renderAll();
  }
});
