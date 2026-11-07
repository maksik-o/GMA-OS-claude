/* ══════════════ МЕНЮ-КАРУСЕЛЬ (iPhone) ══════════════
   Короткая полоса у правого края, на середине высоты экрана. Края экрана
   плавно изгибаются вокруг неё «плечами». Фон — абсолютно чёрный (#000):
   на OLED эти пиксели выключены.

   В центре — пилюля открытого раздела с подписью; над ней иконка
   предыдущего раздела, под ней — следующего, дальние гаснут. Разделы
   закольцованы. Коснулся полосы и ведёшь пальцем — сквозь неподвижную
   пилюлю проезжают иконки, подпись в ней меняется на раздел, который
   сейчас в пилюле; отпустил — раздел, на котором остановился, и
   открывается, пилюля остаётся на нём (не откатывается к прежнему).
   Тап по соседней иконке — шаг к ней.

   Контент не лежит под полосой: блоки, которые по высоте подходят к
   ней, плавно сужаются, а высокие стеклянные панели получают в правом
   крае плавную выемку — «обтекают» меню; отошли — снова во всю ширину. */
import { state, hapticLight } from './store.js';
import { openSearch } from './search.js';

const mqMobile = matchMedia('(max-width: 720px)');
const STEP = 46;            // шаг иконок
const PILL = 128;           // высота пилюли: иконка раздела и подпись вертикально
const S = 54;               // высота «плеча» изгиба
const W = 46;               // ширина полосы
const R = W + 2;            // ширина холста плеча (край экрана — справа)
const BODY = PILL + 4 * STEP - 26;   // видно пилюлю и по две иконки с каждой стороны
const ICON = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  week: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.2 1.2L6.8 5M3.5 12l1.2 1.2 2.1-2.2M3.5 18l1.2 1.2 2.1-2.2"/>',
  kb: '<path d="M5 4h11a3 3 0 0 1 3 3v13H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h12"/>',
  finance: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 15h2"/>',
  contacts: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M17 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  /* шестерёнка */
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
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
const N = ITEMS.length;
const svg = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
const mod = i => ((i % N) + N) % N;

let rail = null, pill = null, label = null, pico = null, icons = [];
let cur = 0;          // открытый раздел
let pos = 0;          // положение карусели (дробное: между разделами)
let drag = null;
let anim = 0;
let navTarget = null; // раздел, к которому идём: пока экран меняется, пилюля не откатывается
let shownLabel = -1;

function build() {
  if (rail) return;
  rail = document.createElement('nav');
  rail.className = 'rail';
  rail.setAttribute('aria-label', 'Разделы');
  rail.style.height = (2 * S + BODY) + 'px';
  /* плечи: изгиб от края экрана (справа) внутрь и обратно */
  rail.innerHTML =
    `<svg class="rl-cap rl-cap-t" width="${R}" height="${S}" viewBox="0 0 ${R} ${S}" aria-hidden="true"><path d="M${R} 0C${R} ${S * .55} ${R - W} ${S * .42} ${R - W} ${S}L${R} ${S}Z"/></svg>` +
    `<div class="rl-body" style="top:${S - .5}px;height:${BODY + 1}px"></div>` +
    `<svg class="rl-cap rl-cap-b" style="top:${S + BODY}px" width="${R}" height="${S}" viewBox="0 0 ${R} ${S}" aria-hidden="true"><path d="M${R - W} 0C${R - W} ${S * .58} ${R} ${S * .45} ${R} ${S}L${R} 0Z"/></svg>` +
    `<div class="rl-track">${ITEMS.map((it, i) => `<button type="button" class="rl-it" data-i="${i}" aria-label="${it.label}" title="${it.label}">${svg(it.id)}</button>`).join('')}</div>` +
    `<div class="rl-pill" style="top:${S + BODY / 2 - PILL / 2}px;height:${PILL}px" aria-hidden="true"><span class="rl-pico"></span><span class="rl-lab"></span></div>`;
  document.body.appendChild(rail);
  pill = rail.querySelector('.rl-pill');
  label = rail.querySelector('.rl-lab');
  pico = rail.querySelector('.rl-pico');
  icons = [...rail.querySelectorAll('.rl-it')];
  rail.addEventListener('pointerdown', onDown);
  rail.addEventListener('click', e => e.preventDefault());
  /* клавиатура: обычные кнопки */
  rail.addEventListener('keydown', e => {
    const b = e.target.closest('.rl-it');
    if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); spinTo(+b.dataset.i); }
  });
  addEventListener('resize', place);
  bindWrap();
}

