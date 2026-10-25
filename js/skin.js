/* ══════════════════════════════════════════════════════════════════
   Панель с «пупыркой» — одной фигурой.

   Фон, рамку, тени и внутреннее свечение панели рисует SVG-фигура
   «прямоугольник со скруглениями + выпуклость на одном из краёв», а у
   самой панели они выключены (.pskinned; размытие фона остаётся у неё).
   Так выпуклость — часть края в любой теме и при любой прозрачности.
   Оформление берётся из вычисленного стиля панели в текущей теме.

   Производительность (iPhone): фигура рисуется ТОЛЬКО при смене размера
   или темы. Пупырка — отдельный кусочек снаружи края (заливка, рамка и
   размытие под ней), он плавно проявляется и гаснет; отрезок рамки поперёк
   его основания — наоборот. Заливки панели и пупырки не перекрываются,
   поэтому при смене прозрачность нигде не удваивается (раньше два полных
   слоя на миг накладывались, и панель «подмаргивала»). Жёсткие тени —
   копией формы, без фильтров; размытые — фильтром, но тоже один раз.
   ══════════════════════════════════════════════════════════════════ */
const PAD = 48;          // запас холста вокруг панели: выпуклость и тени
export const BUMP_LEN = 76, BUMP_DEPTH = 20;
let uid = 0;

/* профиль выпуклости вдоль края: −38 … +38 от центра, наружу на d */
function profile(side, c, d, x0, y0, x1, y1) {
  const h = BUMP_LEN / 2;
  const P = (along, out) => {
    if (side === 'top') return `${c + along} ${y0 - out}`;
    if (side === 'right') return `${x1 + out} ${c + along}`;
    if (side === 'bottom') return `${c - along} ${y1 + out}`;
    return `${x0 - out} ${c - along}`;
  };
  return { start: P(-h, 0), end: P(h, 0), body: `C${P(-h + 12, 0)} ${P(-h + 8, d)} ${P(-h + 22, d)}L${P(h - 22, d)}C${P(h - 8, d)} ${P(h - 12, 0)} ${P(h, 0)}` };
}
/* Контур: по часовой стрелке от верхнего левого скругления */
function shapePath(x0, y0, x1, y1, r, bump, gap) {
  const [tl, tr, br, bl] = r.map(v => Math.max(0, Math.min(v, (x1 - x0) / 2, (y1 - y0) / 2)));
  const edge = side => {
    if (!bump || bump.side !== side) return '';
    const p = profile(side, bump.at, bump.d, x0, y0, x1, y1);
    return gap ? `L${p.start}M${p.end}` : `L${p.start}${p.body}`;   // gap — рамка с разрывом под пупыркой
  };
  return `M${x0 + tl} ${y0}${edge('top')}L${x1 - tr} ${y0}` +
    (tr ? `A${tr} ${tr} 0 0 1 ${x1} ${y0 + tr}` : '') + `${edge('right')}L${x1} ${y1 - br}` +
    (br ? `A${br} ${br} 0 0 1 ${x1 - br} ${y1}` : '') + `${edge('bottom')}L${x0 + bl} ${y1}` +
    (bl ? `A${bl} ${bl} 0 0 1 ${x0} ${y1 - bl}` : '') + `${edge('left')}L${x0} ${y0 + tl}` +
    (tl ? `A${tl} ${tl} 0 0 1 ${x0 + tl} ${y0}` : '') + (gap ? '' : 'Z');   // с разрывом Z замкнул бы контур поперёк панели
}
/* только сама выпуклость (для размытия фона под ней) */
function bumpOnly(x0, y0, x1, y1, bump) {
  const p = profile(bump.side, bump.at, bump.d, x0, y0, x1, y1);
  return `M${p.start}${p.body}Z`;
}

function splitList(v) {
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
  const color = (sh.match(/(rgba?\([^)]*\)|color\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]{3,8})/i) || [])[0] || '';
  const [x, y, blur, spread] = (sh.replace(color, '').match(/-?[\d.]+px/g) || []).map(parseFloat).concat([0, 0, 0, 0]);
  const clear = !color || /rgba\([^)]*,\s*0\)|\/\s*0\)/.test(color);
  return { inset: /\binset\b/.test(sh), x, y, blur, spread, color, clear };
}

