import {
  state, MODES, WEEKDAYS, MONTHS_FULL, DAYS_FULL, today, addDays, mondayOf, parseISO, isoWeek,
  esc, isDone, plansForDay, hmToMin, setEntry, setMode, setHideDone, getTask, fmtMin,
} from './store.js';
import { openSheet } from './sheet.js';
import { openDay } from './week.js';
import { dbGetKV, dbSetKV } from './db.js';
import { openSearch } from './search.js';
import { morph, countUp } from './anim.js';
import * as tm from './timer.js';
import { kbNotes } from './kb.js';
import { curMonth, monthStats, budgetProgress, moneyShort } from './finance.js';

/* ══════════════ ГЛАВНАЯ ══════════════
   Сводка дня на одном экране: неделя, фокус, ближайшее, таймлайн дня,
   плитки разделов, фокус за неделю и строка быстрого добавления.
   Всё оформление — от темы: карточки получают «материал» темы
   (.glass + .hm-card), цвет — акцент режима.
   Карточки раскладываются по двум колонкам и перетаскиваются за ручку
   в углу — так же, как виджеты недели; раскладка запоминается. */

const FOCUS_GOAL = 240;   // цель фокуса на день, мин
let homeTab = 'timeline';
let _host = null;
let _tick = 0;
let _drag = null;          // идёт перетаскивание — перерисовку откладываем
let _pending = false;
const PANELS = ['week', 'focus', 'soon', 'hero', 'tiles', 'chart'];
const DEFAULT_LAYOUT = { left: ['week', 'focus', 'soon'], main: ['hero', 'tiles', 'chart'] };
let layout = DEFAULT_LAYOUT;
const HANDLE = id => `<svg class="dock-handle hm-handle" data-hmh="${id}" viewBox="0 0 32 32" aria-label="Перетащить" role="img"><path d="M2 22 A20 20 0 0 1 22 2" pathLength="100" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`;

const go = v => document.dispatchEvent(new CustomEvent('go-view', { detail: v }));
const modeLabel = m => (MODES.find(x => x.id === m) || {}).label || m;
const inMode = t => !t.deleted && (state.mode === 'all' || t.mode === state.mode);

