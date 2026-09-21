/* ══════════════════════════════════════════════════════════════════
   Графики в духе bklit UI charts — на чистом SVG, без React и visx.

   Повторяем их визуальный язык и поведение:
   • Ring  — несколько колец-прогрессов, общий центр, наведение
             подсвечивает кольцо и меняет подпись в центре;
   • Bar   — столбики со скруглёнными концами, пунктирная сетка,
             рост со «ступенькой» (stagger), наведение гасит соседей;
   • Gauge — дуга из насечек 135°→405°, заливка 0–100, число в центре;
   • Line  — гладкая кривая с затуханием по краям, площадь под ней,
             вертикальный курсор с точкой и подсказкой.

   Кривая анимации везде одна — cubic-bezier(.85, 0, .15, 1), как
   в оригинале. Цвета — CSS-переменные --chart-1…5, так что графики
   следуют за темой и цветом режима.
   ══════════════════════════════════════════════════════════════════ */
const NS = 'http://www.w3.org/2000/svg';
const EASE = 'cubic-bezier(.85, 0, .15, 1)';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let uidN = 0;
const uid = p => `${p}${++uidN}`;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

/* ── Подсказка, общая для всех графиков ── */
let tipEl = null;
function tip() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'ch-tip';
  document.body.appendChild(tipEl);
  return tipEl;
}
function showTip(html, x, y) {
  const t = tip();
  t.innerHTML = html;
  t.classList.add('on');
  const r = t.getBoundingClientRect();
  let left = x + 14, top = y - r.height - 10;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top < 8) top = y + 16;
  t.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}
function hideTip() { if (tipEl) tipEl.classList.remove('on'); }

