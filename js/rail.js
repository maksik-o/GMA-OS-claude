/* ══════════════ МЕНЮ-КАРУСЕЛЬ (iPhone) ══════════════
   Полоса иконок у левого края. Край экрана плавно изгибается вокруг
   неё «плечами» сверху и снизу. Выбранный раздел — в глянцевой пилюле.
   Коснулся полосы — пилюля вытягивается и показывает подпись раздела
   под пальцем; ведёшь пальцем — пилюля едет за ним, соседние иконки
   по-барабанному растут и гаснут к краям; отпустил — раздел выбран.
   Простой тап — сразу выбор. Только на телефоне. */
import { state, hapticLight } from './store.js';
import { openSearch } from './search.js';

const mqMobile = matchMedia('(max-width: 720px)');
const ITEM = 46;            // шаг иконок
const SHOULDER = 54;        // высота «плеча» изгиба
const W = 46;               // ширина полосы
const ICON = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  week: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.2 1.2L6.8 5M3.5 12l1.2 1.2 2.1-2.2M3.5 18l1.2 1.2 2.1-2.2"/>',
  kb: '<path d="M5 4h11a3 3 0 0 1 3 3v13H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h12"/>',
  finance: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 15h2"/>',
  contacts: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M17 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
};
const ITEMS = [
  { id: 'home', label: 'Главная', view: 'home' },
  { id: 'week', label: 'Задачи', view: 'week' },
  { id: 'kb', label: 'База', view: 'kb' },
  { id: 'finance', label: 'Финансы', view: 'finance' },
  { id: 'contacts', label: 'Люди', view: 'contacts' },
  { id: 'search', label: 'Поиск', act: () => openSearch() },
  { id: 'settings', label: 'Настройки', act: () => document.getElementById('settingsBtn')?.click() },
];
const svg = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

let rail = null, pill = null, label = null, icons = [];
let cur = 0;          // индекс выбранного раздела
let drag = null;

const H = () => ITEMS.length * ITEM;
const yOf = i => SHOULDER + i * ITEM + ITEM / 2;          // центр иконки в координатах полосы
const idxAt = y => Math.max(0, Math.min(ITEMS.length - 1, Math.floor((y - SHOULDER) / ITEM)));

function shape() {
  /* полоса с «плечами»: от края экрана плавно наружу и обратно */
  const h = H() + SHOULDER * 2, s = SHOULDER;
  return `<svg class="rl-bg" width="${W + 2}" height="${h}" viewBox="0 0 ${W + 2} ${h}" aria-hidden="true">
    <path d="M0 0 C0 ${s * .55} ${W} ${s * .42} ${W} ${s} L${W} ${h - s} C${W} ${h - s * .42} 0 ${h - s * .55} 0 ${h} Z" class="rl-fill"/>
    <path d="M0 0 C0 ${s * .55} ${W} ${s * .42} ${W} ${s} L${W} ${h - s} C${W} ${h - s * .42} 0 ${h - s * .55} 0 ${h}" class="rl-edge"/>
  </svg>`;
}
function build() {
  if (rail) return;
  rail = document.createElement('nav');
  rail.className = 'rail';
  rail.setAttribute('aria-label', 'Разделы');
  rail.innerHTML = shape() +
    `<div class="rl-pill"><span class="rl-pico"></span><span class="rl-lab"></span></div>` +
    ITEMS.map((it, i) => `<button type="button" class="rl-it" data-i="${i}" style="top:${yOf(i) - ITEM / 2}px" aria-label="${it.label}" title="${it.label}">${svg(it.id)}</button>`).join('');
  rail.style.height = (H() + SHOULDER * 2) + 'px';
  document.body.appendChild(rail);
  pill = rail.querySelector('.rl-pill');
  label = rail.querySelector('.rl-lab');
  icons = [...rail.querySelectorAll('.rl-it')];
  rail.addEventListener('pointerdown', onDown);
  rail.addEventListener('click', e => e.preventDefault());
  /* клавиатура: обычные кнопки */
  rail.addEventListener('keydown', e => {
    const b = e.target.closest('.rl-it');
    if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(+b.dataset.i); }
  });
}
function placePill(y, open, i) {
  const it = ITEMS[i];
  pill.querySelector('.rl-pico').innerHTML = svg(it.id);
  label.textContent = it.label;
  pill.classList.toggle('open', !!open);
  /* раскрытая пилюля — по длине подписи */
  const ph = open ? Math.max(ITEM, 30 + it.label.length * 8.2) : 40;
  pill.style.height = ph + 'px';
  pill.style.transform = `translate(-50%, ${y - ph / 2}px)`;
}
function drum(y) {
  icons.forEach((b, i) => {
    if (y == null) { b.style.transform = ''; b.style.opacity = ''; b.classList.remove('under'); return; }
    const d = Math.abs(yOf(i) - y);
    const k = Math.max(0, 1 - d / (ITEM * 3.2));
    b.style.transform = `translateX(-50%) scale(${(0.78 + 0.32 * k).toFixed(3)})`;
    b.style.opacity = (0.25 + 0.75 * k).toFixed(3);
    b.classList.toggle('under', d < ITEM * .9);
  });
}
function sync() {
  if (!rail) return;
  const i = ITEMS.findIndex(x => x.view === state.view);
  if (i >= 0) cur = i;
  if (drag) return;
  placePill(yOf(cur), false, cur);
  icons.forEach((b, j) => b.classList.toggle('under', j === cur));
}
function choose(i) {
  const it = ITEMS[i];
  if (it.act) { it.act(); placePill(yOf(cur), false, cur); icons.forEach((b, j) => b.classList.toggle('under', j === cur)); return; }
  cur = i;
  placePill(yOf(i), false, i);
  icons.forEach((b, j) => b.classList.toggle('under', j === i));
  if (state.view !== it.view) document.dispatchEvent(new CustomEvent('go-view', { detail: it.view }));
}

function onDown(e) {
  if (e.button > 0) return;
  e.preventDefault();
  const r = rail.getBoundingClientRect();
  const y0 = e.clientY - r.top;
  drag = { top: r.top, i: idxAt(y0), moved: false, sy: e.clientY, t: performance.now() };
  rail.classList.add('held');
  pill.classList.add('follow');
  placePill(clampY(y0), true, drag.i);
  drum(y0);
  hapticLight();
  try { rail.setPointerCapture(e.pointerId); } catch (_) {}
  const move = ev => {
    const y = ev.clientY - drag.top;
    if (Math.abs(ev.clientY - drag.sy) > 4) drag.moved = true;
    const i = idxAt(y);
    if (i !== drag.i) { drag.i = i; hapticLight(); }
    placePill(clampY(y), true, i);
    drum(y);
  };
  const up = () => {
    rail.removeEventListener('pointermove', move);
    rail.removeEventListener('pointerup', up);
    rail.removeEventListener('pointercancel', up);
    rail.classList.remove('held');
    pill.classList.remove('follow');
    drum(null);
    const i = drag.i;
    drag = null;
    choose(i);
  };
  rail.addEventListener('pointermove', move);
  rail.addEventListener('pointerup', up);
  rail.addEventListener('pointercancel', up);
}
const clampY = y => Math.max(yOf(0), Math.min(yOf(ITEMS.length - 1), y));

function apply() {
  const on = mqMobile.matches;
  document.body.classList.toggle('has-rail', on);
  if (on) { build(); sync(); }
}
export function railSync() { if (mqMobile.matches) sync(); }
export function railInit() {
  apply();
  if (mqMobile.addEventListener) mqMobile.addEventListener('change', apply);
}
