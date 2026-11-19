/* Постоянное меню поверх контента на узких экранах. */
import { state, hapticLight } from './store.js';

const mqMobile = matchMedia('(max-width: 720px)');
const STEP = 38;            // высота пункта
const S = 32;               // высота «плеча» изгиба
const W = 46;               // ширина полосы
const R = W + 2;            // ширина холста плеча (край экрана — справа)
const PAD = 4;
const LABEL_MS = 3000;
const ICON_HEIGHT = 38;
const wrap = index => (index % ITEMS.length + ITEMS.length) % ITEMS.length;
const ICON = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  week: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.2 1.2L6.8 5M3.5 12l1.2 1.2 2.1-2.2M3.5 18l1.2 1.2 2.1-2.2"/>',
  kb: '<path d="M5 4h11a3 3 0 0 1 3 3v13H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h12"/>',
  finance: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 15h2"/>',
  contacts: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M17 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  /* шестерёнка */
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};
const ITEMS = [
  { id: 'home', label: 'Главная', view: 'home' },
  { id: 'week', label: 'Задачи', view: 'week' },
  { id: 'kb', label: 'База', view: 'kb' },
  { id: 'finance', label: 'Финансы', view: 'finance' },
  { id: 'contacts', label: 'Люди', view: 'contacts' },
  { id: 'settings', label: 'Настройки', act: () => document.getElementById('settingsBtn')?.click() },
];
const svg = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

let rail = null, pill = null, label = null, pico = null, icons = [], capB = null, body = null, meas = null;
let cur = 0;
let lastView = state.view;
let navTarget = null;
let drag = null;
let labelTimer, wheelTimer;
let expanded = false;
let wheelOffset = 0;
let labelHeights = [];

function build() {
  if (rail) return;
  rail = document.createElement('nav');
  rail.className = 'rail';
  rail.setAttribute('aria-label', 'Разделы');
  /* плечи: изгиб от края экрана (справа) внутрь и обратно */
  rail.innerHTML =
    `<svg class="rl-cap rl-cap-t" width="${R}" height="${S}" viewBox="0 0 ${R} ${S}" aria-hidden="true"><path d="M${R} 0C${R} ${S * .55} ${R - W} ${S * .42} ${R - W} ${S}L${R} ${S}Z"/></svg>` +
    `<div class="rl-body" style="top:${S - .5}px"></div>` +
    `<svg class="rl-cap rl-cap-b" width="${R}" height="${S}" viewBox="0 0 ${R} ${S}" aria-hidden="true"><path d="M${R - W} 0C${R - W} ${S * .58} ${R} ${S * .45} ${R} ${S}L${R} 0Z"/></svg>` +
    `<div class="rl-pill" aria-hidden="true"><span class="rl-pico"></span><span class="rl-lab"></span></div>` +
    ITEMS.map((it, i) => `<button type="button" class="rl-it" data-i="${i}" aria-label="${it.label}" title="${it.label}">${svg(it.id)}</button>`).join('') +
    `<span class="rl-lab rl-meas" aria-hidden="true"></span>`;
  document.body.appendChild(rail);
  capB = rail.querySelector('.rl-cap-b');
  body = rail.querySelector('.rl-body');
  pill = rail.querySelector('.rl-pill');
  label = pill.querySelector('.rl-lab');
  pico = pill.querySelector('.rl-pico');
  meas = rail.querySelector('.rl-meas');
  icons = [...rail.querySelectorAll('.rl-it')];
  rail.addEventListener('click', e => {
    const b = e.target.closest('.rl-it');
    if (b && e.detail === 0) choose(+b.dataset.i);
  });
  addEventListener('resize', () => {
    labelHeights = [];
    layout(drag?.position ?? (wheelTimer ? cur + wheelOffset / STEP : cur), !!drag?.moved || !!wheelTimer || expanded);
  });
  bindSelection();
}

