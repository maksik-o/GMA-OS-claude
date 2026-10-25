/* ══════════════════════════════════════════════════════════════════
   ДВИЖЕНИЕ. Единый язык анимаций приложения (по мотивам «бенто»-
   дашборда): без пружин и отскоков, плавное замедление в конце.

   • Уход: содержимое растворяется — прозрачность, лёгкое размытие и
     чуть уменьшается. Быстро.
   • Появление: из размытия, поднимаясь на несколько пикселей; блоки
     и строки идут каскадом сверху вниз, слева направо.
   • Перерисовка на месте (morph): что осталось — плавно переезжает на
     новое место, новое — проявляется, удалённое — растворяется,
     сменивший вид (статус дня) — коротко «щёлкает».
   • Числа докручиваются, заголовки проявляются слева направо.
   Всё на WAAPI — стили элементов не трогаем, после анимации убирать
   нечего; при «уменьшить движение» анимации выключаются.
   ══════════════════════════════════════════════════════════════════ */
export const EASE = 'cubic-bezier(.22, 1, .36, 1)';      // плавное замедление
export const EASE_IN = 'cubic-bezier(.4, 0, 1, 1)';
export const IN_MS = 440, OUT_MS = 170, STAGGER = 34, MAX_STAGGER = 420;
export const reduced = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const can = el => !!el && !!el.animate && !reduced();
const visible = el => el && el.isConnected && el.getClientRects().length > 0;

/* Размытие красиво, но дорого: браузер перерисовывает размытый слой
   каждый кадр, видеокарта его не берёт. Крупные блоки и окна движутся
   только прозрачностью и сдвигом (их считает видеокарта); лёгкое
   размытие — у мелких строк и только на компьютере. */
const LITE = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
const ENTER_FROM = { opacity: 0, transform: 'translateY(12px) scale(.985)' };
const ENTER_TO = { opacity: 1, transform: 'none' };
const ROW_FROM = LITE ? { opacity: 0, transform: 'translateY(8px)' } : { opacity: 0, transform: 'translateY(8px)', filter: 'blur(3px)' };
const ROW_TO = LITE ? { opacity: 1, transform: 'none' } : { opacity: 1, transform: 'none', filter: 'blur(0)' };

/* Порядок «сверху вниз, слева направо» */
function byPosition(nodes) {
  return nodes.map(n => ({ n, r: n.getBoundingClientRect() }))
    .filter(o => o.r.width > 0 || o.r.height > 0)
    .sort((a, b) => (Math.abs(a.r.top - b.r.top) > 18 ? a.r.top - b.r.top : a.r.left - b.r.left))
    .map(o => o.n);
}

/* ── Уход и появление ── */
export function exit(nodes, opts) {
  const o = opts || {};
  const list = (nodes || []).filter(visible);
  if (!list.length || !can(list[0])) return Promise.resolve([]);
  const anims = list.map(n => n.animate(
    [{ opacity: 1, transform: 'none' },
     { opacity: 0, transform: `translateY(${o.y ?? -6}px) scale(.985)` }],
    { duration: o.duration || OUT_MS, easing: EASE_IN, fill: 'forwards' }));
  return Promise.all(anims.map(a => a.finished.catch(() => {}))).then(() => anims);
}
export function enter(nodes, opts) {
  const o = opts || {};
  const list = byPosition((nodes || []).filter(visible));
  if (!list.length || !can(list[0])) return;
  const step = o.stagger ?? STAGGER;
  const kf = o.rows ? [ROW_FROM, ROW_TO] : [ENTER_FROM, ENTER_TO];
  list.forEach((n, i) => n.animate(kf, {
    duration: o.duration || IN_MS,
    delay: (o.delay || 0) + Math.min(i * step, o.max ?? MAX_STAGGER),
    easing: EASE, fill: 'backwards',
  }));
}
/* Строки внутри появившихся блоков — следом, своим каскадом */
const ROWS = '.r-row, .l-row, .m-task, .task, .kb-col-note, .kb-note, .kb-g, .ftx-row, .fin-card, .fs-card, .cg-person, .contact-card, .hm-soon-row, .hm-nrow, .hm-tile, .hm-row, .tl-block, .kb-card, .notes-item';
export function enterDeep(blocks, opts) {
  const o = opts || {};
  enter(blocks, o);
  if (reduced()) return;
  (blocks || []).forEach((b, bi) => {
    if (!visible(b)) return;
    const rows = [...b.querySelectorAll(ROWS)].slice(0, 16);
    if (rows.length) enter(rows, { delay: 90 + bi * 40, stagger: 26, duration: 380, max: 360, rows: true });
  });
}

