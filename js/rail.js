/* ══════════════ МЕНЮ-КАРУСЕЛЬ (iPhone) ══════════════
   Полоса иконок у ПРАВОГО края — под большой палец, над кнопкой «+».
   Край экрана плавно изгибается вокруг неё «плечами» сверху и снизу.
   Фон — абсолютно чёрный (#000): на OLED эти пиксели просто выключены.
   Выбранный раздел — в глянцевой пилюле. Коснулся полосы — пилюля
   вытягивается и показывает подпись раздела под пальцем; ведёшь пальцем —
   пилюля едет за ним, соседние иконки по-барабанному растут и гаснут к
   краям; отпустил — раздел выбран. Простой тап — сразу выбор.

   Три размера:
   • обычный — все иконки, полный шаг;
   • над панелью ввода — полоса сжимается по высоте и встаёт над панелью;
   • при открытом окне режимов — размером с шапку, видна только иконка
     открытого раздела.
   Форма — три части (верхнее плечо, тело, нижнее плечо), размеры меняются
   через transform: Safari не анимирует путь SVG, а так всё плавно. */
import { state, hapticLight } from './store.js';
import { openSearch } from './search.js';
import { safeInsets, RAIL_MINI_H } from './safe.js';

const mqMobile = matchMedia('(max-width: 720px)');
const STEP = 46;            // шаг иконок в обычном размере
const S = 54;               // высота «плеча» изгиба (в обычном размере)
const W = 46;               // ширина полосы
const R = W + 2;            // ширина холста плеча (край экрана — справа)
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

let rail = null, pill = null, label = null, icons = [], capT = null, capB = null, body = null;
let cur = 0;          // индекс выбранного раздела
let drag = null;
/* текущая геометрия: k — масштаб плеч, step — шаг иконок, mini — одна иконка */
let geo = { k: 1, step: STEP, mini: false, sc: 1 };

const top0 = () => S * geo.k;                                   // где начинаются иконки
const yOf = i => top0() + (geo.mini ? 0 : i) * geo.step + geo.step / 2;
const idxAt = y => Math.max(0, Math.min(ITEMS.length - 1, Math.floor((y - top0()) / geo.step)));
const clampY = y => Math.max(yOf(0), Math.min(yOf(ITEMS.length - 1), y));

function build() {
  if (rail) return;
  rail = document.createElement('nav');
  rail.className = 'rail';
  rail.setAttribute('aria-label', 'Разделы');
  /* плечи: изгиб от края экрана (справа) внутрь и обратно */
  rail.innerHTML =
    `<svg class="rl-cap rl-cap-t" width="${R}" height="${S}" viewBox="0 0 ${R} ${S}" preserveAspectRatio="none" aria-hidden="true"><path d="M${R} 0C${R} ${S * .55} ${R - W} ${S * .42} ${R - W} ${S}L${R} ${S}Z"/></svg>` +
    `<div class="rl-body"></div>` +
    `<svg class="rl-cap rl-cap-b" width="${R}" height="${S}" viewBox="0 0 ${R} ${S}" preserveAspectRatio="none" aria-hidden="true"><path d="M${R - W} 0C${R - W} ${S * .58} ${R} ${S * .45} ${R} ${S}L${R} 0Z"/></svg>` +
    `<div class="rl-pill"><span class="rl-pico"></span><span class="rl-lab"></span></div>` +
    ITEMS.map((it, i) => `<button type="button" class="rl-it" data-i="${i}" aria-label="${it.label}" title="${it.label}">${svg(it.id)}</button>`).join('');
  document.body.appendChild(rail);
  capT = rail.querySelector('.rl-cap-t');
  capB = rail.querySelector('.rl-cap-b');
  body = rail.querySelector('.rl-body');
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
  watchSheet();
  addEventListener('resize', () => layout());
}