/* Пиктограммы идут за пальцем, а подпись меняется в неподвижной пилюле. */
function layout(position = cur, showLabel = expanded, scrolling = false) {
  if (!rail || !mqMobile.matches) return;
  if (!labelHeights.length) {
    labelHeights = ITEMS.map(item => {
      meas.textContent = item.label;
      return Math.max(ICON_HEIGHT, meas.offsetHeight + 16);
    });
  }
  const index = wrap(Math.round(position));
  const ph = showLabel ? labelHeights[index] : ICON_HEIGHT;
  const bodyH = Math.max(...labelHeights) + 4 * STEP + 2 * PAD;
  const center = S + bodyH / 2;
  const half = ITEMS.length / 2;
  icons.forEach((button, i) => {
    const offset = wrap(i - position + half) - half;
    const distance = Math.abs(offset);
    const visible = distance < 2.5;
    const gap = (ph - STEP) / 2 * Math.min(1, distance);
    const y = offset * STEP + Math.sign(offset) * gap;
    const opacity = Math.max(0, Math.min(1, distance * 1.65, (2.5 - distance) * .9));
    button.style.transition = !scrolling && visible && button.style.visibility === 'visible' ? '' : 'none';
    button.style.visibility = visible ? 'visible' : 'hidden';
    button.style.opacity = opacity;
    button.tabIndex = visible ? 0 : -1;
    button.style.transform = `translate(-50%, ${center + y - STEP / 2}px)`;
    button.classList.toggle('under', distance < .01);
    if (ITEMS[i].view === state.view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  body.style.height = (bodyH + 1) + 'px';
  capB.style.transform = `translateY(${S + bodyH}px)`;
  rail.style.height = (2 * S + bodyH) + 'px';
  pill.style.top = center + 'px';
  pill.style.transform = 'translate(-50%, -50%)';
  pill.style.height = ph + 'px';
  label.style.display = showLabel ? '' : 'none';
  pico.style.display = showLabel ? 'none' : '';
  const item = ITEMS[index];
  if (label.textContent !== item.label) {
    label.textContent = item.label;
    pico.innerHTML = svg(item.id);
  }
}
function showLabel(i) {
  clearTimeout(labelTimer);
  cur = i;
  expanded = true;
  layout();
  labelTimer = setTimeout(() => {
    expanded = false;
    if (!drag && !wheelTimer) layout();
  }, LABEL_MS);
}
function sync() {
  if (!rail || drag || wheelTimer) return;
  if (navTarget) {
    if (state.view !== navTarget.view && Date.now() - navTarget.time <= 2500) return;
    navTarget = null;
  }
  if (state.view === lastView) return;
  lastView = state.view;
  const i = ITEMS.findIndex(item => item.view === lastView);
  if (i >= 0 && i !== cur) showLabel(i);
  else layout();
}
function choose(i) {
  const it = ITEMS[i];
  hapticLight();
  showLabel(i);
  if (it.act) { it.act(); return; }
  if (state.view !== it.view) {
    navTarget = { view: it.view, time: Date.now() };
    const sh = document.getElementById('sheet');
    if (sh?.classList.contains('open')) document.getElementById('backdrop')?.click();
    document.dispatchEvent(new CustomEvent('go-view', { detail: it.view }));
  }
}

function bindSelection() {
  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const distance = drag.startY - e.clientY;
    if (!drag.moved && Math.abs(distance) < 7) return;
    drag.moved = true;
    drag.position = cur + distance / STEP;
    layout(drag.position, true, true);
  }
  rail.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0 || drag || wheelTimer) return;
    const button = e.target.closest('.rl-it');
    drag = { id: e.pointerId, startY: e.clientY, position: cur, tap: button ? +button.dataset.i : cur, moved: false };
    rail.setPointerCapture(e.pointerId);
    rail.classList.add('rl-selecting');
  });
  rail.addEventListener('pointermove', move);
  function finish(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const commit = e.type === 'pointerup';
    if (commit) move(e);
    const { position, tap, moved } = drag;
    drag = null;
    rail.classList.remove('rl-selecting');
    if (commit) choose(moved ? wrap(Math.round(position)) : tap);
    else { layout(); sync(); }
  }
  rail.addEventListener('pointerup', finish);
  rail.addEventListener('pointercancel', finish);
  rail.addEventListener('lostpointercapture', finish);

  rail.addEventListener('wheel', e => {
    if (drag || !e.deltaY) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? STEP : 1;
    wheelOffset += e.deltaY * unit;
    const position = cur + wheelOffset / STEP;
    const index = wrap(Math.round(position));
    layout(position, true, true);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelOffset = 0;
      wheelTimer = undefined;
      choose(index);
    }, 160);
  }, { passive: false });
}

function apply() {
  const on = mqMobile.matches;
  document.body.classList.toggle('has-rail', on);
  if (!on) {
    clearTimeout(wheelTimer);
    wheelTimer = undefined;
    wheelOffset = 0;
    drag = null;
    rail?.classList.remove('rl-selecting');
    return;
  }
  build();
  const index = ITEMS.findIndex(item => item.view === state.view);
  if (index >= 0) cur = index;
  lastView = state.view;
  layout();
}
export function railSync() { if (mqMobile.matches) sync(); }
export function railInit() {
  apply();
  if (mqMobile.addEventListener) mqMobile.addEventListener('change', apply);
}