/* ── Смена экрана: всё растворяется, перестраивается, проявляется ── */
/* Фазы перехода. Пока старое уходит и новое проявляется, перерисовки по
   уведомлениям стора откладываются до конца: иначе они подменяли бы
   элементы посреди анимации, и новое мелькало без движения. Перерисовки
   самого перехода (фаза apply) идут сразу. */
let phase = '';
const queued = new Map();   // корень → отложенные отрисовки
const root = document.documentElement;
export const isSwapping = () => !!phase;
function flushQueued() {
  const list = [...queued];
  queued.clear();
  list.forEach(([r, fns]) => morph(r, () => fns.forEach(f => f())));
}
function endPhase(ms) {
  phase = 'enter';
  setTimeout(() => { if (phase === 'enter') { phase = ''; flushQueued(); } }, ms);
}
export async function screenSwap(collect, apply) {
  if (phase) { await apply(); return; }
  phase = 'exit';
  try {
    const outs = await exit(collect());
    /* новое держим невидимым до первого кадра появления — без мелькания */
    root.classList.add('m-hold');
    phase = 'apply';
    await apply();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    outs.forEach(a => a.cancel());
    const fresh = collect();
    root.classList.remove('m-hold');
    enterDeep(fresh);
    document.dispatchEvent(new CustomEvent('screen-entered'));
  } finally {
    root.classList.remove('m-hold');
    endPhase(IN_MS + 260);
  }
}

/* ── Перерисовка на месте ──
   Элементы с ключом (data-id [+ data-day]) переживают перерисовку:
   до неё запоминаем их место и вид, после — проигрываем разницу. */
const KEYED = '[data-id], [data-flip]';
const keyOf = el => el.dataset.flip ? 'f:' + el.dataset.flip
  : `${el.dataset.id}|${el.dataset.day || ''}|${(el.getAttribute('class') || '').split(' ')[0]}`;