/* По центру экрана по высоте */
function place() {
  if (!rail || !mqMobile.matches) return;
  const h = 2 * S + BODY;
  rail.style.transform = `translateY(${Math.round((innerHeight - h) / 2)}px)`;
  scheduleWrap(true);
}

/* ── Карусель ── */
const CY = () => S + BODY / 2;                       // центр пилюли в координатах полосы
/* смещение иконки от центра для относительного индекса k (дробного):
   вплотную к пилюле — на полпилюли, дальше — по шагу */
function offsetOf(k) {
  const a = Math.abs(k), s = Math.sign(k);
  const near = PILL / 2 + STEP / 2 - 4;
  return a <= 1 ? k * near : s * (near + (a - 1) * STEP);
}
/* относительный индекс раздела i при положении p — ближайший по кругу */
function relOf(i, p) {
  let k = i - p;
  k -= Math.round(k / N) * N;
  return k;
}
function render() {
  const cy = CY();
  icons.forEach((b, i) => {
    const k = relOf(i, pos);
    const a = Math.abs(k);
    const y = cy + offsetOf(k) - STEP / 2;
    /* под пилюлей иконку не видно — там подпись; к краям гаснут */
    const op = a < .55 ? 0 : a < 1 ? (a - .55) / .45 : Math.max(0, 1 - (a - 1) * .62);
    const sc = a < 1 ? .85 + .15 * a : Math.max(.7, 1 - (a - 1) * .18);
    b.style.transform = `translate(-50%, ${y.toFixed(1)}px) scale(${sc.toFixed(3)})`;
    b.style.opacity = op.toFixed(3);
    b.style.pointerEvents = op > .3 ? '' : 'none';
    b.tabIndex = op > .3 ? 0 : -1;
  });
  const li = mod(Math.round(pos));
  if (li !== shownLabel) {
    const dir = shownLabel < 0 ? 0 : Math.sign(relOf(li, shownLabel)) || 1;
    shownLabel = li;
    label.textContent = ITEMS[li].label;
    pico.innerHTML = svg(ITEMS[li].id);
    /* иконка и подпись сменяются сдвигом в сторону прокрутки */
    if (dir && label.animate) {
      label.animate([{ transform: `rotate(180deg) translateX(${dir * 14}px)`, opacity: .2 }, { transform: 'rotate(180deg)', opacity: 1 }], { duration: 180, easing: 'ease-out' });
      pico.animate([{ transform: `translateY(${-dir * 10}px)`, opacity: .2 }, { transform: 'none', opacity: 1 }], { duration: 180, easing: 'ease-out' });
    }
  }
}
function viewIndex() { const i = ITEMS.findIndex(x => x.view === state.view); return i < 0 ? cur : i; }
function sync() {
  if (!rail) return;
  if (navTarget) {
    /* экран ещё меняется: пилюля стоит на выбранном, а не откатывается */
    if (state.view === ITEMS[navTarget.i].view || Date.now() - navTarget.t > 2500) navTarget = null;
    else return;
  }
  const i = viewIndex();
  if (drag) return;
  if (i !== cur || Math.abs(pos - cur) > .001) { cur = i; spinPos(nearest(i)); }
}
/* ближайшее к текущему положению «вхождение» раздела i на кольце */
const nearest = i => pos + relOf(i, pos);
function spinPos(to, done) {
  cancelAnimationFrame(anim);
  const from = pos, t0 = performance.now(), dur = Math.min(420, 180 + Math.abs(to - from) * 90);
  if (Math.abs(to - from) < .001 || matchMedia('(prefers-reduced-motion: reduce)').matches) { pos = to; render(); if (done) done(); return; }
  const step = now => {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    pos = from + (to - from) * e;
    render();
    if (p < 1) anim = requestAnimationFrame(step);
    else if (done) done();
  };
  anim = requestAnimationFrame(step);
}
function spinTo(i) { spinPos(nearest(i), () => choose(i)); }
function choose(i) {
  const it = ITEMS[mod(i)];
  if (it.act) {
    /* поиск и настройки — действие, а карусель возвращается к открытому разделу */
    it.act();
    setTimeout(() => spinPos(nearest(cur)), 260);
    return;
  }
  cur = mod(i);
  if (state.view !== it.view) {
    navTarget = { i: cur, t: Date.now() };
    const sh = document.getElementById('sheet');
    if (sh && sh.classList.contains('open')) document.getElementById('backdrop')?.click();
    document.dispatchEvent(new CustomEvent('go-view', { detail: it.view }));
  }
}

