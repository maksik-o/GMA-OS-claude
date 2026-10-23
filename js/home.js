import {
  state, MODES, WEEKDAYS, MONTHS_FULL, DAYS_FULL, today, addDays, mondayOf, parseISO, isoWeek,
  esc, isDone, plansForDay, hmToMin, setEntry, setMode, setHideDone, getTask, fmtMin,
} from './store.js';
import { openSheet } from './sheet.js';
import { openDay } from './week.js';
import { openSearch } from './search.js';
import * as tm from './timer.js';
import { kbNotes } from './kb.js';
import { getPeople } from './contacts.js';
import { curMonth, monthStats, budgetProgress, moneyShort } from './finance.js';

/* ══════════════ ГЛАВНАЯ ══════════════
   Сводка дня на одном экране: меню с подписями и счётчиками, неделя,
   фокус, ближайшее, таймлайн дня, плитки разделов, фокус за неделю и
   строка быстрого добавления. Всё оформление — от темы: карточки
   получают «материал» темы (.glass + .hm-card), цвет — акцент режима. */

const FOCUS_GOAL = 240;   // цель фокуса на день, мин
let homeTab = 'timeline';
let syncState = '';
let _host = null;
let _tick = 0;

const go = v => document.dispatchEvent(new CustomEvent('go-view', { detail: v }));
const modeLabel = m => (MODES.find(x => x.id === m) || {}).label || m;
const inMode = t => !t.deleted && (state.mode === 'all' || t.mode === state.mode);
const openToday = t => { const s = (t.days || {})[today()]; return s === 'todo' || s === 'started'; };

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
function sideHTML(st) {
  const kbN = kbNotes().length;
  const ctN = getPeople('all').length;
  const perMode = m => state.tasks.filter(t => !t.deleted && t.mode === m && openToday(t)).length;
  const syncTxt = { ok: 'Синхронизировано', syncing: 'Синхронизация…', local: 'Только на устройстве', offline: 'Нет сети', auth: 'Нужен вход', error: 'Ошибка синхронизации', off: 'Не настроена', perm: 'Нужен доступ к файлу' }[syncState] || 'Синхронизация';
  const good = syncState === 'ok' || syncState === 'syncing';
  const badge = n => n ? `<span class="hm-n">${n}</span>` : '';
  return `<nav class="hm-side glass hm-card" aria-label="Разделы">
    <div class="hm-brand"><span class="hm-logo">G</span><div><b>GMA-OS</b><small>личный планировщик</small></div></div>
    <button type="button" class="hm-nav on" aria-current="page">${svg('home', 19)}<span>Главная</span></button>
    <button type="button" class="hm-nav" data-go="week">${svg('tasks', 19)}<span>Задачи</span>${badge(st.total - st.done)}</button>
    <button type="button" class="hm-nav" data-go="kb">${svg('kb', 19)}<span>База знаний</span>${badge(kbN)}</button>
    <button type="button" class="hm-nav" data-go="finance">${svg('fin', 19)}<span>Финансы</span></button>
    <button type="button" class="hm-nav" data-go="contacts">${svg('ct', 19)}<span>Контакты</span>${badge(ctN)}</button>
    <div class="hm-grp">Режимы</div>
    ${MODES.filter(m => m.id !== 'all').map(m => `<button type="button" class="hm-nav${state.mode === m.id ? ' sel' : ''}" data-mode="${m.id}"><i class="hm-dot" style="background:var(--mode-${m.id})"></i><span>${esc(m.label)}</span>${badge(perMode(m.id))}</button>`).join('')}
    <span class="hm-flex"></span>
    <button type="button" class="hm-sync" data-act="sync"><i class="${good ? 'ok' : 'bad'}"></i><span><b>${syncTxt}</b><small>нажмите для настроек</small></span></button>
    <button type="button" class="hm-nav" data-act="settings">${svg('set', 19)}<span>Настройки</span></button>
  </nav>`;
}
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
  return `<section class="hm-week glass hm-card">
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
  return `<section class="hm-focus glass hm-card">
    <div class="hm-head"><h2>Фокус</h2><small>цель ${FOCUS_GOAL / 60} ч</small></div>
    <svg viewBox="0 0 200 112" class="hm-gauge" role="img" aria-label="Фокус сегодня: ${fmtMin(min)}">
      <path d="${arcPath()}" class="hm-g-bg"/>
      <path d="${arcPath()}" class="hm-g-val" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${(100 - k * 100).toFixed(1)}"/>
      <text x="100" y="86" class="hm-g-big">${hm}</text>
      <text x="100" y="105" class="hm-g-sm">из ${FOCUS_GOAL / 60}:00</text>
    </svg>
    <button type="button" class="hm-btn" data-act="focus">${at ? `Идёт: ${esc(at.title)}` : 'Начать фокус'}</button>
  </section>`;
}
function soonHTML() {
  const list = upcoming(4);
  const t0 = today();
  const rows = list.map(it => `<button type="button" class="hm-soon-row" data-task="${it.t.id}">
      <span class="hm-time${it.day === t0 ? ' on' : ''}">${it.day === t0 ? it.start : WEEKDAYS[(parseISO(it.day).getDay() + 6) % 7]}</span>
      <span class="hm-soon-txt"><b>${esc(it.t.title || 'Без названия')}</b><small><i class="hm-dot" style="background:var(--mode-${it.t.mode})"></i>${esc(modeLabel(it.t.mode))} · ${it.start}–${it.end}</small></span>
    </button>`).join('');
  return `<section class="hm-soon glass hm-card">
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
      return `<button type="button" class="hm-ev${short}${done ? ' done' : ''}${live ? ' live' : ''}" data-task="${it.t.id}" style="--mc:var(--mode-${it.t.mode});top:${pos(it.s)}%;height:${(Math.max(it.e - it.s, 30) / span * 100).toFixed(2)}%;left:${(it.lane * w).toFixed(2)}%;width:calc(${w.toFixed(2)}% - 6px)">
        <b>${esc(it.t.title || 'Без названия')}</b><small>${it.start} – ${it.end}${live ? ' · идёт сейчас' : ''}</small></button>`;
    }).join('');
    const loose = st.list.filter(t => !plansForDay(t, d).length);
    body = `<div class="hm-tl">
      <div class="hm-tl-hours">${hours.join('')}</div>
      <div class="hm-tl-area">${lines.join('')}${evs}${nm >= h0 * 60 && nm <= h1 * 60 ? `<i class="hm-now" style="top:${pos(nm)}%"></i>` : ''}
        ${items.length ? '' : '<p class="hm-empty hm-tl-empty">На сегодня нет задач со временем</p>'}</div>
    </div>
    ${loose.length ? `<div class="hm-loose"><small>Без времени:</small>${loose.slice(0, 8).map(t => `<button type="button" class="hm-chip${isDone(t) ? ' done' : ''}" data-task="${t.id}" style="--mc:var(--mode-${t.mode})">${esc(t.title || 'Без названия')}</button>`).join('')}${loose.length > 8 ? `<small>+${loose.length - 8}</small>` : ''}</div>` : ''}`;
  } else {
    const list = st.list.slice().sort((a, b) => (isDoneOn(a, d) - isDoneOn(b, d)) || (a.priority - b.priority));
    body = `<div class="hm-list">${list.map(t => {
      const dn = isDoneOn(t, d);
      return `<div class="hm-row${dn ? ' done' : ''}" style="--mc:var(--mode-${t.mode})">
        <button type="button" class="hm-check" data-toggle="${t.id}" aria-label="${dn ? 'Вернуть' : 'Выполнить'}">${dn ? '✓' : ''}</button>
        <button type="button" class="hm-row-t" data-task="${t.id}">${esc(t.title || 'Без названия')}</button>
        <small>${esc(modeLabel(t.mode))}</small></div>`;
    }).join('') || '<p class="hm-empty">На сегодня задач нет</p>'}</div>`;
  }
  return `<section class="hm-hero glass hm-card">
    <div class="hm-hero-head">
      <h2>Сегодня</h2>
      <div class="hm-seg" role="group" aria-label="Режим">${MODES.map(m => `<button type="button" data-mode="${m.id}" aria-pressed="${state.mode === m.id}">${esc(m.short || m.label)}</button>`).join('')}</div>
      <span class="hm-flex"></span>
      <small class="hm-prog-t">${st.done} из ${st.total}</small><i class="hm-prog"><u style="width:${pct}%"></u></i>
      <div class="hm-seg" role="group" aria-label="Вид">
        <button type="button" data-tab="list" aria-pressed="${homeTab === 'list'}">Список</button>
        <button type="button" data-tab="timeline" aria-pressed="${homeTab === 'timeline'}">Таймлайн</button>
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
  const tile = (ico, on, big, sub, attrs, extra = '') => `<div role="button" tabindex="0" class="hm-tile glass hm-card" ${attrs}>
      <span class="hm-ico${on ? ' on' : ''}">${svg(ico, 18)}</span><span><b>${big}</b><small>${sub}</small></span>${extra}</div>`;
  return `<div class="hm-tiles">
    ${tile('focus', min > 0, fmtMin(min), 'фокус сегодня', 'data-act="focus"')}
    ${tile('kb', false, kbN, 'заметок в базе', 'data-go="kb"')}
    ${tile('fin', false, moneyShort(ms.expense), 'расходы за месяц', 'data-go="finance"')}
    ${tile('eye', state.hideDone, state.hideDone ? 'Скрыты' : 'Видны', 'выполненные задачи', 'data-act="hide" role="switch" aria-checked="' + state.hideDone + '"', `<i class="hm-tgl${state.hideDone ? ' on' : ''}"></i>`)}
  </div>`;
}
function chartHTML(fmap) {
  const ws = mondayOf(today());
  const t0 = today();
  const vals = WEEKDAYS.map((w, i) => { const d = addDays(ws, i); return { w, d, v: fmap.get(d) || 0 }; });
  const max = Math.max(60, ...vals.map(x => x.v));
  const sum = vals.reduce((a, x) => a + x.v, 0);
  return `<section class="hm-chart glass hm-card">
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