const LIMIT = 900;        // больше ключевых элементов — перерисовка без движения (дорого мерить)
function snapshot(root) {
  const map = new Map();
  if (!root) return map;
  const all = root.querySelectorAll(KEYED);
  if (all.length > LIMIT) { map.big = true; return map; }
  for (const el of all) {
    const k = keyOf(el);
    if (map.has(k) || !visible(el)) continue;
    map.set(k, { el, r: el.getBoundingClientRect(), cls: el.getAttribute('class') || '' });
  }
  return map;
}
let depth = 0;            // вложенная перерисовка внутри morph — без второго прохода
export function morph(root, render) {
  if (phase === 'exit' || phase === 'enter') {
    const fns = queued.get(root) || [];
    if (!fns.includes(render)) fns.push(render);
    queued.set(root, fns);
    return;
  }
  if (depth || phase || !root || !visible(root) || !can(root)) { render(); return; }
  const before = snapshot(root);
  if (before.big) { render(); return; }             // огромные списки — без подсчётов
  depth++;
  try { render(); } finally { depth--; }
  const after = snapshot(root);
  if (after.big) return;
  const fresh = [];
  for (const [k, a] of after) {
    const b = before.get(k);
    if (!b) { fresh.push(a.el); continue; }
    const dx = b.r.left - a.r.left, dy = b.r.top - a.r.top;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      a.el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 420, easing: EASE });
    } else if (b.cls !== a.cls && !k.startsWith('f:')) {
      pop(a.el);
      if (/\bdone\b/.test(a.cls) && !/\bdone\b/.test(b.cls)) { a.el.classList.add('m-struck'); setTimeout(() => a.el.classList.remove('m-struck'), 700); }
    }
  }
  /* новое — проявляется (если его не слишком много — тогда это смена вида) */
  if (fresh.length && fresh.length <= 40) enter(fresh.filter(el => !fresh.some(p => p !== el && p.contains(el))), { stagger: 24, max: 240, rows: true });
  /* ушедшее — растворяется призраком на старом месте */
  const gone = [...before].filter(([k]) => !after.has(k)).map(([, b]) => b).filter(b => b.r.width > 0);
  if (gone.length && gone.length <= 30) ghosts(gone.filter(g => !gone.some(p => p !== g && p.el.contains(g.el))));
  /* флип-индикаторы (переезжающие пилюли) */
  for (const [k, a] of after) {
    if (!k.startsWith('f:')) continue;
    const b = before.get(k);
    if (!b) continue;
    flipFrom(a.el, b.r);
  }
}
function ghosts(list) {
  const layer = document.createElement('div');
  layer.className = 'anim-ghost-layer';
  for (const g of list) {
    const c = g.el.cloneNode(true);
    Object.assign(c.style, { position: 'fixed', left: g.r.left + 'px', top: g.r.top + 'px', width: g.r.width + 'px', height: g.r.height + 'px', margin: '0', pointerEvents: 'none' });
    layer.appendChild(c);
    c.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }],
      { duration: 260, easing: EASE_IN, fill: 'forwards' });
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 320);
}
/* Короткий «щелчок» — элемент сменил состояние */
export function pop(el) {
  if (!can(el)) return;
  el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)', offset: .35 }, { transform: 'scale(1)' }], { duration: 360, easing: EASE });
}
/* Элемент переезжает со старого места на новое (пилюля-индикатор) */
export function flipFrom(el, from) {
  if (!can(el) || !from) return;
  const to = el.getBoundingClientRect();
  if (!to.width || !from.width) return;
  const dx = from.left - to.left, dy = from.top - to.top;
  const sx = from.width / to.width, sy = from.height / to.height;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < .01) return;
  el.animate([{ transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transformOrigin: '0 0', transform: 'none' }],
    { duration: 460, easing: EASE });
}
/* Содержимое блока сменилось целиком — мягкая подмена */
export function swapContent(el, render) {
  if (!el || !visible(el) || !can(el)) { render(); return; }
  const before = snapshot(el);
  render();
  const after = snapshot(el);
  for (const [k, a] of after) {
    if (!k.startsWith('f:')) continue;
    const b = before.get(k);
    if (b) flipFrom(a.el, b.r);
  }
  el.animate([{ opacity: .3, transform: 'translateY(4px)' }, ENTER_TO], { duration: 300, easing: EASE });
}

/* ── Числа докручиваются ── */
export function countUp(el, opts) {
  if (!el || reduced()) return;
  const txt = el.textContent;
  const m = txt.match(/-?\d[\d\s ]*(?:[.,]\d+)?/);
  if (!m) return;
  const raw = m[0];
  const target = parseFloat(raw.replace(/[\s ]/g, '').replace(',', '.'));
  if (!isFinite(target) || target === 0) return;
  const dec = (raw.split(/[.,]/)[1] || '').length;
  const t0 = performance.now(), dur = (opts && opts.duration) || 700;
  const fmt = v => {
    const s = v.toFixed(dec).replace('.', raw.includes(',') ? ',' : '.');
    return /\s| /.test(raw) ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : s;
  };
  const step = now => {
    const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 4);
    el.textContent = txt.replace(raw, fmt(target * e));
    if (p < 1) requestAnimationFrame(step); else el.textContent = txt;
  };
  requestAnimationFrame(step);
}
/* ── Заголовок проявляется слева направо ── */
export function revealText(el, delay) {
  if (!can(el)) return;
  el.animate([{ clipPath: 'inset(0 100% 0 0)', opacity: .2 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }],
    { duration: 560, delay: delay || 0, easing: EASE, fill: 'backwards' });
}