function onDown(e) {
  if (e.button > 0) return;
  e.preventDefault();
  cancelAnimationFrame(anim);
  drag = { sy: e.clientY, p0: pos, moved: false, idx: mod(Math.round(pos)), tap: e.target.closest('.rl-it') };
  rail.classList.add('held');
  hapticLight();
  try { rail.setPointerCapture(e.pointerId); } catch (_) {}
  const move = ev => {
    const dy = ev.clientY - drag.sy;
    if (Math.abs(dy) > 5) drag.moved = true;
    if (!drag.moved) return;
    /* палец вверх — снизу въезжают следующие разделы */
    pos = drag.p0 - dy / STEP;
    const idx = mod(Math.round(pos));
    if (idx !== drag.idx) { drag.idx = idx; hapticLight(); }
    render();
  };
  const up = () => {
    rail.removeEventListener('pointermove', move);
    rail.removeEventListener('pointerup', up);
    rail.removeEventListener('pointercancel', up);
    rail.classList.remove('held');
    const d = drag;
    drag = null;
    if (!d.moved) {
      if (d.tap) spinTo(+d.tap.dataset.i);   // тап по соседней иконке
      else render();
      return;
    }
    /* магнит: доезжаем до раздела, на котором остановились, — и он открыт */
    const target = Math.round(pos);
    spinPos(target, () => choose(target));
  };
  rail.addEventListener('pointermove', move);
  rail.addEventListener('pointerup', up);
  rail.addEventListener('pointercancel', up);
}

/* ══ Обтекание ══
   Блоки экрана во всю ширину. Те, что по высоте попадают в полосу меню,
   плавно сужаются (margin-right с переходом). Высокие контейнеры (их
   строки сужаются по отдельности) получают в правом крае выемку той же
   формы, что и плечи полосы, — фон панели не уходит под меню. */
