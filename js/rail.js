/* ══════════════ МЕНЮ (iPhone) ══════════════
   Полоса у правого края на середине высоты экрана, все разделы списком.
   Края экрана плавно изгибаются вокруг неё «плечами»; фон — абсолютно
   чёрный (#000), на OLED эти пиксели выключены.

   Открытый раздел — в пилюле «Огонь» с иконкой и подписью; пилюля
   по размеру содержимого и переезжает на выбранный пункт, соседние
   пункты плавно расступаются.

   Меню убирается само: стоит прокрутить экран, тапнуть или провести
   пальцем по панелям — оно с анимацией уезжает вправо, у края остаётся
   тонкий язычок. Вызвать — свайп от правого края влево (или тап по
   язычку): меню выезжает справа, а блоки, которым оно мешает, плавно
   сужаются и обтекают его. Пока меню спрятано, всё во всю ширину. */
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

let rail = null, pill = null, label = null, pico = null, icons = [], capB = null, body = null, tab = null, meas = null;
let cur = 0;          // раздел в пилюле
let navTarget = null; // раздел, к которому идём: пока экран меняется, пилюля не откатывается
let shown = true;

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
  tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'rail-tab';
  tab.setAttribute('aria-label', 'Показать меню');
  document.body.appendChild(tab);
  capB = rail.querySelector('.rl-cap-b');
  body = rail.querySelector('.rl-body');
  pill = rail.querySelector('.rl-pill');
  label = pill.querySelector('.rl-lab');
  pico = pill.querySelector('.rl-pico');
  meas = rail.querySelector('.rl-meas');
  icons = [...rail.querySelectorAll('.rl-it')];
  rail.addEventListener('click', e => {
    const b = e.target.closest('.rl-it');
    if (b) choose(+b.dataset.i);
  });
  tab.addEventListener('click', () => setShown(true));
  addEventListener('resize', () => layout());
  bindAutoHide();
  bindWrap();
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
  rail.style.top = Math.round((innerHeight - h) / 2) + 'px';
  tab.style.top = Math.round(innerHeight / 2 - 28) + 'px';
  if (label.textContent !== ITEMS[cur].label) { label.textContent = ITEMS[cur].label; pico.innerHTML = svg(ITEMS[cur].id); }
  scheduleWrap(true);
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

/* ── Показать / спрятать ── */
function setShown(on) {
  if (!rail || on === shown) return;
  shown = on;
  rail.classList.toggle('rl-hidden', !on);
  tab.classList.toggle('on', !on);
  wrapOn = on;
  scheduleWrap(true);   // спрятано — блоки во всю ширину, показано — обтекают
  if (on) hapticLight();
}
function bindAutoHide() {
  const app = document.getElementById('app');
  /* прокрутка экрана — меню уезжает */
  if (app) app.addEventListener('scroll', () => { if (shown && !swipe) setShown(false); }, { passive: true });
  /* тап или жест по панелям — тоже */
  document.addEventListener('pointerdown', e => {
    if (!mqMobile.matches) return;
    const edge = e.clientX > innerWidth - 24;
    if (edge && !shown) { swipe = { x: e.clientX, y: e.clientY, id: e.pointerId }; return; }
    if (shown && !rail.contains(e.target) && e.target !== tab) setShown(false);
  }, true);
  /* свайп от правого края влево — меню выезжает */
  document.addEventListener('pointermove', e => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = swipe.x - e.clientX, dy = Math.abs(e.clientY - swipe.y);
    if (dx > 26 && dx > dy * 1.4) { swipe = null; setShown(true); }
    else if (dy > 40) swipe = null;
  }, true);
  const end = () => { swipe = null; };
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
}
let swipe = null;

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
  const tallLim = rail.offsetHeight * .9;
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
  wrapOn = on && shown;
  if (on) { build(); cur = viewIndex(); layout(); }
  else scheduleWrap(true);
}
export function railSync() { if (mqMobile.matches) { sync(); scheduleWrap(true); } }
export function railInit() {
  apply();
  if (mqMobile.addEventListener) mqMobile.addEventListener('change', apply);
}