const ICO = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.2 1.2L6.8 5M3.5 12l1.2 1.2 2.1-2.2M3.5 18l1.2 1.2 2.1-2.2"/>',
  kb: '<path d="M5 4h11a3 3 0 0 1 3 3v13H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h12"/>',
  fin: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 15h2"/>',
  ct: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M17 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  set: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  focus: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
};
const svg = (k, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICO[k]}</svg>`;

/* ── Данные ── */
function focusByDay() {
  const map = new Map();
  for (const t of state.tasks) {
    for (const s of (t.sessions || [])) if (s && s.date) map.set(s.date, (map.get(s.date) || 0) + (s.min || 0));
  }
  const act = tm.getActive();
  if (act) map.set(today(), (map.get(today()) || 0) + Math.floor(act.elapsed / 60000));
  return map;
}
function todayStats() {
  const d = today();
  const list = state.tasks.filter(t => inMode(t) && (t.days || {})[d]);
  const done = list.filter(t => { const s = t.days[d]; return s === 'done' || s === 'skipped'; }).length;
  return { total: list.length, done, list };
}
/* Задачи с окном времени на день; дорожки — чтобы пересечения не накладывались */
function dayPlan(day) {
  const items = [];
  for (const t of state.tasks) {
    if (!inMode(t) || !(t.days || {})[day]) continue;
    for (const p of plansForDay(t, day)) items.push({ t, s: hmToMin(p.start), e: Math.max(hmToMin(p.end), hmToMin(p.start) + 15), start: p.start, end: p.end });
  }
  items.sort((a, b) => a.s - b.s);
  const lanes = [];
  for (const it of items) {
    let i = lanes.findIndex(end => end <= it.s);
    if (i < 0) { i = lanes.length; lanes.push(0); }
    lanes[i] = it.e;
    it.lane = i;
  }
  return { items, lanes: Math.max(1, lanes.length) };
}
function upcoming(n) {
  const out = [];
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (let i = 0; i < 7 && out.length < n; i++) {
    const day = addDays(today(), i);
    const { items } = dayPlan(day);
    for (const it of items) {
      const st = it.t.days[day];
      if (st !== 'todo' && st !== 'started') continue;
      if (i === 0 && it.e < nowMin) continue;
      out.push({ ...it, day });
      if (out.length >= n) break;
    }
  }
  return out;
}

/* ── Части экрана ── */
function weekHTML() {
  const t0 = today();
  const ws = mondayOf(t0);
  const d = parseISO(t0);
  const h = new Date().getHours();
  const hello = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
  const cells = WEEKDAYS.map((w, i) => {
    const day = addDays(ws, i);
    const n = state.tasks.filter(t => inMode(t) && (t.days || {})[day]).length;
    const cls = day === t0 ? ' today' : day < t0 ? ' past' : '';
    return `<button type="button" class="hm-day${cls}" data-day="${day}"><small>${w}</small><b>${+day.slice(8)}</b><i>${n ? '•'.repeat(Math.min(3, n)) : ''}</i></button>`;
  }).join('');
  return `<section class="hm-week glass hm-card" data-hm="week">${HANDLE('week')}
    <div class="hm-hello"><small>${hello}</small><b>${DAYS_FULL[(d.getDay() + 6) % 7]}, ${d.getDate()} ${MONTHS_FULL[d.getMonth()]}</b><small>неделя ${isoWeek(t0)}</small></div>
    <div class="hm-days">${cells}</div>
  </section>`;
}
function arcPath() { return 'M20 100a80 80 0 0 1 160 0'; }
function focusHTML(fmap) {
  const min = fmap.get(today()) || 0;
  const k = Math.min(1, min / FOCUS_GOAL);
  const act = tm.getActive();
  const at = act && getTask(act.taskId);
  const hm = `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
  return `<section class="hm-focus glass hm-card" data-hm="focus">${HANDLE('focus')}
    <div class="hm-head"><h2>Фокус</h2><small>цель ${FOCUS_GOAL / 60} ч</small></div>
    <svg viewBox="0 0 200 112" class="hm-gauge" role="img" aria-label="Фокус сегодня: ${fmtMin(min)}">
      <path d="${arcPath()}" class="hm-g-bg"/>
      <path d="${arcPath()}" class="hm-g-val"${k > 0 ? '' : ' style="opacity:0"'} pathLength="100" stroke-dasharray="100" stroke-dashoffset="${(100 - k * 100).toFixed(1)}"/>
      <text x="100" y="86" class="hm-g-big">${hm}</text>
      <text x="100" y="105" class="hm-g-sm">из ${FOCUS_GOAL / 60}:00</text>
    </svg>
    <button type="button" class="hm-btn" data-act="focus">${at ? `Идёт: ${esc(at.title)}` : 'Начать фокус'}</button>
  </section>`;
}
function soonHTML() {
  const list = upcoming(4);
  const t0 = today();
  const rows = list.map(it => `<button type="button" class="hm-soon-row" data-id="${it.t.id}" data-task="${it.t.id}">
      <span class="hm-time${it.day === t0 ? ' on' : ''}">${it.day === t0 ? it.start : WEEKDAYS[(parseISO(it.day).getDay() + 6) % 7]}</span>
      <span class="hm-soon-txt"><b>${esc(it.t.title || 'Без названия')}</b><small><i class="hm-dot" style="background:var(--mode-${it.t.mode})"></i>${esc(modeLabel(it.t.mode))} · ${it.start}–${it.end}</small></span>
    </button>`).join('');
  return `<section class="hm-soon glass hm-card" data-hm="soon">${HANDLE('soon')}
    <div class="hm-head"><h2>Ближайшее</h2><button type="button" class="hm-link" data-go="week">Все</button></div>
    ${rows || '<p class="hm-empty">Ближайших задач со временем нет. Окно задаётся в «Планировании» задачи.</p>'}
  </section>`;
}
function heroHTML(st) {
  const d = today();
  const pct = st.total ? Math.round(st.done / st.total * 100) : 0;
  let body;
  if (homeTab === 'timeline') {
    const { items, lanes } = dayPlan(d);
    let h0 = 8, h1 = 21;
    for (const it of items) { h0 = Math.min(h0, Math.floor(it.s / 60)); h1 = Math.max(h1, Math.ceil(it.e / 60)); }
    const span = (h1 - h0) * 60;
    const now = new Date();
    const nm = now.getHours() * 60 + now.getMinutes();
    const pos = m => ((m - h0 * 60) / span * 100).toFixed(2);
    const hours = [];
    const lines = [];
    for (let h = h0; h <= h1; h += 2) {
      hours.push(`<span style="top:${pos(h * 60)}%">${String(h).padStart(2, '0')}:00</span>`);
      lines.push(`<i class="hm-hl" style="top:${pos(h * 60)}%"></i>`);
    }
    const evs = items.map(it => {
      const s = it.t.days[d];
      const done = s === 'done' || s === 'skipped';
      const live = !done && nm >= it.s && nm < it.e;
      const w = 100 / lanes;
      const short = it.e - it.s < 100 ? ' short' : '';
      return `<button type="button" class="hm-ev${short}${done ? ' done' : ''}${live ? ' live' : ''}" data-id="${it.t.id}" data-task="${it.t.id}" style="--mc:var(--mode-${it.t.mode});top:${pos(it.s)}%;height:${(Math.max(it.e - it.s, 30) / span * 100).toFixed(2)}%;left:${(it.lane * w).toFixed(2)}%;width:calc(${w.toFixed(2)}% - 6px)">
        <b>${esc(it.t.title || 'Без названия')}</b><small>${it.start} – ${it.end}${live ? ' · идёт сейчас' : ''}</small></button>`;
    }).join('');
    const loose = st.list.filter(t => !plansForDay(t, d).length);
    body = `<div class="hm-tl">
      <div class="hm-tl-hours">${hours.join('')}</div>
      <div class="hm-tl-area">${lines.join('')}${evs}${nm >= h0 * 60 && nm <= h1 * 60 ? `<i class="hm-now" style="top:${pos(nm)}%"></i>` : ''}
        ${items.length ? '' : '<p class="hm-empty hm-tl-empty">На сегодня нет задач со временем</p>'}</div>
    </div>
    ${loose.length ? `<div class="hm-loose"><small>Без времени:</small>${loose.slice(0, 8).map(t => `<button type="button" class="hm-chip${isDone(t) ? ' done' : ''}" data-id="${t.id}" data-task="${t.id}" style="--mc:var(--mode-${t.mode})">${esc(t.title || 'Без названия')}</button>`).join('')}${loose.length > 8 ? `<small>+${loose.length - 8}</small>` : ''}</div>` : ''}`;
  } else {
    const list = st.list.slice().sort((a, b) => (isDoneOn(a, d) - isDoneOn(b, d)) || (a.priority - b.priority));
    body = `<div class="hm-list">${list.map(t => {
      const dn = isDoneOn(t, d);
      return `<div class="hm-row${dn ? ' done' : ''}" data-id="${t.id}" style="--mc:var(--mode-${t.mode})">
        <button type="button" class="hm-check" data-toggle="${t.id}" aria-label="${dn ? 'Вернуть' : 'Выполнить'}">${dn ? '✓' : ''}</button>
        <button type="button" class="hm-row-t" data-task="${t.id}">${esc(t.title || 'Без названия')}</button>
        <small>${esc(modeLabel(t.mode))}</small></div>`;
    }).join('') || '<p class="hm-empty">На сегодня задач нет</p>'}</div>`;
  }
  return `<section class="hm-hero glass hm-card" data-hm="hero">${HANDLE('hero')}
    <div class="hm-hero-head">
      <h2>Сегодня</h2>
      <div class="hm-seg" role="group" aria-label="Режим">${MODES.map(m => `<button type="button" data-mode="${m.id}" aria-pressed="${state.mode === m.id}">${state.mode === m.id ? '<i class="seg-ind" data-flip="hm-mode"></i>' : ''}${esc(m.short || m.label)}</button>`).join('')}</div>
      <span class="hm-flex"></span>
      <small class="hm-prog-t">${st.done} из ${st.total}</small><i class="hm-prog"><u style="width:${pct}%"></u></i>
      <div class="hm-seg" role="group" aria-label="Вид">
        <button type="button" data-tab="list" aria-pressed="${homeTab === 'list'}">${homeTab === 'list' ? '<i class="seg-ind" data-flip="hm-tab"></i>' : ''}Список</button>
        <button type="button" data-tab="timeline" aria-pressed="${homeTab === 'timeline'}">${homeTab === 'timeline' ? '<i class="seg-ind" data-flip="hm-tab"></i>' : ''}Таймлайн</button>
      </div>
    </div>
    ${body}
  </section>`;
}
const isDoneOn = (t, d) => { const s = (t.days || {})[d]; return s === 'done' || s === 'skipped' ? 1 : 0; };
function tilesHTML(fmap) {
  const min = fmap.get(today()) || 0;
  const m = curMonth();
  const ms = monthStats(m);
  const kbN = kbNotes().length;
  const tile = (ico, on, big, sub, attrs, extra = '') => `<div role="button" tabindex="0" class="hm-tile" ${attrs}>
      <span class="hm-ico${on ? ' on' : ''}">${svg(ico, 18)}</span><span><b>${big}</b><small>${sub}</small></span>${extra}</div>`;
  return `<section class="hm-tiles-card glass hm-card hm-half" data-hm="tiles">${HANDLE('tiles')}<div class="hm-tiles">
    ${tile('focus', min > 0, fmtMin(min), 'фокус сегодня', 'data-act="focus"')}
    ${tile('kb', false, kbN, 'заметок в базе', 'data-go="kb"')}
    ${tile('fin', false, moneyShort(ms.expense), 'расходы за месяц', 'data-go="finance"')}
    ${tile('eye', state.hideDone, state.hideDone ? 'Скрыты' : 'Видны', 'выполненные задачи', 'data-act="hide" role="switch" aria-checked="' + state.hideDone + '"', `<i class="hm-tgl${state.hideDone ? ' on' : ''}"></i>`)}
  </div></section>`;
}
function chartHTML(fmap) {
  const ws = mondayOf(today());
  const t0 = today();
  const vals = WEEKDAYS.map((w, i) => { const d = addDays(ws, i); return { w, d, v: fmap.get(d) || 0 }; });
  const max = Math.max(60, ...vals.map(x => x.v));
  const sum = vals.reduce((a, x) => a + x.v, 0);
  return `<section class="hm-chart glass hm-card hm-half" data-hm="chart">${HANDLE('chart')}
    <div class="hm-head"><h2>Время фокуса · неделя</h2><b>${fmtMin(sum)}</b></div>
    <div class="hm-bars">${vals.map(x => `<div class="hm-bar${x.d === t0 ? ' today' : ''}${x.d > t0 ? ' future' : ''}" title="${x.w}: ${fmtMin(x.v)}"><i style="height:${Math.max(4, x.v / max * 100).toFixed(1)}%"></i><small>${x.w}</small></div>`).join('')}</div>
  </section>`;
}
function budgetLine() {
  const m = curMonth();
  const bp = budgetProgress(m);
  if (bp.length) {
    const lim = bp.reduce((a, b) => a + b.limit, 0), used = bp.reduce((a, b) => a + b.used, 0);
    return `${moneyShort(Math.max(0, lim - used))} осталось по бюджетам`;
  }
  return '';
}
function quickHTML() {
  return `<div role="button" tabindex="0" class="hm-quick glass hm-card" data-act="new">
    <span class="hm-quick-plus">${svg('plus', 18)}</span>
    <span class="hm-quick-ph">Новая задача — например, «созвон завтра в 15:00»</span>
    <span class="hm-flex"></span>
    ${budgetLine() ? `<small class="hm-quick-note">${budgetLine()}</small>` : ''}
    <span class="hm-btn">Добавить</span>
  </div>`;
}