/* ══════════════ RING ══════════════ */
/* data: [{ label, value, maxValue, color }] */
export function ringChart(host, data, opts) {
  const o = Object.assign({ size: 180, stroke: 11, gap: 5, inner: 44, label: 'Всего', format: v => v, total: null }, opts || {});
  const items = data.slice(0, 5);
  const S = o.size, C = S / 2;
  const outer = o.inner + items.length * (o.stroke + o.gap);
  const scale = Math.min(1, (C - 2) / outer);
  const sw = o.stroke * scale, gap = o.gap * scale, r0 = o.inner * scale;
  const total = o.total != null ? o.total : items.reduce((a, b) => a + b.value, 0);

  const rings = items.map((it, i) => {
    const r = r0 + i * (sw + gap) + sw / 2;
    const len = 2 * Math.PI * r;
    const frac = it.maxValue > 0 ? Math.max(0, Math.min(1, it.value / it.maxValue)) : 0;
    const color = it.color || PALETTE[i % PALETTE.length];
    return { ...it, r, len, frac, color, i };
  });
  host.innerHTML = `
    <div class="ch-ring" style="--size:${S}px">
      <svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img">
        ${rings.map(g => `
          <g class="ch-ring-g" data-i="${g.i}">
            <circle class="ch-ring-track" cx="${C}" cy="${C}" r="${g.r.toFixed(2)}" stroke-width="${sw.toFixed(2)}"/>
            <circle class="ch-ring-arc" cx="${C}" cy="${C}" r="${g.r.toFixed(2)}" stroke-width="${sw.toFixed(2)}"
              stroke="${g.color}" stroke-dasharray="${g.len.toFixed(2)}" stroke-dashoffset="${g.len.toFixed(2)}"
              data-target="${(g.len * (1 - g.frac)).toFixed(2)}" transform="rotate(-90 ${C} ${C})"/>
            <circle class="ch-ring-hit" cx="${C}" cy="${C}" r="${g.r.toFixed(2)}" stroke-width="${(sw + gap).toFixed(2)}"/>
          </g>`).join('')}
      </svg>
      <div class="ch-ring-center">
        <b class="ch-ring-val">${esc(o.format(total))}</b>
        <span class="ch-ring-lab">${esc(o.label)}</span>
      </div>
    </div>`;
  const svg = host.querySelector('svg');
  const val = host.querySelector('.ch-ring-val');
  const lab = host.querySelector('.ch-ring-lab');
  /* Анимация: дорожки «раскрываются», затем прогресс доезжает до цели */
  svg.querySelectorAll('.ch-ring-arc').forEach((a, i) => {
    const target = a.dataset.target;
    if (reduced()) { a.setAttribute('stroke-dashoffset', target); return; }
    a.animate([{ strokeDashoffset: a.getAttribute('stroke-dashoffset') }, { strokeDashoffset: target }],
      { duration: 1100, delay: 120 + i * 90, easing: EASE, fill: 'forwards' });
  });
  if (!reduced()) {
    svg.querySelectorAll('.ch-ring-track').forEach((t, i) => t.animate(
      [{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'scale(1)' }],
      { duration: 500, delay: i * 70, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' }));
  }
  /* Наведение: кольцо подсвечивается, остальные гаснут, центр — о нём */
  const setHover = i => {
    svg.querySelectorAll('.ch-ring-g').forEach(g => g.classList.toggle('dim', i != null && +g.dataset.i !== i));
    host.querySelectorAll('[data-legend]').forEach(l => l.classList.toggle('dim', i != null && +l.dataset.legend !== i));
    if (i == null) { val.textContent = o.format(total); lab.textContent = o.label; return; }
    const g = rings[i];
    val.textContent = o.format(g.value);
    lab.textContent = g.label;
  };
  svg.querySelectorAll('.ch-ring-g').forEach(g => {
    g.addEventListener('pointerenter', () => setHover(+g.dataset.i));
    g.addEventListener('pointerleave', () => setHover(null));
  });
  return { setHover, rings };
}
/* Легенда к кольцам: цвет, название, значение и полоса прогресса */
export function ringLegend(host, rings, fmt, onHover) {
  host.innerHTML = rings.map(g => `
    <div class="ch-leg" data-legend="${g.i}">
      <i style="background:${g.color}"></i>
      <span class="ch-leg-name">${esc(g.label)}</span>
      <b class="ch-leg-val">${esc(fmt(g.value))}</b>
      <span class="ch-leg-pct">${(g.frac * 100).toFixed(0)}%</span>
      <em class="ch-leg-bar"><u style="--w:${(g.frac * 100).toFixed(1)}%;background:${g.color}"></u></em>
    </div>`).join('');
  host.querySelectorAll('[data-legend]').forEach(el => {
    el.addEventListener('pointerenter', () => onHover && onHover(+el.dataset.legend));
    el.addEventListener('pointerleave', () => onHover && onHover(null));
  });
  if (!reduced()) {
    host.querySelectorAll('.ch-leg').forEach((el, i) => el.animate(
      [{ opacity: 0, transform: 'translateX(10px)' }, { opacity: 1, transform: 'none' }],
      { duration: 420, delay: 250 + i * 70, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' }));
  }
}

/* ══════════════ BAR ══════════════ */
/* rows: [{ x, ...values }], series: [{ key, label, color }] */
export function barChart(host, rows, series, opts) {
  const o = Object.assign({ height: 180, format: v => v, ticks: 4 }, opts || {});
  const W = Math.max(260, host.clientWidth || 320), H = o.height;
  const m = { t: 12, r: 6, b: 24, l: 6 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(1, ...rows.flatMap(r => series.map(s => +r[s.key] || 0)));
  const nice = niceMax(max);
  const band = iw / Math.max(1, rows.length);
  const groupW = band * 0.62;
  const gap = Math.max(2, groupW * 0.08);
  const bw = (groupW - gap * (series.length - 1)) / series.length;
  const y = v => m.t + ih - (v / nice) * ih;
  const grid = Array.from({ length: o.ticks + 1 }, (_, i) => m.t + (ih * i) / o.ticks);
  let bars = '';
  rows.forEach((r, ri) => {
    const gx = m.l + ri * band + (band - groupW) / 2;
    series.forEach((s, si) => {
      const v = +r[s.key] || 0;
      const h = Math.max(v > 0 ? 3 : 0, (v / nice) * ih);
      const x = gx + si * (bw + gap);
      const rad = Math.min(bw / 2, 6);
      bars += `<rect class="ch-bar" data-r="${ri}" data-s="${si}" x="${x.toFixed(2)}" y="${(m.t + ih - h).toFixed(2)}"
        width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="${rad.toFixed(2)}" fill="${s.color}"
        style="transform-origin:${(x + bw / 2).toFixed(1)}px ${(m.t + ih).toFixed(1)}px"/>`;
    });
  });
  host.innerHTML = `
    <div class="ch-bars">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
        ${grid.map(gy => `<line class="ch-grid" x1="${m.l}" x2="${W - m.r}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}"/>`).join('')}
        ${bars}
        ${rows.map((r, ri) => `<rect class="ch-band" data-r="${ri}" x="${(m.l + ri * band).toFixed(1)}" y="${m.t}" width="${band.toFixed(1)}" height="${ih}"/>`).join('')}
        ${rows.map((r, ri) => `<text class="ch-xlab" x="${(m.l + ri * band + band / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(r.x)}</text>`).join('')}
      </svg>
      <div class="ch-legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>
    </div>`;
  const svg = host.querySelector('svg');
  const all = [...svg.querySelectorAll('.ch-bar')];
  if (!reduced()) {
    const step = Math.min(70, 700 / Math.max(1, all.length));
    all.forEach((b, i) => b.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }],
      { duration: 1100, delay: i * step, easing: EASE, fill: 'backwards' }));
  }
  svg.querySelectorAll('.ch-band').forEach(band => {
    const ri = +band.dataset.r;
    band.addEventListener('pointermove', e => {
      all.forEach(b => b.classList.toggle('dim', +b.dataset.r !== ri));
      const r = rows[ri];
      showTip(`<b>${esc(r.x)}</b>${series.map(s =>
        `<span><i style="background:${s.color}"></i>${esc(s.label)}<em>${esc(o.format(+r[s.key] || 0))}</em></span>`).join('')}`,
        e.clientX, e.clientY);
    });
    band.addEventListener('pointerleave', () => { all.forEach(b => b.classList.remove('dim')); hideTip(); });
    if (o.onPick) band.addEventListener('click', () => { hideTip(); o.onPick(ri); });
  });
  /* Выбранная колонка подсвечивается постоянно */
  if (o.active != null) all.forEach(b => b.classList.toggle('pick', +b.dataset.r === o.active));
}
function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return s * p;
}

/* ══════════════ GAUGE ══════════════ */
export function gauge(host, value, opts) {
  const o = Object.assign({ size: 170, notches: 36, label: '', center: '', start: 135, end: 405,
    color: 'var(--chart-1)', spacing: 0.28 }, opts || {});
  const S = o.size, C = S / 2;
  const R1 = C - 4, R0 = C - 4 - S * 0.12;
  const span = o.end - o.start;
  const per = span / o.notches;
  const fill = Math.round((Math.max(0, Math.min(100, value)) / 100) * o.notches);
  /* 0° — вправо, углы по часовой (ось y экрана вниз): 135°→405°
     даёт подкову с разрывом снизу, как в оригинале */
  const rad = d => d * Math.PI / 180;
  const pt = (d, r) => [C + r * Math.cos(rad(d)), C + r * Math.sin(rad(d))];
  let notches = '';
  for (let i = 0; i < o.notches; i++) {
    const a0 = o.start + i * per + per * o.spacing / 2;
    const a1 = o.start + (i + 1) * per - per * o.spacing / 2;
    const [x0, y0] = pt(a0, R1), [x1, y1] = pt(a1, R1), [x2, y2] = pt(a1, R0), [x3, y3] = pt(a0, R0);
    notches += `<path class="ch-notch${i < fill ? ' on' : ''}" data-i="${i}" d="M${x0.toFixed(2)} ${y0.toFixed(2)}A${R1} ${R1} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}A${R0} ${R0} 0 0 0 ${x3.toFixed(2)} ${y3.toFixed(2)}Z"/>`;
  }
  host.innerHTML = `
    <div class="ch-gauge" style="--size:${S}px;--gc:${o.color}">
      <svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">${notches}</svg>
      <div class="ch-gauge-center"><b>${esc(o.center)}</b><span>${esc(o.label)}</span></div>
    </div>`;
  if (!reduced()) {
    host.querySelectorAll('.ch-notch.on').forEach((n, i) => n.animate(
      [{ opacity: 0.15 }, { opacity: 1 }],
      { duration: 260, delay: 150 + i * 22, easing: 'ease-out', fill: 'backwards' }));
  }
}

/* ══════════════ LINE ══════════════ */
/* points: number[], labels: string[] */
export function lineChart(host, points, labels, opts) {
  const o = Object.assign({ height: 120, format: v => v, color: 'var(--chart-1)' }, opts || {});
  const W = Math.max(240, host.clientWidth || 300), H = o.height;
  const m = { t: 10, r: 4, b: 6, l: 4 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const n = points.length;
  if (n < 2) { host.innerHTML = '<div class="ch-empty">Недостаточно данных</div>'; return; }
  const min = Math.min(0, ...points), max = Math.max(0, ...points);
  const span = max - min || 1;
  const X = i => m.l + (i / (n - 1)) * iw;
  const Y = v => m.t + ih - ((v - min) / span) * ih;
  const P = points.map((v, i) => [X(i), Y(v)]);
  const d = smoothPath(P);
  const gid = uid('lg'), fid = uid('lf');
  host.innerHTML = `
    <div class="ch-line">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="${o.color}" stop-opacity=".32"/>
            <stop offset="1" stop-color="${o.color}" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="${fid}" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#fff" stop-opacity="0"/>
            <stop offset=".08" stop-color="#fff" stop-opacity="1"/>
            <stop offset=".92" stop-color="#fff" stop-opacity="1"/>
            <stop offset="1" stop-color="#fff" stop-opacity="0"/>
          </linearGradient>
          <mask id="${fid}m"><rect x="0" y="0" width="${W}" height="${H}" fill="url(#${fid})"/></mask>
        </defs>
        ${min < 0 ? `<line class="ch-zero" x1="${m.l}" x2="${W - m.r}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}"/>` : ''}
        <g mask="url(#${fid}m)">
          <path class="ch-area" d="${d} L${P[n - 1][0].toFixed(1)} ${(m.t + ih).toFixed(1)} L${P[0][0].toFixed(1)} ${(m.t + ih).toFixed(1)} Z" fill="url(#${gid})"/>
          <path class="ch-path" d="${d}" stroke="${o.color}"/>
        </g>
        <line class="ch-cross" y1="${m.t}" y2="${m.t + ih}" x1="0" x2="0"/>
        <circle class="ch-dot" r="4.5" cx="0" cy="0" fill="${o.color}"/>
        <rect class="ch-hit" x="0" y="0" width="${W}" height="${H}"/>
      </svg>
    </div>`;
  const svg = host.querySelector('svg');
  const path = svg.querySelector('.ch-path');
  /* Проявление «шторкой» слева направо — как clip-reveal в оригинале */
  if (!reduced()) {
    const L = path.getTotalLength ? path.getTotalLength() : 1000;
    path.style.strokeDasharray = L;
    path.animate([{ strokeDashoffset: L }, { strokeDashoffset: 0 }], { duration: 1100, easing: EASE, fill: 'backwards' });
    svg.querySelector('.ch-area').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay: 500, fill: 'backwards' });
  }
  const cross = svg.querySelector('.ch-cross'), dot = svg.querySelector('.ch-dot');
  svg.querySelector('.ch-hit').addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((x - m.l) / iw) * (n - 1))));
    const [px, py] = P[i];
    cross.setAttribute('x1', px); cross.setAttribute('x2', px);
    dot.setAttribute('cx', px); dot.setAttribute('cy', py);
    svg.classList.add('hover');
    showTip(`<b>${esc(labels[i] || '')}</b><span><em>${esc(o.format(points[i]))}</em></span>`, e.clientX, e.clientY);
  });
  svg.querySelector('.ch-hit').addEventListener('pointerleave', () => { svg.classList.remove('hover'); hideTip(); });
}
/* Сглаживание — монотонная кубическая (как curveMonotoneX): кривая
   не «перелетает» экстремумы, в отличие от наивного сплайна */
function smoothPath(P) {
  const n = P.length;
  const dx = [], dy = [], s = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = P[i + 1][0] - P[i][0];
    dy[i] = P[i + 1][1] - P[i][1];
    s[i] = dy[i] / (dx[i] || 1);
  }
  const t = [s[0]];
  for (let i = 1; i < n - 1; i++) t[i] = s[i - 1] * s[i] <= 0 ? 0 : (s[i - 1] + s[i]) / 2;
  t[n - 1] = s[n - 2];
  let d = `M${P[0][0].toFixed(1)} ${P[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(P[i][0] + h).toFixed(1)} ${(P[i][1] + t[i] * h).toFixed(1)} ${(P[i + 1][0] - h).toFixed(1)} ${(P[i + 1][1] - t[i + 1] * h).toFixed(1)} ${P[i + 1][0].toFixed(1)} ${P[i + 1][1].toFixed(1)}`;
  }
  return d;
}