export function skinPanel(panel, getBump) {
  const id = ++uid;
  const root = document.createElement('div');
  root.className = 'pskin pskin-shown';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `<svg class="pskin-svg"><defs>
      <mask id="pm${id}" maskUnits="userSpaceOnUse"><rect class="pm-all" fill="#fff"/><path class="pm-cut" fill="#000"/></mask>
      <filter id="pb${id}" filterUnits="userSpaceOnUse"></filter>
      <filter id="pi${id}" filterUnits="userSpaceOnUse"></filter>
    </defs>
    <g class="pskin-shadows" mask="url(#pm${id})"></g>
    <path class="pskin-fill"/>
    <path class="pskin-bfill pskin-b"/></svg>
    <div class="pskin-glass pskin-b"></div><div class="pskin-img"></div>
    <svg class="pskin-svg pskin-top"><path class="pskin-line" fill="none"/><path class="pskin-gap" fill="none"/><path class="pskin-bline pskin-b" fill="none"/></svg>`;
  panel.prepend(root);
  const $q = sel => root.querySelector(sel);
  const bumpEls = [...root.querySelectorAll('.pskin-b')];
  const gapEl = $q('.pskin-gap');
  let st = null, shown = true, geomKey = '';

  function read() {
    panel.classList.add('pskin-read');
    panel.classList.remove('pskinned');
    const cs = getComputedStyle(panel);
    const bw = parseFloat(cs.borderTopWidth) || 0;
    let line = '', lw = 0, lineOut = false;
    if (bw > 0 && cs.borderTopStyle !== 'none') { line = cs.borderTopColor; lw = bw; }
    const outer = [], inner = [];
    for (const s of splitList(cs.boxShadow === 'none' ? '' : cs.boxShadow).map(parseShadow)) {
      if (s.clear) continue;
      if (s.inset) { inner.push(s); continue; }
      if (!s.x && !s.y && !s.blur && s.spread > 0) { if (!lw) { line = s.color; lw = s.spread; lineOut = true; } continue; }
      outer.push(s);
    }
    /* сенсорные устройства (iPhone): без размытых SVG-теней и внутреннего
       свечения — они дорогие для Safari и тормозили анимации; рамка и
       жёсткие тени остаются */
    const light = matchMedia('(pointer: coarse)').matches;
    const next = {
      bw, line, lw, lineOut, bg: cs.backgroundColor,
      outer: light ? outer.filter(s => !s.blur && !s.spread) : outer,
      inner: light ? [] : inner,
      bgImg: cs.backgroundImage !== 'none' ? cs.backgroundImage : '',
      backdrop: cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : (cs.webkitBackdropFilter || 'none'),
      r: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(v => parseFloat(v) || 0),
    };
    panel.classList.add('pskinned');
    panel.classList.remove('pskin-read');
    const changed = JSON.stringify(next) !== JSON.stringify(st);
    st = next;
    if (changed) { geomKey = ''; style(); }
  }
  /* оформление — при смене темы, не на каждом кадре */
  function style() {
    /* размытые внешние тени — фильтром; жёсткие — копией формы */
    const blurred = st.outer.filter(s => s.blur > 0 || s.spread);
    let f = '', merge = '';
    blurred.forEach((s, k) => {
      f += `<feOffset in="SourceAlpha" dx="${s.x}" dy="${s.y}" result="o${k}"/>` +
        (s.spread ? `<feMorphology in="o${k}" operator="${s.spread > 0 ? 'dilate' : 'erode'}" radius="${Math.abs(s.spread)}" result="o${k}"/>` : '') +
        `<feGaussianBlur in="o${k}" stdDeviation="${s.blur / 2}" result="b${k}"/><feFlood flood-color="${s.color}"/><feComposite in2="b${k}" operator="in" result="s${k}"/>`;
      merge += `<feMergeNode in="s${k}"/>`;
    });
    $q(`#pb${id}`).innerHTML = blurred.length ? f + `<feMerge>${merge}</feMerge>` : '';
    f = ''; merge = '<feMergeNode in="SourceGraphic"/>';
    st.inner.forEach((s, k) => {
      f += `<feFlood flood-color="${s.color}"/><feComposite in2="SourceAlpha" operator="out" result="v${k}"/>` +
        (s.spread ? `<feMorphology in="v${k}" operator="${s.spread > 0 ? 'dilate' : 'erode'}" radius="${Math.abs(s.spread)}" result="v${k}"/>` : '') +
        `<feOffset in="v${k}" dx="${s.x}" dy="${s.y}" result="w${k}"/><feGaussianBlur in="w${k}" stdDeviation="${Math.max(0.01, s.blur / 2)}" result="g${k}"/>` +
        `<feComposite in="g${k}" in2="SourceAlpha" operator="in" result="i${k}"/>`;
      merge += `<feMergeNode in="i${k}"/>`;
    });
    $q(`#pi${id}`).innerHTML = st.inner.length ? f + `<feMerge>${merge}</feMerge>` : '';
    const fill = $q('.pskin-fill');
    fill.style.fill = st.bg;
    $q('.pskin-bfill').style.fill = st.bg;
    if (st.inner.length) fill.setAttribute('filter', `url(#pi${id})`); else fill.removeAttribute('filter');
    for (const sel of ['.pskin-line', '.pskin-gap', '.pskin-bline']) {
      const l = $q(sel);
      l.style.stroke = st.line || 'transparent';
      l.style.strokeWidth = st.lw;
    }
    const glass = $q('.pskin-glass');
    glass.style.webkitBackdropFilter = glass.style.backdropFilter = st.backdrop;
    const img = $q('.pskin-img');
    img.style.backgroundImage = st.bgImg || 'none';
    img.style.display = st.bgImg ? '' : 'none';
  }
  /* геометрия — только когда меняется размер или место пупырки */
  function draw() {
    if (!st) return;
    const W = panel.offsetWidth, H = panel.offsetHeight;
    const bp = getBump ? getBump(W, H) : null;
    const key = `${W}x${H}:${bp ? bp.side + bp.at : ''}`;
    if (key === geomKey) return;
    geomKey = key;
    const cw = W + PAD * 2, ch = H + PAD * 2;
    const x0 = PAD, y0 = PAD, x1 = PAD + W, y1 = PAD + H;
    root.style.left = root.style.top = `${-st.bw - PAD}px`;
    root.style.width = cw + 'px';
    root.style.height = ch + 'px';
    root.querySelectorAll('svg').forEach(svg => { svg.setAttribute('width', cw); svg.setAttribute('height', ch); svg.setAttribute('viewBox', `0 0 ${cw} ${ch}`); });
    root.querySelectorAll('filter, mask').forEach(f => { f.setAttribute('x', 0); f.setAttribute('y', 0); f.setAttribute('width', cw); f.setAttribute('height', ch); });
    const all = $q('.pm-all');
    all.setAttribute('width', cw); all.setAttribute('height', ch);
    const bump = bp ? { side: bp.side, at: PAD + bp.at, d: BUMP_DEPTH } : null;
    const d = shapePath(x0, y0, x1, y1, st.r, null);
    $q('.pskin-fill').setAttribute('d', d);
    $q('.pm-cut').setAttribute('d', d);   // тени только снаружи фигуры
    /* тени: жёсткие — сдвинутые копии формы, размытые — через фильтр */
    const blurred = st.outer.filter(s => s.blur > 0 || s.spread);
    $q('.pskin-shadows').innerHTML =
      st.outer.filter(s => !(s.blur > 0 || s.spread)).map(s => `<path d="${d}" fill="${s.color}" transform="translate(${s.x} ${s.y})"/>`).join('') +
      (blurred.length ? `<path d="${d}" fill="#000" filter="url(#pb${id})"/>` : '');
    /* пупырка: заливка и размытие фона под ней — только сам выступ */
    const bOnly = bump ? bumpOnly(x0, y0, x1, y1, bump) : '';
    $q('.pskin-bfill').setAttribute('d', bOnly);
    const glass = $q('.pskin-glass');
    glass.style.display = bump && st.backdrop !== 'none' ? '' : 'none';
    if (bump) glass.style.clipPath = `path('${bOnly}')`;
    const img = $q('.pskin-img');
    img.style.clipPath = `path('${d}')`;
    img.style.backgroundSize = `${W}px ${H}px`;
    img.style.backgroundPosition = `${PAD}px ${PAD}px`;
    /* рамка: контур с разрывом под пупыркой + отрезок поперёк разрыва
       (виден, пока пупырки нет) + дуга самой пупырки */
    const k = st.lineOut ? -st.lw / 2 : st.lw / 2;
    const kb = bump ? { side: bump.side, at: bump.at, d: bump.d } : null;
    const rx0 = x0 + k, ry0 = y0 + k, rx1 = x1 - k, ry1 = y1 - k;
    $q('.pskin-line').setAttribute('d', st.lw ? shapePath(rx0, ry0, rx1, ry1, st.r.map(r => Math.max(0, r - k)), kb, true) : '');
    const pr = kb ? profile(kb.side, kb.at, kb.d, rx0, ry0, rx1, ry1) : null;
    gapEl.setAttribute('d', st.lw && pr ? `M${pr.start}L${pr.end}` : '');
    $q('.pskin-bline').setAttribute('d', st.lw && pr ? `M${pr.start}${pr.body}` : '');
  }
  /* Пупырка появляется / разглаживается: меняется прозрачность только
     её кусочков и отрезка рамки под ней */
  function show(on, ms = 0, delay = 0) {
    shown = on;
    for (const el of [...bumpEls, gapEl]) {
      el.style.transitionDuration = ms + 'ms';
      el.style.transitionDelay = delay + 'ms';
    }
    bumpEls.forEach(el => { el.style.opacity = on ? 1 : 0; });
    gapEl.style.opacity = on ? 0 : 1;
  }
  show(true);
  return {
    refresh() { read(); draw(); },
    draw,
    get bw() { return st ? st.bw : 0; },
    get r() { return st ? st.r : [0, 0, 0, 0]; },
    setBump(on, ms = 0, delay = 0) { show(on, ms, delay); },
    get bumped() { return shown; },
  };
}