/* Вход на экран: данные дорастают, числа докручиваются */
export function homeEntered() {
  const el = _host;
  if (!el) return;
  el.classList.add('m-enter');
  setTimeout(() => el.classList.remove('m-enter'), 1300);
  el.querySelectorAll('.hm-tile b, .hm-chart .hm-head b, .hm-prog-t').forEach(n => countUp(n));
}
export function renderHomeView(el) {
  if (!el) return;
  _host = el;
  if (_drag) { _pending = true; return; }
  const st = todayStats();
  const fmap = focusByDay();
  const parts = {
    week: weekHTML, focus: () => focusHTML(fmap), soon: soonHTML,
    hero: () => heroHTML(st), tiles: () => tilesHTML(fmap), chart: () => chartHTML(fmap),
  };
  const zone = z => `<div class="hm-zone" data-z="${z}">${layout[z].map(id => parts[id]()).join('')}</div>`;
  el.innerHTML = `${zone('left')}${zone('main')}${quickHTML()}`;
  if (!el.dataset.bound) bind(el);
  /* Линия «сейчас» и минуты фокуса — раз в минуту, пока экран открыт */
  clearInterval(_tick);
  _tick = setInterval(() => { if (!el.hidden && el.isConnected) morph(el, () => renderHomeView(el)); else clearInterval(_tick); }, 60000);
}