/* ── Совместимость с прежними вызовами ── */
/* Смена вкладки финансов: блоки растворяются и проявляются каскадом */
export function rowBrickSwap(container, dir, selector, render) {
  if (!container || !can(container)) { render(); return; }
  if (phase) { render(); return; }
  /* нет «кирпичиков» (пустой раздел) — движется само тело раздела */
  const pick = () => {
    const list = [...container.querySelectorAll(selector)].filter(visible);
    if (list.length) return list;
    const body = container.querySelector('.fin-body, .ed-scroll') || container.lastElementChild;
    return body ? [body] : [];
  };
  phase = 'exit';
  exit(pick()).then(outs => {
    root.classList.add('m-hold');
    phase = 'apply';
    try { render(); } finally { phase = ''; }
    outs.forEach(a => a.cancel());
    root.classList.remove('m-hold');
    enterDeep(pick());
    endPhase(IN_MS + 200);
  });
}
/* Листание стрелками: блоки на месте, содержимое мягко подменяется */
export function contentFade(render, opts) {
  const o = opts || {};
  const sel = o.selector || '.pane, .dock-panel, .fin-body, .kanban-panel';
  const nodes = [...document.querySelectorAll(sel)].filter(visible);
  if (phase || !nodes.length || !can(nodes[0])) { render(); return; }
  phase = 'exit';
  const outs = nodes.map(n => n.animate(
    [{ opacity: 1 }, { opacity: 0 }],
    { duration: 140, easing: EASE_IN, fill: 'forwards' }));
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    phase = 'apply';
    try { render(); } finally { phase = ''; }
    outs.forEach(a => a.cancel());
    endPhase(380);
    const now = [...document.querySelectorAll(sel)].filter(visible);
    now.forEach(n => n.animate([{ opacity: 0, transform: 'translateY(6px)' }, ENTER_TO], { duration: 380, easing: EASE }));
    now.forEach((n, bi) => { const rows = [...n.querySelectorAll(ROWS)].slice(0, 14); if (rows.length) enter(rows, { delay: 40 + bi * 30, stagger: 22, duration: 340, max: 300, rows: true }); });
  };
  outs[0].onfinish = go;
  setTimeout(go, 200);
}

/* ── Свежесозданное и удаляемое ── */
const freshIds = new Set();
export function markFresh(id) { freshIds.add(id); setTimeout(() => freshIds.delete(id), 2500); }
/* Новые элементы с только что созданным id — проявляются с подсветкой */
if (typeof MutationObserver !== 'undefined') {
  new MutationObserver(muts => {
    if (!freshIds.size) return;
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      const hits = n.matches && n.matches('[data-id]') ? [n] : [];
      if (n.querySelectorAll) hits.push(...n.querySelectorAll('[data-id]'));
      for (const h of hits) {
        if (!freshIds.has(h.dataset.id) || h.dataset.day) continue;
        requestAnimationFrame(() => {
          if (!can(h) || !visible(h)) return;
          h.animate([{ ...ROW_FROM, boxShadow: '0 0 0 2px var(--accent)' }, { ...ROW_TO, boxShadow: '0 0 0 2px transparent' }], { duration: 700, easing: EASE });
        });
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}
/* Перед удалением — строки задачи растворяются */
export function animateGone(id) {
  const els = [...document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`)].filter(el => visible(el) && !el.dataset.day);
  if (!els.length || !can(els[0])) return Promise.resolve();
  return Promise.all(els.map(el => el.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-10px) scale(.98)' }],
    { duration: 220, easing: EASE_IN, fill: 'forwards' }).finished.catch(() => {})));
}

/* Окно-модалка: подложка гаснет, само окно уходит вниз и растворяется,
   и только потом удаляется из страницы */
export function fadeRemove(ov) {
  if (!ov || !ov.isConnected) return;
  if (ov.dataset.closing) return;
  ov.dataset.closing = '1';
  if (!can(ov)) { ov.remove(); return; }
  ov.style.pointerEvents = 'none';
  const panel = ov.firstElementChild;
  ov.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
  if (panel) panel.animate([{ transform: 'none' }, { transform: 'translateY(14px) scale(.97)' }], { duration: 260, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
  setTimeout(() => ov.remove(), 270);
}