export function renderHomeView(el) {
  if (!el) return;
  _host = el;
  const st = todayStats();
  const fmap = focusByDay();
  el.innerHTML = `${sideHTML(st)}
    <div class="hm-left">${weekHTML()}${focusHTML(fmap)}${soonHTML()}</div>
    <div class="hm-main">${heroHTML(st)}<div class="hm-bottom">${tilesHTML(fmap)}${chartHTML(fmap)}</div></div>
    ${quickHTML()}`;
  if (!el.dataset.bound) bind(el);
  /* Линия «сейчас» и минуты фокуса — раз в минуту, пока экран открыт */
  clearInterval(_tick);
  _tick = setInterval(() => { if (!el.hidden && el.isConnected) renderHomeView(el); else clearInterval(_tick); }, 60000);
}

function bind(el) {
  el.dataset.bound = '1';
  el.addEventListener('click', e => {
    const b = e.target.closest('button, [role="button"]');
    if (!b || !el.contains(b)) return;
    if (b.dataset.go) return go(b.dataset.go);
    if (b.dataset.mode) return setMode(b.dataset.mode);
    if (b.dataset.tab) { homeTab = b.dataset.tab; return renderHomeView(el); }
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
  document.addEventListener('sync-status', e => {
    syncState = e.detail;
    if (_host && !_host.hidden && state.view === 'home') renderHomeView(_host);
  });
  document.addEventListener('timer-changed', () => {
    if (_host && !_host.hidden && state.view === 'home') renderHomeView(_host);
  });
}