function bind(el) {
  el.dataset.bound = '1';
  el.addEventListener('click', e => {
    const b = e.target.closest('button, [role="button"]');
    if (!b || !el.contains(b)) return;
    if (b.dataset.go) return go(b.dataset.go);
    if (b.dataset.mode) return setMode(b.dataset.mode);
    if (b.dataset.tab) { homeTab = b.dataset.tab; return morph(el, () => renderHomeView(el)); }
    if (b.dataset.day) return openDay(b.dataset.day);
    if (b.dataset.toggle) {
      const t = getTask(b.dataset.toggle);
      if (t) setEntry(t.id, today(), isDoneOn(t, today()) ? 'todo' : 'done');
      return;
    }
    if (b.dataset.task) { const t = getTask(b.dataset.task); if (t) openSheet(t); return; }
    const a = b.dataset.act;
    if (a === 'new') openSheet(null);
    else if (a === 'search') openSearch();
    else if (a === 'hide') setHideDone(!state.hideDone);
    else if (a === 'focus') { if (tm.getActive()) tm.expandPill(); else go('week'); }
    else if (a === 'settings') document.getElementById('settingsBtn')?.click();
    else if (a === 'sync') document.getElementById('syncBtn')?.click();
  });
}

export function homeInit() {
  document.addEventListener('keydown', e => {
    const b = e.target;
    if ((e.key === 'Enter' || e.key === ' ') && b.matches && b.matches('.home-view [role="button"]')) { e.preventDefault(); b.click(); }
  });
  dbGetKV('homeLayout').then(v => {
    if (!v || typeof v !== 'object') return;
    const seen = new Set();
    const clean = z => (Array.isArray(v[z]) ? v[z] : []).filter(id => PANELS.includes(id) && !seen.has(id) && seen.add(id));
    const next = { left: clean('left'), main: clean('main') };
    PANELS.forEach(id => { if (!seen.has(id)) (DEFAULT_LAYOUT.left.includes(id) ? next.left : next.main).push(id); });
    layout = next;
    if (_host && !_host.hidden && state.view === 'home') morph(_host, () => renderHomeView(_host));
  }).catch(() => {});
  document.addEventListener('pointerdown', e => {
    const h = e.target.closest('.hm-handle[data-hmh]');
    if (!h || !_host || !_host.contains(h)) return;
    e.preventDefault();
    startDrag(h.closest('[data-hm]'), e);
  });
  /* Таймер шлёт событие каждую секунду — перерисовываем только при
     старте, остановке и паузе, а не всю «Главную» ежесекундно */
  let timerKey = '';
  document.addEventListener('timer-changed', () => {
    const a = tm.getActive();
    const key = a ? a.taskId + (a.paused ? ':p' : '') : '';
    if (key === timerKey) return;
    timerKey = key;
    if (_host && !_host.hidden && state.view === 'home') morph(_host, () => renderHomeView(_host));
  });
}