/* ── Размер и место ── */
function sheetState() {
  const sh = document.getElementById('sheet');
  if (!sh || !sh.classList.contains('open')) return { mode: 'full' };
  const pick = document.querySelector('.qpick.open');
  return { mode: pick ? 'mini' : 'compact', top: innerHeight - sh.offsetHeight };
}
function layout() {
  if (!rail || !mqMobile.matches) return;
  const vv = innerHeight;
  const ins = safeInsets(), safeT = ins.t;
  const st = sheetState();
  const n = ITEMS.length;
  let k = 1, step = STEP, mini = false, y;
  if (st.mode === 'mini') {
    /* размером с шапку: одна иконка открытого раздела у верхнего края */
    mini = true; k = .2; step = RAIL_MINI_H - 2 * S * .2;
    y = Math.max(6, safeT + 4);
  } else if (st.mode === 'compact') {
    /* над панелью ввода: сжатые плечи и шаг, чтобы целиком влезть */
    k = .4;
    const lim = Math.max(8, safeT + 8);
    const avail = st.top - 10 - lim;
    step = Math.max(20, Math.min(STEP, (avail - 2 * S * k) / n));
    y = Math.max(lim, st.top - 10 - (2 * S * k + n * step));
  } else {
    /* обычный: низ полосы — над кнопкой «+» (под большим пальцем) */
    const fab = 12 + 48 + 14 + ins.b;
    const h = 2 * S + n * STEP;
    y = Math.max(Math.max(8, safeT + 8), vv - fab - h);
  }
  geo = { k, step, mini, sc: Math.min(1, step / STEP) };
  const bodyH = mini ? step : n * step;
  rail.classList.toggle('rl-lift', st.mode !== 'full');
  rail.classList.toggle('rl-mini', mini);
  rail.style.transform = `translateY(${Math.round(y)}px)`;
  rail.style.height = (2 * S * k + bodyH) + 'px';
  capT.style.transform = `scaleY(${k})`;
  body.style.transform = `translateY(${S * k - .5}px)`;
  body.style.height = (bodyH + 1) + 'px';
  capB.style.transform = `translateY(${S * k + bodyH}px) scaleY(${k})`;
  if (!drag) { drum(null); sync(); }
}
/* панель ввода и окно режимов: открылись, закрылись, сменили высоту */
function watchSheet() {
  const sh = document.getElementById('sheet');
  if (!sh) return;
  let pickWatched = null;
  const mo = new MutationObserver(() => {
    const p = document.querySelector('.qpick');
    if (p && p !== pickWatched) { pickWatched = p; mo.observe(p, { attributes: true, attributeFilter: ['class'] }); }
    layout();
  });
  mo.observe(sh, { attributes: true, attributeFilter: ['class'] });
  new ResizeObserver(() => { if (sh.classList.contains('open')) layout(); }).observe(sh);
}

/* ── Иконки и пилюля ── */
function placePill(y, open, i) {
  const it = ITEMS[i];
  pill.querySelector('.rl-pico').innerHTML = svg(it.id);
  label.textContent = it.label;
  pill.classList.toggle('open', !!open);
  /* раскрытая пилюля — по длине подписи */
  const ph = open ? Math.max(STEP, 30 + it.label.length * 8.2) : 40 * geo.sc;
  pill.style.height = ph + 'px';
  pill.style.transform = `translate(-50%, ${y - ph / 2}px)`;
}
function iconY(i) { return (geo.mini ? yOf(0) : yOf(i)) - STEP / 2; }
function drum(y) {
  icons.forEach((b, i) => {
    const base = `translate(-50%, ${iconY(i)}px)`;
    if (y == null) {
      const hidden = geo.mini && i !== cur;
      b.style.transform = `${base} scale(${hidden ? .4 : geo.sc})`;
      b.style.opacity = hidden ? '0' : '';
      b.style.pointerEvents = hidden ? 'none' : '';
      b.classList.toggle('under', i === cur);
      return;
    }
    const d = Math.abs(yOf(i) - y);
    const k = Math.max(0, 1 - d / (geo.step * 3.2));
    b.style.transform = `${base} scale(${((0.78 + 0.32 * k) * geo.sc).toFixed(3)})`;
    b.style.opacity = (0.25 + 0.75 * k).toFixed(3);
    b.classList.toggle('under', d < geo.step * .9);
  });
}
function sync() {
  if (!rail) return;
  const i = ITEMS.findIndex(x => x.view === state.view);
  if (i >= 0) cur = i;
  if (drag) return;
  placePill(yOf(cur), false, cur);
  drum(null);
}
function choose(i) {
  const it = ITEMS[i];
  if (it.act) { it.act(); sync(); return; }
  cur = i;
  sync();
  if (state.view !== it.view) {
    /* из-под панели ввода — сначала закрыть её */
    const sh = document.getElementById('sheet');
    if (sh && sh.classList.contains('open')) document.getElementById('backdrop')?.click();
    document.dispatchEvent(new CustomEvent('go-view', { detail: it.view }));
  }
}

function onDown(e) {
  if (e.button > 0 || geo.mini) return;
  e.preventDefault();
  const r = rail.getBoundingClientRect();
  const y0 = e.clientY - r.top;
  drag = { top: r.top, i: idxAt(y0), moved: false, sy: e.clientY };
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
    const i = drag.i;
    drag = null;
    drum(null);
    choose(i);
  };
  rail.addEventListener('pointermove', move);
  rail.addEventListener('pointerup', up);
  rail.addEventListener('pointercancel', up);
}

function apply() {
  const on = mqMobile.matches;
  document.body.classList.toggle('has-rail', on);
  if (on) { build(); layout(); }
}
export function railSync() { if (mqMobile.matches) sync(); }
export function railInit() {
  apply();
  if (mqMobile.addEventListener) mqMobile.addEventListener('change', apply);
}
