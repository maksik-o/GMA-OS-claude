import {
  today, TYPE_LABEL, PRIORITY_LABEL,
  getTagsDict, getTagColor, addTagsToDict, updateTask, removeTask, getTask,
  addSubtask, toggleSubtask, delSubtask,
  esc, MONTHS, taskPlans, setTaskPlan, removeTaskPlan, hmToMin, minToHM,
} from './store.js';
import { attachFile, openTaskFile, removeTaskFile, fmtSize } from './files.js';
import { limitNote } from './attach.js';
import { quickStyle, setQuickStyle, renderQuickAlt, QUICK_STYLES } from './quick.js';
import { skinPanel, BUMP_LEN } from './skin.js';
import { safeInsets, RAIL_MINI_H } from './safe.js';
/* Перерисовка экрана — через общий renderCurrent: пока открыт редактор,
   она откладывается до его закрытия и не рвёт анимации в нём */
const renderAll = () => document.dispatchEvent(new CustomEvent('render-now'));
import { openSched, renderSched } from './edsched.js';
import * as tm from './timer.js';

const $ = id => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const sheet = $('sheet'), editor = $('editor'), daySheet = $('daySheet');
let editId = null;
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
  /* Оформление панели (skin) перечитывается, пока она ещё спрятана: при
     чтении у неё на миг выключены переходы, и если это случалось уже
     после «open», браузер ставил панель на место без анимации. И
     спрятанное положение считаем уже с содержимым — закрытая панель была
     высотой с ручку, «110% высоты» давали сдвиг в пару десятков пикселей. */
  resetPicker();
  if (sheet && !sheet.classList.contains('open')) void sheet.offsetHeight;
  if (sheet) sheet.classList.add('open');
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
let pickAt = 0;   // где на окне пупырка (компьютер): середина панели ввода
let picker = null, pickClip = null, pickerRO = null, helpFor = '', pickOpen = false, tab = null, sheetSkin = null, pickSkin = null;
const CHEV = '<svg class="qp-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
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
  /* Окно живёт в неподвижном контейнере, край которого совпадает с краем
     панели: выезжая, оно появляется из-за этого края, а уезжая — целиком
     скрывается за ним, даже если панель полупрозрачная. Обрезает сам
     контейнер (overflow), без пересчёта на каждом кадре. Контейнер — в
     том же слое, что и панель, чуть ниже неё. */
  pickClip = document.createElement('div');
  pickClip.className = 'qpick-clip';
  (sheet && sheet.parentNode ? sheet.parentNode : document.body).insertBefore(pickClip, sheet || null);
  pickClip.appendChild(picker);
  picker.innerHTML = `<button type="button" class="qp-close" title="Скрыть" aria-label="Скрыть режимы">${CHEV}</button><div class="qp-in"></div>`;
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
  tab.innerHTML = CHEV;
  tab.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openPicker(); });
  if (sheet) sheet.appendChild(tab);
  /* панель и окно рисуются фигурой с пупыркой (skin.js): выпуклость —
     часть края, а не накладка. Пупырка панели — справа по центру
     (компьютер) или сверху у правого угла (телефон); у окна — на краю,
     обращённом к панели. */
  if (sheet) sheetSkin = skinPanel(sheet, (W, H) => (isSide() ? { side: 'right', at: H / 2 } : { side: 'top', at: W - topInset() - BUMP_LEN / 2 }));
  pickSkin = skinPanel(picker, (W, H) => (isSide() ? { side: 'left', at: pickAt || H / 2 } : { side: 'bottom', at: W - topInset() - BUMP_LEN / 2 }));
  /* сменили тему или прозрачность при открытой панели — перечитать стиль
     (не чаще раза в 200 мс; если ничего не поменялось, перерисовки нет) */
  let refT = 0;
  new MutationObserver(() => {
    if (!sheet || !sheet.classList.contains('open')) return;
    clearTimeout(refT);
    refT = setTimeout(refreshSkins, 200);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  if (window.ResizeObserver && sheet) { pickerRO = new ResizeObserver(placePicker); pickerRO.observe(sheet); pickerRO.observe(picker); }
  addEventListener('resize', placePicker);
  return picker;
}
function renderPicker() {
  const p = ensurePicker();
  const def = quickStyle();
  const help = QUICK_STYLES.find(x => x.id === helpFor);
  p.querySelector('.qp-in').innerHTML = `<div class="qp-head">Режим панели</div>
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
  /* панель центрована по области контента (на ПК её сдвигает левое меню) */
  const sl = (innerWidth - sw) / 2 + (parseFloat(getComputedStyle(sheet).marginLeft) || 0);
  const side = isSide();
  picker.classList.toggle('qp-side', side);
  picker.classList.toggle('qp-top', !side);
  if (tab) tab.classList.toggle('qp-tab-top', !side);
  if (side) {
    /* окно не выше панели: выезжает из-под неё целиком (у «Умной строки»
       панель низкая — окно ограничено её высотой, длинная справка тает) */
    picker.style.width = '';
    const maxH = Math.max(150, sh - 16);
    picker.style.maxHeight = '';
    picker.classList.remove('qp-compact');
    /* не влезает в высоту панели — компактные строки без заголовка */
    const pad = parseFloat(getComputedStyle(picker).paddingTop) * 2;
    if (!helpFor && picker.querySelector('.qp-in').offsetHeight + pad > maxH) picker.classList.add('qp-compact');
    /* справке даём больше места: она временная, окно может подрасти */
    picker.style.maxHeight = helpFor ? '' : maxH + 'px';   // справка — целиком
    /* контейнер — справа от края панели до края экрана */
    Object.assign(pickClip.style, { left: (sl + sw) + 'px', top: '0px', right: '0px', bottom: '0px' });
    picker.style.left = GAP_SIDE + 'px';
    picker.style.right = 'auto';
    const ph = picker.offsetHeight, pb = Math.max(8, (sh - ph) / 2);
    picker.style.bottom = pb + 'px';
    /* пупырка окна — на уровне середины панели ввода, даже если окно (со
       справкой) выше панели и сдвинуто: считаем от верха окна */
    const r = pickSkin ? pickSkin.r : [16, 16, 16, 16];
    pickAt = Math.max(r[0] + BUMP_LEN / 2, Math.min(ph - r[3] - BUMP_LEN / 2, ph + pb - sh / 2));
    picker.style.setProperty('--pat', pickAt + 'px');
    picker.style.setProperty('--qp-hide', `translateX(${-(picker.offsetWidth + GAP_SIDE + 24)}px)`);
  } else {
    pickAt = 0;
    picker.style.maxHeight = '';
    picker.classList.remove('qp-compact');
    /* над высокой панелью места мало: окно не должно заезжать под
       статус-бар — тогда компактные строки */
    const avail = innerHeight - sh - GAP_TOP - Math.max(64, safeInsets().t + RAIL_MINI_H + 14);   // сверху — мини-полоса меню
    const padM = parseFloat(getComputedStyle(picker).paddingTop) * 2;
    if (!helpFor && picker.querySelector('.qp-in').offsetHeight + padM > avail) picker.classList.add('qp-compact');
    picker.style.maxHeight = Math.max(140, avail) + 'px';   // выше — не заезжает под мини-полосу меню
    /* на телефоне окно — во всю ширину, как сама панель */
    picker.style.width = sw + 'px';
    /* контейнер — над краем панели до верха экрана */
    Object.assign(pickClip.style, { left: '0px', top: '0px', right: '0px', bottom: sh + 'px' });
    picker.style.left = sl + 'px';
    picker.style.right = 'auto';
    picker.style.bottom = GAP_TOP + 'px';
    picker.style.setProperty('--qp-hide', `translateY(${picker.offsetHeight + GAP_TOP + 24}px)`);
  }
  if (sheetSkin) { sheetSkin.draw(); if (tab) { tab.style.setProperty('--pbw', sheetSkin.bw + 'px'); tab.style.setProperty('--pinset', topInset() + 'px'); } }
  if (pickSkin) { pickSkin.draw(); picker.style.setProperty('--pbw', pickSkin.bw + 'px'); picker.style.setProperty('--pinset', topInset() + 'px'); }
}
/* на телефоне пупырки — у самого правого скругления: панель и окно одной
   ширины, поэтому пупырки друг над другом */
const topInset = () => Math.max(sheetSkin ? sheetSkin.r[1] : 24, pickSkin ? pickSkin.r[2] : 0, 12);
function refreshSkins() {
  if (sheetSkin) sheetSkin.refresh();
  if (pickSkin) pickSkin.refresh();
  placePicker();
}
/* Новое открытие панели: окно спрятано, видна пупырка */
function resetPicker() {
  helpFor = '';
  ensurePicker();
  setPickOpen(false, true);
  renderPicker();
  refreshSkins();
}
function setPickOpen(on, instant) {
  pickOpen = on;
  if (!picker) return;
  if (instant) { picker.classList.add('qp-instant'); requestAnimationFrame(() => picker && picker.classList.remove('qp-instant')); }
  picker.classList.toggle('open', on);
  if (tab) tab.classList.toggle('flat', on);
  /* пупырка панели разглаживается, у окна — вырастает после выезда;
     при закрытии наоборот */
  if (instant) {
    if (sheetSkin) sheetSkin.setBump(!on);
    if (pickSkin) pickSkin.setBump(on);
  } else {
    if (sheetSkin) sheetSkin.setBump(!on, on ? 180 : 260, on ? 0 : 300);
    if (pickSkin) pickSkin.setBump(on, on ? 260 : 140, on ? 420 : 0);
  }
  if (on) armClosers(); else disarmClosers();
}
let opening = false;
function openPicker() {
  if (!sheet || !sheet.classList.contains('open') || pickOpen || opening) return;
  /* сначала отрисовать окно, анимацию запустить следующим кадром: иначе
     на телефоне тяжёлый первый кадр «съедает» начало перехода */
  opening = true;
  renderPicker();
  requestAnimationFrame(() => requestAnimationFrame(() => { opening = false; setPickOpen(true); }));
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
    /* только жесты человека: «scroll» iOS шлёт и сам (клавиатура, подстройка
       экрана) — из-за него окно закрывалось сразу после открытия */
    ['pointerdown', 'wheel', 'touchmove'].forEach(t => document.addEventListener(t, pickCloser, { capture: true, passive: true }));
    document.addEventListener('keydown', pickCloser, true);
    document.addEventListener('input', pickCloser, true);
  }, 0);
}
function disarmClosers() {
  ['pointerdown', 'wheel', 'touchmove'].forEach(t => document.removeEventListener(t, pickCloser, { capture: true }));
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
    document.addEventListener('keydown', helpCloser, true);
  }, 0);
}
function closeHelp(silent) {
  ['pointerdown', 'wheel', 'touchmove'].forEach(t => document.removeEventListener(t, helpCloser, { capture: true }));
  document.removeEventListener('keydown', helpCloser, true);
  if (!helpFor) return;
  helpFor = '';
  if (!silent) renderPicker();
}
/* Смена режима: окно режимов остаётся на месте, а панель ввода уезжает
   вниз и снизу выезжает панель выбранного режима (новая высота панели
   и её фигура пересчитываются, пока она за краем экрана) */
let switching = false;
async function switchQuick(st) {
  if (!sheet || switching || st === qStyle || !QUICK_STYLES.some(x => x.id === st)) return;
  qStyle = st;
  renderPicker();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !sheet.animate) { renderQuick(); return; }
  switching = true;
  try {
    const out = sheet.animate([{ transform: 'translate(-50%, 0)' }, { transform: 'translate(-50%, 110%)' }],
      { duration: 240, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
    await out.finished.catch(() => {});
    renderQuick();
    placePicker();
    await new Promise(r => requestAnimationFrame(r));   // тяжёлый кадр — пока панель за экраном
    const inn = sheet.animate([{ transform: 'translate(-50%, 110%)' }, { transform: 'translate(-50%, 0)' }],
      { duration: 460, easing: 'cubic-bezier(.32, 1.15, .4, 1)', fill: 'backwards' });
    out.cancel();
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
function openEditor(task) {
  editId = task.id;
  const et = $('edTitle');
  if (et) { et.value = task.title; growEl(et); }
  const en = $('edNotes');
  if (en) { en.value = task.notes || ''; growEl(en); }
  openSched(task.id, renderAll);
  renderEditor();
  if (editor) editor.classList.add('open');
  refreshBackdrop();
}
export function closeEditor() {
  if (editor) editor.classList.remove('open');
  document.dispatchEvent(new CustomEvent('editor-closed'));
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
  renderSched();
  renderEdPlans(t);
  renderEdPrio(t);
  renderEdType(t);
  renderEdSub(t);
  renderEdTime(t);
  renderEdTags(t);
  renderEdNotesLinks(t);
  renderEdFiles(t);
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
  const editId0 = editId;
  const title = $('edTitle')?.value.trim() || t.title;
  const notes = $('edNotes')?.value || '';
  /* поля сохраняются по ходу ввода; лишняя запись перерисовала бы экран
     прямо во время анимации закрытия и порвала её */
  closeEditor();
  if (title !== t.title || notes !== (t.notes || '')) setTimeout(() => updateTask(editId0, { title, notes }), 360);
});
on('edDelete', 'click', async () => {
  if (editId && confirm('Удалить задачу?')) {
    await removeTask(editId);
    closeEditor();
    renderAll();
  }
});