/* ══════════════ ПЕРЕТАСКИВАНИЕ КАРТОЧЕК ══════════════
   Как у виджетов недели: тянем за дугу в углу, карточка поднимается и
   идёт за пальцем, на её месте — пустое гнездо; соседи плавно
   расступаются (FLIP), отпущенная карточка доезжает в гнездо.
   Колонки две, карточку можно перенести в любую. На телефоне колонки
   сливаются в одну ленту — та же логика по ближайшей карточке. */
function flip(els, fn) {
  const before = new Map(els.map(e => [e, e.getBoundingClientRect()]));
  fn();
  for (const [e, r] of before) {
    if (!e.isConnected) continue;
    const n = e.getBoundingClientRect();
    const dx = r.left - n.left, dy = r.top - n.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    e.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.32, .72, .28, 1)' });
  }
}
function dropTarget(x, y, me, ph) {
  const cards = [..._host.querySelectorAll('[data-hm], .hm-ph')].filter(c => c !== me && c !== ph);
  let best = null, bd = Infinity;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = Math.hypot(dx, dy);
    if (d < bd) { bd = d; best = { c, r }; }
  }
  /* Пустая колонка: если палец над ней — кладём в неё */
  for (const z of _host.querySelectorAll('.hm-zone')) {
    const zr = z.getBoundingClientRect();
    if (zr.width && x >= zr.left && x <= zr.right && ![...z.children].some(k => k !== me && k !== ph && k.matches('[data-hm]'))) return { zone: z };
  }
  if (!best) return null;
  const half = best.c.classList.contains('hm-half') && best.c.parentNode.dataset.z === 'main' && best.r.width < best.c.parentNode.getBoundingClientRect().width * .8;
  const before = half ? x < best.r.left + best.r.width / 2 : y < best.r.top + best.r.height / 2;
  return { ref: best.c, before };
}
function startDrag(panel, e) {
  if (!panel) return;
  const app = document.getElementById('app');
  const ctx = { panel, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, started: false, ph: null, rect: null, app, scroll0: app ? app.scrollTop : 0, raf: 0 };
  _drag = ctx;
  const blockTouch = ev => { if (ev.cancelable) ev.preventDefault(); };
  document.addEventListener('touchmove', blockTouch, { passive: false });
  const move = ev => { ctx.x = ev.clientX; ctx.y = ev.clientY; update(ctx); };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    document.removeEventListener('touchmove', blockTouch);
    cancelAnimationFrame(ctx.raf);
    finish(ctx);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}