const WRAP_ROOTS = '.topbar, #grid, #dockTop, #dockBottom, #homeView, #kbView, #financeView, #contactsView';
const GAP = 6;
let leaves = [], talls = [], wrapRaf = 0, collectT = 0, wrapOn = false;
function railBand() {
  if (!rail || !rail.offsetWidth || getComputedStyle(rail).visibility === 'hidden') return null;
  const r = rail.getBoundingClientRect();
  return { top: r.top + S * .35, bottom: r.bottom - S * .35, edge: r.right - W - GAP, r };
}
function collectWrap() {
  const oldL = leaves, oldT = talls;
  leaves = []; talls = [];
  if (wrapOn) collectInto();
  /* то, что выпало из списка, — обратно во всю ширину (уже сужённое
     и оставшееся в списке не трогаем, чтобы не мигало) */
  const keepL = new Set(leaves), keepT = new Set(talls);
  oldL.forEach(el => { if (!keepL.has(el)) { clearTimeout(el._relT); ['margin-right', 'max-width', 'height'].forEach(k => el.style.removeProperty(k)); el._wm = 0; el.classList.remove('rl-wrap'); } });
  oldT.forEach(el => { if (!keepT.has(el)) { el.style.clipPath = ''; el._wn = ''; } });
}
function collectInto() {
  const tallLim = (2 * S + BODY) * .9;
  const visit = (el, depth) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (r.height > tallLim && depth < 5) {
      /* обёртки без своей коробки (display: contents — колонки «Главной»
         на телефоне) не блоки: берём их детей */
      const flat = node => [...node.children].flatMap(c => (!c.hidden && getComputedStyle(c).display === 'contents' ? flat(c) : [c]));
      const kids = flat(el).filter(c => {
        if (c.hidden || !c.offsetWidth) return false;
        const cs = getComputedStyle(c);
        if (cs.position === 'absolute' || cs.position === 'fixed' || cs.display === 'none') return false;
        const cr = c.getBoundingClientRect();
        return cr.width > r.width * .55 && cr.height > 16;
      });
      if (kids.length) { talls.push(el); kids.forEach(k => visit(k, depth + 1)); return; }
    }
    leaves.push(el);
  };
  document.querySelectorAll(WRAP_ROOTS).forEach(el => { if (el.offsetWidth && !el.hidden) visit(el, 0); });
  leaves.forEach(el => el.classList.add('rl-wrap'));
}
function updateWrap() {
  wrapRaf = 0;
  const band = wrapOn ? railBand() : null;
  for (const el of leaves) {
    let need = 0;
    /* отступ мог затереть чужой код (раскладка виджетов) — берём фактический */
    const applied = el.style.getPropertyPriority('margin-right') === 'important' ? parseFloat(el.style.marginRight) || 0 : 0;
    if (band) {
      const r = el.getBoundingClientRect();
      const natR = r.right + applied;
      /* зазор: сужённый блок отпускаем чуть позже, чем сужаем, — на границе
         полосы он не переключается туда-сюда */
      const pad = applied ? 14 : 0;
      if (r.bottom > band.top - pad && r.top < band.bottom + pad) need = Math.max(0, Math.ceil(natR - band.edge));
      /* высота при сужении не прыгает: блок держит свою высоту (папки
         не укорачиваются и не выпадают из полосы туда-обратно), а если
         тексту стало тесно — плавно дорастает */
      if (need && !applied) lockHeight(el, r.height);
    }
    if (need !== applied) {
      el._wm = need;
      if (need) {
        el.style.setProperty('margin-right', need + 'px', 'important');
        /* и для блоков с жёсткой шириной (width: 100%) */
        el.style.setProperty('max-width', `calc(100% - ${need}px)`, 'important');
        requestAnimationFrame(() => growToFit(el));
      } else {
        el.style.removeProperty('margin-right');
        el.style.removeProperty('max-width');
        releaseHeight(el);
      }
    }
  }
  for (const el of talls) {
    let cp = '';
    if (band) {
      const r = el.getBoundingClientRect();
      if (r.bottom > band.r.top && r.top < band.r.bottom && r.right > band.edge) {
        /* выемка: от верхнего плеча к нижнему, по форме полосы */
        const x = Math.round(band.edge - r.left), w = Math.round(r.width), h = Math.round(r.height);
        const y0 = Math.round(band.r.top - r.top), y1 = Math.round(band.r.bottom - r.top);
        const yt = y0 + S, yb = y1 - S;
        cp = `path('M0 -2H${w}V${y0}C${w} ${yt - S * .45} ${x} ${y0 + S * .42} ${x} ${yt}V${yb}C${x} ${y1 - S * .42} ${w} ${yb + S * .45} ${w} ${y1}V${h + 2}H0Z')`;
      }
    }
    if (cp !== (el._wn || '')) { el._wn = cp; el.style.clipPath = cp; }
  }
}
function lockHeight(el, h) {
  clearTimeout(el._relT);
  el.style.setProperty('height', h + 'px', 'important');
}
function growToFit(el) {
  if (!el._wm) return;
  /* лишняя строка, которая помещается в нижний отступ блока, его не
     растит — растём, только если текст вышел бы за край */
  const slack = Math.max(0, (parseFloat(getComputedStyle(el).paddingBottom) || 0) - 4);
  const over = el.scrollHeight - el.clientHeight - slack;
  if (over > 1) el.style.setProperty('height', (el.offsetHeight + over) + 'px', 'important');
}
/* расширился — после перехода по ширине плавно к своей высоте */
function releaseHeight(el) {
  if (!el.style.getPropertyValue('height')) return;
  clearTimeout(el._relT);
  el._relT = setTimeout(() => {
    if (el._wm) return;
    const cur = el.offsetHeight;
    el.style.removeProperty('height');
    const nat = el.offsetHeight;
    if (Math.abs(nat - cur) < 2) return;
    el.style.setProperty('height', cur + 'px', 'important');
    void el.offsetHeight;
    el.style.setProperty('height', nat + 'px', 'important');
    el._relT = setTimeout(() => { if (!el._wm) el.style.removeProperty('height'); }, 380);
  }, 370);
}
function scheduleWrap(recollect) {
  if (recollect) {
    clearTimeout(collectT);
    collectT = setTimeout(() => { collectWrap(); updateWrap(); }, 60);
    return;
  }
  if (!wrapRaf) wrapRaf = requestAnimationFrame(updateWrap);
}
function bindWrap() {
  const app = document.getElementById('app');
  if (app) {
    app.addEventListener('scroll', () => scheduleWrap(false), { passive: true });
    /* перестроился экран — пересобрать список блоков */
    new MutationObserver(muts => {
      const blocks = m => [...m.addedNodes, ...m.removedNodes].some(n => n.nodeType === 1);
      if (muts.some(m => m.attributeName === 'hidden' || (m.type === 'childList' && blocks(m)))) scheduleWrap(true);
    }).observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }
  ['screen-entered', 'grid-rendered'].forEach(ev => document.addEventListener(ev, () => scheduleWrap(true)));
  /* страховка: чужой код (раскладка виджетов, перерисовки) мог сбить
     отступы без прокрутки — сверяемся пару раз в секунду */
  setInterval(() => { if (wrapOn && !document.hidden) scheduleWrap(false); }, 450);
}

function apply() {
  const on = mqMobile.matches;
  document.body.classList.toggle('has-rail', on);
  wrapOn = on;
  if (on) { build(); place(); sync(); shownLabel = -1; render(); }
  else scheduleWrap(true);
}
export function railSync() { if (mqMobile.matches) { sync(); scheduleWrap(true); } }
export function railInit() {
  apply();
  if (mqMobile.addEventListener) mqMobile.addEventListener('change', apply);
}
