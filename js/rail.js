/* Постоянное меню поверх контента на узких экранах. */
import { state, hapticLight } from './store.js';

const mqMobile = matchMedia('(max-width: 720px)');
const STEP = 46;            // высота пункта
const S = 54;               // высота «плеча» изгиба
const W = 46;               // ширина полосы
const R = W + 2;            // ширина холста плеча (край экрана — справа)
const PAD = 8;              // запас внутри тела над первым и под последним пунктом
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
let cur = 0;          // раздел в пилюле
let navTarget = null; // раздел, к которому идём: пока экран меняется, пилюля не откатывается
let drag = null;

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
  addEventListener('resize', () => layout());
  bindSelection();
}

/* ── Раскладка: пилюля по содержимому, пункты расступаются ── */
const pillH = i => {
  meas.textContent = ITEMS[i].label;
  return Math.ceil(11 + 18 + 8 + meas.offsetHeight + 14);   // отступ, иконка, зазор, подпись, отступ
};
function layout() {
  if (!rail || !mqMobile.matches) return;
  const ph = pillH(cur);
  const hs = ITEMS.map((_, i) => (i === cur ? ph + 6 : STEP));
  const bodyH = PAD * 2 + hs.reduce((a, b) => a + b, 0);
  const h = 2 * S + bodyH;
  let y = S + PAD;
  icons.forEach((b, i) => {
    const mid = y + hs[i] / 2;
    b.style.transform = `translate(-50%, ${(mid - STEP / 2).toFixed(1)}px)`;
    b.classList.toggle('under', i === cur);
    if (i === cur) { pill.style.transform = `translateY(${(mid - ph / 2).toFixed(1)}px)`; pill.style.height = ph + 'px'; }
    y += hs[i];
  });
  body.style.height = (bodyH + 1) + 'px';
  capB.style.transform = `translateY(${S + bodyH}px)`;
  rail.style.height = h + 'px';
  if (label.textContent !== ITEMS[cur].label) { label.textContent = ITEMS[cur].label; pico.innerHTML = svg(ITEMS[cur].id); }
}
function viewIndex() { const i = ITEMS.findIndex(x => x.view === state.view); return i < 0 ? cur : i; }
function sync() {
  if (!rail || drag) return;
  if (navTarget) {
    /* экран ещё меняется: пилюля стоит на выбранном, а не откатывается */
    if (state.view === ITEMS[navTarget.i].view || Date.now() - navTarget.t > 2500) navTarget = null;
    else return;
  }
  const i = viewIndex();
  if (i !== cur) { cur = i; layout(); }
}
function choose(i) {
  const it = ITEMS[i];
  hapticLight();
  if (it.act) { it.act(); return; }   // поиск и настройки — действие, пилюля остаётся на разделе
  if (i !== cur) { cur = i; layout(); }
  if (state.view !== it.view) {
    navTarget = { i, t: Date.now() };
    const sh = document.getElementById('sheet');
    if (sh && sh.classList.contains('open')) document.getElementById('backdrop')?.click();
    document.dispatchEvent(new CustomEvent('go-view', { detail: it.view }));
  }
}

function bindSelection() {
  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const y = Math.min(drag.centers.at(-1), Math.max(drag.centers[0], e.clientY));
    drag.index = drag.centers.reduce((best, center, i) =>
      Math.abs(center - y) < Math.abs(drag.centers[best] - y) ? i : best, 0);
    const item = ITEMS[drag.index];
    if (label.textContent !== item.label) {
      label.textContent = item.label;
      pico.innerHTML = svg(item.id);
      pill.style.height = pillH(drag.index) + 'px';
    }
    pill.style.transform = `translateY(${y - drag.top - pill.offsetHeight / 2}px)`;
  }
  rail.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0 || drag) return;
    const bounds = rail.getBoundingClientRect();
    const centers = icons.map(button => {
      const rect = button.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    drag = { id: e.pointerId, top: bounds.top, centers, index: cur };
    rail.setPointerCapture(e.pointerId);
    rail.classList.add('rl-selecting');
    move(e);
  });
  rail.addEventListener('pointermove', move);
  function finish(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const commit = e.type === 'pointerup';
    if (commit) move(e);
    const { index } = drag;
    drag = null;
    rail.classList.remove('rl-selecting');
    if (commit) choose(index);
    layout();
  }
  rail.addEventListener('pointerup', finish);
  rail.addEventListener('pointercancel', finish);
  rail.addEventListener('lostpointercapture', finish);
}

function apply() {
  const on = mqMobile.matches;
  document.body.classList.toggle('has-rail', on);
  if (on) { build(); cur = viewIndex(); layout(); }
}
export function railSync() { if (mqMobile.matches) sync(); }
export function railInit() {
  apply();
  if (mqMobile.addEventListener) mqMobile.addEventListener('change', apply);
}