function update(ctx) {
  const { panel } = ctx;
  if (!ctx.started) {
    if (Math.hypot(ctx.x - ctx.sx, ctx.y - ctx.sy) < 8) return;
    ctx.started = true;
    const r = panel.getBoundingClientRect();
    ctx.rect = r;
    const ph = document.createElement('div');
    ph.className = 'hm-ph' + (panel.classList.contains('hm-half') ? ' hm-half' : '');
    ph.style.height = r.height + 'px';
    panel.before(ph);
    ctx.ph = ph;
    Object.assign(panel.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', zIndex: 60, margin: 0 });
    panel.classList.add('hm-dragging');
    document.body.classList.add('hm-drag');
    autoScroll(ctx);
  }
  panel.style.transform = `translate(${ctx.x - ctx.sx}px, ${ctx.y - ctx.sy}px) scale(1.02)`;
  const t = dropTarget(ctx.x, ctx.y, panel, ctx.ph);
  if (!t) return;
  const ph = ctx.ph;
  let changed = false;
  if (t.zone) { if (ph.parentNode !== t.zone) changed = () => t.zone.appendChild(ph); }
  else if (t.before ? t.ref.previousElementSibling !== ph : t.ref.nextElementSibling !== ph) changed = () => (t.before ? t.ref.before(ph) : t.ref.after(ph));
  if (!changed) return;
  const sibs = [..._host.querySelectorAll('[data-hm], .hm-quick')].filter(c => c !== panel);
  flip(sibs, changed);
}
function autoScroll(ctx) {
  const tick = () => {
    const app = ctx.app;
    if (!app || !ctx.started) return;
    const EDGE = 70, h = innerHeight;
    const v = ctx.y < EDGE ? -14 * (EDGE - ctx.y) / EDGE : ctx.y > h - EDGE ? 14 * (ctx.y - (h - EDGE)) / EDGE : 0;
    if (v) app.scrollTop += v;
    ctx.raf = requestAnimationFrame(tick);
  };
  ctx.raf = requestAnimationFrame(tick);
}
function finish(ctx) {
  const { panel, ph } = ctx;
  _drag = null;
  document.body.classList.remove('hm-drag');
  if (!ctx.started) { if (_pending) { _pending = false; renderHomeView(_host); } return; }
  const from = panel.getBoundingClientRect();
  ph.replaceWith(panel);
  panel.classList.remove('hm-dragging');
  Object.assign(panel.style, { position: '', left: '', top: '', width: '', height: '', zIndex: '', margin: '', transform: '' });
  const to = panel.getBoundingClientRect();
  panel.animate([
    { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(1.02)` },
    { transform: 'none' },
  ], { duration: 300, easing: 'cubic-bezier(.32, 1.18, .28, 1)' });
  const read = z => [..._host.querySelectorAll(`.hm-zone[data-z="${z}"] > [data-hm]`)].map(c => c.dataset.hm);
  layout = { left: read('left'), main: read('main') };
  dbSetKV('homeLayout', layout).catch(() => {});
  if (_pending) { _pending = false; setTimeout(() => renderHomeView(_host), 320); }
}
