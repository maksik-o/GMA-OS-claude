/* ══════════════════════════════════════════════════════════════════
   Режим «Финансы»
   Всё хранится в одном сторе IndexedDB ('finance'); тип записи —
   поле kind. Так не нужно плодить сторы под каждую сущность и
   поднимать версию БД при каждом новом справочнике.
   ══════════════════════════════════════════════════════════════════ */
import { dbAll, dbPut, dbBulk } from './db.js';
import { uid, esc, today, iso, parseISO, addDays, MONTHS, MONTHS_FULL } from './store.js';
import { readFinanceFile, detectColumns, rowsToTx, fingerprint, toCSV, download } from './finimport.js';
import { rowBrickSwap, contentFade } from './anim.js';
import { getPeople } from './contacts.js';

const STORE = 'finance';
const state = { items: [] };
const listeners = [];
export const financeSubscribe = fn => listeners.push(fn);
let pending = false;
const notify = () => {
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; listeners.forEach(fn => fn()); }, 60);
};
const userChange = () => document.dispatchEvent(new CustomEvent('user-change'));

/* ── Справочники ── */
export const ACC_TYPES = [
  { id: 'card',   label: 'Карта',        icon: '💳', side: 'asset' },
  { id: 'cash',   label: 'Наличные',     icon: '💵', side: 'asset' },
  { id: 'bank',   label: 'Счёт в банке', icon: '🏦', side: 'asset' },
  { id: 'wallet', label: 'Кошелёк',      icon: '📱', side: 'asset' },
  { id: 'invest', label: 'Инвестиции',   icon: '📈', side: 'asset' },
  { id: 'estate', label: 'Имущество',    icon: '🏠', side: 'asset' },
  { id: 'credit', label: 'Кредитка',     icon: '🧾', side: 'debt'  },
  { id: 'loan',   label: 'Кредит',       icon: '🏛', side: 'debt'  },
];
const accType = id => ACC_TYPES.find(t => t.id === id) || ACC_TYPES[0];
export const isDebt = a => accType(a.type).side === 'debt';

const PALETTE = ['#ef4444', '#f59e0b', '#10b981', '#2563eb', '#8b5cf6', '#ec4899',
                 '#06b6d4', '#84cc16', '#f97316', '#6366f1', '#14b8a6', '#e879f9'];

const DEFAULT_CATS = [
  ['Продукты', 'expense', '#10b981'], ['Кафе и рестораны', 'expense', '#f59e0b'],
  ['Транспорт', 'expense', '#2563eb'], ['Жильё и ЖКХ', 'expense', '#8b5cf6'],
  ['Здоровье', 'expense', '#ef4444'], ['Покупки', 'expense', '#ec4899'],
  ['Развлечения', 'expense', '#06b6d4'], ['Связь и подписки', 'expense', '#6366f1'],
  ['Дети', 'expense', '#84cc16'], ['Прочее', 'expense', '#94a3b8'],
  ['Зарплата', 'income', '#10b981'], ['Премия', 'income', '#f59e0b'],
  ['Подработка', 'income', '#2563eb'], ['Возврат', 'income', '#8b5cf6'],
  ['Прочий доход', 'income', '#94a3b8'],
];

/* ── Утилиты ── */
export const monthOf = d => String(d).slice(0, 7);
export const curMonth = () => monthOf(today());
export const monthTitle = m => `${MONTHS_FULL[+m.slice(5, 7) - 1].replace(/я$/, 'ь').replace(/а$/, '')} ${m.slice(0, 4)}`;
export const monthShort = m => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(2, 4)}`;
export const shiftMonth = (m, n) => {
  const d = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
export function money(v, opts) {
  const sign = v < 0 ? '−' : '';
  const n = Math.abs(Number(v) || 0);
  const s = n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${(opts && opts.noCur) ? '' : '₽'}${s}`;
}
export function moneyShort(v) {
  const n = Math.abs(Number(v) || 0);
  const sign = v < 0 ? '−' : '';
  if (n >= 1e6) return sign + '₽' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' млн';
  if (n >= 1e4) return sign + '₽' + (n / 1e3).toFixed(0) + ' тыс';
  return money(v);
}

/* ── Данные ── */
const all = kind => state.items.filter(i => i.kind === kind && !i.deleted);
export const getAccounts = () => all('account').sort((a, b) => (a.order || 0) - (b.order || 0));
export const getCategories = flow => all('cat').filter(c => !flow || c.flow === flow);
export const getBudgets = () => all('budget');
export const getTxs = () => all('tx');
export const getItem = id => state.items.find(i => i.id === id);
export const catById = id => state.items.find(i => i.id === id && i.kind === 'cat');
export const accById = id => state.items.find(i => i.id === id && i.kind === 'account');

export async function init() {
  state.items = await dbAll(STORE);
  if (!all('cat').length) {
    const seed = DEFAULT_CATS.map(([name, flow, color], i) => ({
      id: uid(), kind: 'cat', name, flow, color, order: i,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    state.items.push(...seed);
    for (const c of seed) await dbPut(STORE, c);
  }
}
async function put(item) {
  item.updatedAt = new Date().toISOString();
  await dbPut(STORE, item);
  notify();
  userChange();
}
export async function saveItem(kind, data, id) {
  let it = id ? getItem(id) : null;
  if (!it) {
    it = { id: uid(), kind, createdAt: new Date().toISOString() };
    state.items.push(it);
  }
  Object.assign(it, data);
  await put(it);
  return it;
}
export async function removeItem(id) {
  const it = getItem(id);
  if (!it) return;
  it.deleted = true;
  await put(it);
}

/* ── Синхронизация (совместимо с остальными модулями) ── */
export const getFinanceForSync = () => state.items;
export const getFinanceTombstones = () => state.items.filter(i => i.deleted).map(i => i.id);
export async function applyFinanceMerged(list) {
  const remote = Array.isArray(list) ? list : [];
  const byId = new Map();
  for (const i of state.items) if (i && i.id) byId.set(i.id, i);
  for (const r of remote) {
    if (!r || !r.id) continue;
    const local = byId.get(r.id);
    if (!local || String(r.updatedAt || '') >= String(local.updatedAt || '')) byId.set(r.id, r);
  }
  state.items = [...byId.values()];
  try { await dbBulk(STORE, state.items); } catch (e) { console.error('[finance] dbBulk:', e); }
  notify();
}

/* ══════════════ АНАЛИТИКА ══════════════ */
/* Баланс счёта = стартовый остаток + приходы − расходы ± переводы.
   Для долговых счетов (кредит, кредитка) баланс отрицательный. */
export function accountBalance(accId) {
  const a = accById(accId);
  if (!a) return 0;
  let b = Number(a.balance) || 0;
  for (const t of getTxs()) {
    const amt = Number(t.amount) || 0;
    if (t.type === 'income' && t.accountId === accId) b += amt;
    else if (t.type === 'expense' && t.accountId === accId) b -= amt;
    else if (t.type === 'transfer') {
      if (t.accountId === accId) b -= amt;
      if (t.toAccountId === accId) b += amt;
    }
  }
  return b;
}
export function totals() {
  let assets = 0, debts = 0;
  for (const a of getAccounts()) {
    const b = accountBalance(a.id);
    /* Долг — это отрицательный остаток. Переплата в плюс долгом не является. */
    if (isDebt(a)) debts += Math.max(0, -b);
    else assets += b;
  }
  return { assets, debts, net: assets - debts };
}
/* ── Кредиты и кредитки ──
   Платёж по кредиту — это перевод с обычного счёта на долговой:
   баланс источника падает, отрицательный остаток долга подрастает
   к нулю. Здесь считаем только «когда и сколько платить». */
export function debtRows() {
  const t0 = today();
  return getAccounts().filter(isDebt).map(a => {
    const bal = accountBalance(a.id);
    const owed = Math.max(0, -bal);
    const start = Math.abs(Number(a.balance) || 0);
    const paid = Math.max(0, start - owed);
    const due = nextDueDate(a.dueDay, t0);
    const days = due ? Math.round((parseISO(due) - parseISO(t0)) / 86400000) : null;
    return {
      id: a.id, name: a.name, type: a.type, color: a.color || '#94a3b8',
      owed, start, paid,
      pct: start > 0 ? Math.min(100, (paid / start) * 100) : (owed ? 0 : 100),
      payment: Number(a.payment) || 0,
      rate: Number(a.rate) || 0,
      dueDay: Number(a.dueDay) || 0, due, days,
      paidThisMonth: paymentsTo(a.id, curMonth()),
    };
  }).sort((x, y) => (x.days == null ? 1e9 : x.days) - (y.days == null ? 1e9 : y.days));
}
export function nextDueDate(day, from) {
  const d = Number(day) || 0;
  if (d < 1 || d > 31) return '';
  const base = parseISO(from || today());
  const mk = (y, m) => {
    const dim = new Date(y, m + 1, 0).getDate();
    return iso(new Date(y, m, Math.min(d, dim)));
  };
  const thisM = mk(base.getFullYear(), base.getMonth());
  if (thisM >= (from || today())) return thisM;
  return mk(base.getFullYear(), base.getMonth() + 1);
}
/* Сколько уже внесено на этот долговой счёт в указанном месяце */
export function paymentsTo(accId, m) {
  let sum = 0;
  for (const t of txsInMonth(m)) {
    if (t.type === 'transfer' && t.toAccountId === accId) sum += Number(t.amount) || 0;
    if (t.type === 'income' && t.accountId === accId) sum += Number(t.amount) || 0;
  }
  return sum;
}
/* Кто сколько потратил — для совместного бюджета */
export function byPerson(m) {
  const map = new Map();
  for (const t of txsInMonth(m)) {
    if (t.type === 'transfer') continue;
    const key = t.personId || '';
    const cur = map.get(key) || { id: key, name: personName(key), income: 0, expense: 0, count: 0 };
    if (t.type === 'income') cur.income += Number(t.amount) || 0;
    else cur.expense += Number(t.amount) || 0;
    cur.count++;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.expense - a.expense);
}
export function personName(id) {
  if (!id) return 'Без отметки';
  const p = getPeople('all').find(x => x.id === id);
  return p ? p.name : 'Удалён';
}
export function txsInMonth(m) {
  return getTxs().filter(t => monthOf(t.date) === m);
}
export function monthStats(m) {
  const list = txsInMonth(m);
  let income = 0, expense = 0;
  for (const t of list) {
    const a = Number(t.amount) || 0;
    if (t.type === 'income') income += a;
    else if (t.type === 'expense') expense += a;
  }
  const days = new Set(list.map(t => t.date)).size;
  return {
    income, expense, balance: income - expense, count: list.length, days,
    savings: income > 0 ? ((income - expense) / income) * 100 : (expense > 0 ? -100 : 0),
    perDay: days ? expense / days : 0,
  };
}
export function byCategory(m, flow) {
  const map = new Map();
  for (const t of txsInMonth(m)) {
    if (t.type !== flow) continue;
    const c = catById(t.categoryId);
    const key = c ? c.id : 'none';
    const cur = map.get(key) || { id: key, name: c ? c.name : 'Без категории', color: c ? c.color : '#94a3b8', sum: 0, count: 0 };
    cur.sum += Number(t.amount) || 0;
    cur.count++;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.sum - a.sum);
}
export function yearHeatmap(year) {
  const out = [];
  for (let i = 1; i <= 12; i++) {
    const m = `${year}-${String(i).padStart(2, '0')}`;
    out.push({ m, i, sum: monthStats(m).expense });
  }
  return out;
}
export function lastMonths(n, endMonth) {
  const out = [];
  let m = endMonth || curMonth();
  for (let i = n - 1; i >= 0; i--) out.push(shiftMonth(m, -i));
  return out.map(mm => ({ m: mm, ...monthStats(mm) }));
}
export function budgetProgress(m) {
  const spent = new Map(byCategory(m, 'expense').map(c => [c.id, c.sum]));
  return getBudgets()
    .filter(b => !b.month || b.month === m)
    .map(b => {
      const c = catById(b.categoryId);
      const used = spent.get(b.categoryId) || 0;
      return {
        id: b.id, name: c ? c.name : 'Категория', color: c ? c.color : '#94a3b8',
        limit: Number(b.limit) || 0, used,
        pct: b.limit ? Math.min(999, (used / b.limit) * 100) : 0,
      };
    })
    .sort((a, b) => b.pct - a.pct);
}

/* ══════════════ ГРАФИКА (инлайн-SVG, без библиотек) ══════════════ */
function donutSVG(parts, centerTop, centerMain, centerSub) {
  const total = parts.reduce((s, p) => s + p.sum, 0);
  const R = 62, r = 42, C = 80;
  if (!total) {
    return `<svg class="fin-donut" viewBox="0 0 160 160"><circle cx="80" cy="80" r="${(R + r) / 2}" fill="none" stroke="color-mix(in srgb, currentColor 12%, transparent)" stroke-width="${R - r}"/>
      <text x="80" y="80" class="fd-main" text-anchor="middle">—</text></svg>`;
  }
  let a0 = -Math.PI / 2;
  const seg = parts.map(p => {
    const a1 = a0 + (p.sum / total) * Math.PI * 2;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const pt = (ang, rad) => `${(C + rad * Math.cos(ang)).toFixed(2)} ${(C + rad * Math.sin(ang)).toFixed(2)}`;
    const d = `M ${pt(a0, R)} A ${R} ${R} 0 ${big} 1 ${pt(a1, R)} L ${pt(a1, r)} A ${r} ${r} 0 ${big} 0 ${pt(a0, r)} Z`;
    a0 = a1;
    return `<path d="${d}" fill="${p.color}" opacity=".92"/>`;
  }).join('');
  return `<svg class="fin-donut" viewBox="0 0 160 160">${seg}
    <text x="80" y="66" class="fd-top" text-anchor="middle">${esc(centerTop || '')}</text>
    <text x="80" y="86" class="fd-main" text-anchor="middle">${esc(centerMain || '')}</text>
    <text x="80" y="102" class="fd-sub" text-anchor="middle">${esc(centerSub || '')}</text></svg>`;
}
function sparkSVG(values) {
  const W = 300, H = 72;
  if (values.length < 2) return `<svg class="fin-spark" viewBox="0 0 ${W} ${H}"></svg>`;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [i / (values.length - 1) * W, H - 6 - ((v - min) / span) * (H - 14)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  return `<svg class="fin-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${area}" fill="url(#finGrad)" opacity=".35"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <defs><linearGradient id="finGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs></svg>`;
}
function barsHTML(rows) {
  const max = Math.max(1, ...rows.map(r => Math.max(r.income, r.expense)));
  return `<div class="fin-bars">${rows.map(r => `<div class="fb-col">
    <div class="fb-stack">
      <i class="fb-bar exp" style="height:${(r.expense / max * 100).toFixed(1)}%" title="Расход ${money(r.expense)}"></i>
      <i class="fb-bar inc" style="height:${(r.income / max * 100).toFixed(1)}%" title="Доход ${money(r.income)}"></i>
    </div>
    <span class="fb-lab">${monthShort(r.m)}</span>
  </div>`).join('')}</div>
  <div class="fin-legend"><span><i style="background:var(--c-skipped)"></i>Расход</span><span><i style="background:var(--c-done)"></i>Доход</span></div>`;
}
function rankHTML(list, tone) {
  const max = Math.max(1, ...list.map(x => x.sum));
  if (!list.length) return '<p class="empty">Пока нет данных</p>';
  return `<div class="fin-rank">${list.map((x, i) => `<div class="fr-row">
    <span class="fr-n">${i + 1}</span>
    <span class="fr-name">${esc(x.name)}</span>
    <span class="fr-cnt">${x.count} оп.</span>
    <span class="fr-sum">${money(x.sum)}</span>
    <i class="fr-track"><u style="width:${Math.min(100, x.sum / max * 100).toFixed(1)}%;background:${tone || x.color}"></u></i>
  </div>`).join('')}</div>`;
}

/* ══════════════ ПРЕДСТАВЛЕНИЕ ══════════════ */
const FIN_BRICKS = '.fin-hero, .fs-card, .fin-card, .ftx-day, .fin-txbar, .fin-sep';
let curM = curMonth();
let tab = 'dash';
let _host = null;

export function renderFinanceView(el) {
  if (!el) return;
  _host = el;
  el.innerHTML = `
    <header class="fin-head">
      <div class="fin-tabs">
        ${[['dash', 'Обзор'], ['tx', 'Операции'], ['acc', 'Счета'], ['plan', 'Планы']]
          .map(([id, l]) => `<button type="button" class="fin-tab${tab === id ? ' on' : ''}" data-tab="${id}">${l}</button>`).join('')}
      </div>
      <div class="fin-monthnav">
        <button type="button" class="fin-arrow" data-mo="-1">‹</button>
        <button type="button" class="fin-month" title="Текущий месяц">${monthTitle(curM)}</button>
        <button type="button" class="fin-arrow" data-mo="1">›</button>
        <button type="button" class="fin-io" title="Импорт и экспорт">⇅</button>
      </div>
    </header>
    <div class="fin-body"></div>
    <button type="button" class="fin-fab" title="Новая операция">+</button>`;
  const TABS = ['dash', 'tx', 'acc', 'plan'];
  /* Смена вкладки — кирпичики по рядам: опустевший ряд заполняется
     сразу, не дожидаясь остальных. */
  el.querySelectorAll('.fin-tab').forEach(b => b.onclick = () => {
    if (b.dataset.tab === tab) return;
    const dir = TABS.indexOf(b.dataset.tab) > TABS.indexOf(tab) ? 1 : -1;
    rowBrickSwap(el, dir, FIN_BRICKS, () => { tab = b.dataset.tab; renderFinanceView(el); });
  });
  /* Стрелки месяцев блоки не двигают */
  el.querySelectorAll('.fin-arrow').forEach(b => b.onclick = () => {
    const dir = +b.dataset.mo;
    contentFade(() => { curM = shiftMonth(curM, dir); renderFinanceView(el); },
      { dir, selector: '.finance-view .fin-body' });
  });
  el.querySelector('.fin-month').onclick = () =>
    contentFade(() => { curM = curMonth(); renderFinanceView(el); },
      { dir: 1, selector: '.finance-view .fin-body' });
  el.querySelector('.fin-fab').onclick = () => openTxSheet(null);
  el.querySelector('.fin-io').onclick = () => openIOSheet();
  const body = el.querySelector('.fin-body');
  if (tab === 'dash') renderDash(body);
  else if (tab === 'tx') renderTxList(body);
  else if (tab === 'acc') renderAccounts(body);
  else renderPlans(body);
}
function animateBody(el, dir) {
  const body = el.querySelector('.fin-body');
  if (!body) return;
  const cards = body.querySelectorAll('.fin-hero, .fs-card, .fin-card, .ftx-day');
  if (cards.length) stagger(cards, dir, { shift: 22, step: 18, max: 12 });
  else slideIn(body, dir);
}
const rerender = () => { if (_host) renderFinanceView(_host); };

/* ── Обзор ── */
function renderDash(box) {
  const s = monthStats(curM);
  const t = totals();
  const cats = byCategory(curM, 'expense');
  const top = cats.slice(0, 5);
  const rest = cats.slice(5);
  const donutParts = rest.length
    ? [...top, { id: 'other', name: 'Прочее', color: '#94a3b8', sum: rest.reduce((a, c) => a + c.sum, 0), count: 0 }]
    : top;
  const year = curM.slice(0, 4);
  const heat = yearHeatmap(year);
  const heatMax = Math.max(1, ...heat.map(h => h.sum));
  const six = lastMonths(6, curM);
  const accParts = getAccounts().filter(a => !isDebt(a))
    .map((a, i) => ({ id: a.id, name: a.name, color: a.color || PALETTE[i % PALETTE.length], sum: Math.max(0, accountBalance(a.id)) }))
    .filter(p => p.sum > 0).sort((a, b) => b.sum - a.sum);
  const trend = [];
  {
    let run = 0;
    const days = [...txsInMonth(curM)].sort((a, b) => a.date.localeCompare(b.date));
    const byDay = new Map();
    for (const tx of days) {
      const d = Number(tx.amount) || 0;
      byDay.set(tx.date, (byDay.get(tx.date) || 0) + (tx.type === 'income' ? d : tx.type === 'expense' ? -d : 0));
    }
    const first = `${curM}-01`;
    const dim = new Date(+curM.slice(0, 4), +curM.slice(5, 7), 0).getDate();
    for (let i = 0; i < dim; i++) {
      run += byDay.get(addDays(first, i)) || 0;
      trend.push(run);
    }
  }
  const budgets = budgetProgress(curM);
  const debts = debtRows();
  const persons = byPerson(curM).filter(pp => pp.id);

  box.innerHTML = `
  <section class="fin-hero glass">
    <div class="fh-left">
      <div class="fh-cap">Баланс месяца</div>
      <div class="fh-sum ${s.balance < 0 ? 'neg' : 'pos'}">${money(s.balance)}</div>
      <div class="fh-kpis">
        <div class="fk"><span class="fk-l">Доход</span><b class="fk-v pos">${money(s.income)}</b></div>
        <div class="fk"><span class="fk-l">Расход</span><b class="fk-v neg">${money(s.expense)}</b></div>
        <div class="fk"><span class="fk-l">Операций</span><b class="fk-v">${s.count}</b></div>
        <div class="fk"><span class="fk-l">Дней с записями</span><b class="fk-v">${s.days}</b></div>
      </div>
    </div>
    <div class="fh-right">
      <div class="fh-cap">Динамика баланса за месяц</div>
      ${sparkSVG(trend.length > 1 ? trend : [0, 0])}
    </div>
  </section>

  <section class="fin-stats">
    <div class="fs-card glass fs-save">
      <div class="fs-cap">Норма сбережений</div>
      <div class="fs-val ${s.savings < 0 ? 'neg' : 'pos'}">${s.savings.toFixed(1)}%</div>
      <div class="fs-bar"><i style="width:${Math.min(100, Math.max(0, s.savings)).toFixed(0)}%"></i></div>
      <div class="fs-sub">${s.savings < 0 ? 'Расходы превысили доход' : 'От дохода остаётся в плюсе'}</div>
    </div>
    <div class="fs-card glass fs-day">
      <div class="fs-cap">Расход в день</div>
      <div class="fs-val">${money(s.perDay)}</div>
      <div class="fs-sub">${s.days} дн · всего ${money(s.expense)}</div>
    </div>
    <div class="fs-card glass fs-net">
      <div class="fs-cap">Чистый капитал</div>
      <div class="fs-val ${t.net < 0 ? 'neg' : 'pos'}">${moneyShort(t.net)}</div>
      <div class="fs-sub">Активы ${moneyShort(t.assets)} · долги ${moneyShort(t.debts)}</div>
    </div>
  </section>

  <div class="fin-sep">Аналитика</div>

  <div class="fin-grid">
    <section class="fin-card glass">
      <header class="fc-head"><h4>Расходы по категориям</h4><span class="fc-sub">${money(s.expense)}</span></header>
      <div class="fc-donut-row">
        ${donutSVG(donutParts, 'Расход', moneyShort(s.expense), `${cats.length} кат.`)}
        <div class="fc-legend">${donutParts.length ? donutParts.map(p => `<div class="fl-row">
          <i style="background:${p.color}"></i><span class="fl-name">${esc(p.name)}</span>
          <span class="fl-pct">${s.expense ? (p.sum / s.expense * 100).toFixed(1) : '0.0'}%</span>
          <span class="fl-sum">${money(p.sum)}</span></div>`).join('') : '<p class="empty">Расходов пока нет</p>'}</div>
      </div>
    </section>

    <section class="fin-card glass">
      <header class="fc-head"><h4>Расходы по месяцам · ${year}</h4><span class="fc-sub">темнее = больше</span></header>
      <div class="fin-heat">${heat.map(h => `<button type="button" class="fh-cell${h.m === curM ? ' on' : ''}" data-m="${h.m}" style="background:color-mix(in srgb, var(--c-skipped) ${(6 + (h.sum / heatMax) * 56).toFixed(1)}%, transparent)">
        <b>${h.i}</b><span>${h.sum ? moneyShort(h.sum).replace('₽', '') : '—'}</span></button>`).join('')}</div>
    </section>

    <section class="fin-card glass">
      <header class="fc-head"><h4>Состав активов</h4><span class="fc-sub">${moneyShort(t.assets)}</span></header>
      <div class="fc-donut-row">
        ${donutSVG(accParts, 'Активы', moneyShort(t.assets), t.debts ? `долги ${moneyShort(t.debts)}` : '')}
        <div class="fc-legend">${accParts.length ? accParts.map(p => `<div class="fl-row">
          <i style="background:${p.color}"></i><span class="fl-name">${esc(p.name)}</span>
          <span class="fl-pct">${t.assets ? (p.sum / t.assets * 100).toFixed(1) : '0.0'}%</span>
          <span class="fl-sum">${moneyShort(p.sum)}</span></div>`).join('') : '<p class="empty">Добавьте счета на вкладке «Счета»</p>'}</div>
      </div>
    </section>

    <section class="fin-card glass">
      <header class="fc-head"><h4>Последние 6 месяцев</h4></header>
      ${barsHTML(six)}
    </section>

    <section class="fin-card glass">
      <header class="fc-head"><h4>Топ-5 расходов</h4></header>
      ${rankHTML(top)}
    </section>

    <section class="fin-card glass">
      <header class="fc-head"><h4>Топ-5 доходов</h4></header>
      ${rankHTML(byCategory(curM, 'income').slice(0, 5))}
    </section>

    <section class="fin-card glass">
      <header class="fc-head"><h4>Счета</h4><span class="fc-sub">${getAccounts().length}</span></header>
      ${accRowsHTML()}
    </section>

    ${debts.length ? `<section class="fin-card glass fin-debts">
      <header class="fc-head"><h4>Кредиты и задолженности</h4><span class="fc-sub">${moneyShort(t.debts)}</span></header>
      ${debts.map(d => `<div class="fd-row" data-id="${d.id}">
        <div class="fd-top">
          <span class="fd-name">${esc(d.name)}</span>
          <b class="fd-owed neg">${money(d.owed)}</b>
        </div>
        <div class="fd-track"><i style="width:${d.pct.toFixed(1)}%;background:${d.color}"></i></div>
        <div class="fd-meta">
          ${d.due ? `<span class="${d.days != null && d.days <= 3 ? 'soon' : ''}">Платёж ${+d.due.slice(8)} ${MONTHS[+d.due.slice(5, 7) - 1]}${d.days != null ? ` · через ${d.days} дн.` : ''}</span>` : '<span>День платежа не задан</span>'}
          ${d.payment ? `<span>по ${money(d.payment)}</span>` : ''}
          ${d.rate ? `<span>${d.rate}%</span>` : ''}
          <span class="${d.paidThisMonth >= d.payment && d.payment ? 'ok' : ''}">внесено ${money(d.paidThisMonth)}</span>
        </div>
      </div>`).join('')}
      <button type="button" class="btn mini fin-pay-debt">Внести платёж</button>
    </section>` : ''}

    ${persons.length > 1 ? `<section class="fin-card glass">
      <header class="fc-head"><h4>Кто тратит</h4><span class="fc-sub">${persons.length} чел.</span></header>
      ${rankHTML(persons.map(pp => ({ name: pp.name, count: pp.count, sum: pp.expense, color: '#8b5cf6' })))}
    </section>` : ''}

    <section class="fin-card glass">
      <header class="fc-head"><h4>Планы на месяц</h4></header>
      ${budgets.length ? `<div class="fin-budgets">${budgets.map(b => `<div class="fb-row">
        <span class="fb-name">${esc(b.name)}</span>
        <span class="fb-num">${money(b.used)} / ${money(b.limit)}</span>
        <div class="fb-track"><i style="width:${Math.min(100, b.pct).toFixed(1)}%;background:${b.pct > 100 ? 'var(--c-skipped)' : b.color}"></i></div>
      </div>`).join('')}</div>` : '<p class="empty">Планы задаются на вкладке «Планы»</p>'}
    </section>
  </div>`;

  box.querySelectorAll('.fh-cell').forEach(b => b.onclick = () => { curM = b.dataset.m; rerender(); });
  box.querySelectorAll('.fd-row').forEach(r => r.onclick = () => openAccSheet(r.dataset.id));
  const pay = box.querySelector('.fin-pay-debt');
  if (pay) pay.onclick = e => { e.stopPropagation(); openTxSheet(null, { type: 'transfer', toAccountId: (debts[0] || {}).id }); };
}
function accRowsHTML() {
  const list = getAccounts();
  if (!list.length) return '<p class="empty">Счетов пока нет</p>';
  const max = Math.max(1, ...list.map(a => Math.abs(accountBalance(a.id))));
  return `<div class="fin-accs">${list.map((a, i) => {
    const b = accountBalance(a.id);
    const color = a.color || PALETTE[i % PALETTE.length];
    return `<div class="fa-row" data-id="${a.id}">
      <span class="fa-ico" style="background:color-mix(in srgb, ${color} 22%, transparent)">${accType(a.type).icon}</span>
      <span class="fa-name">${esc(a.name)}<i>${accType(a.type).label}</i></span>
      <span class="fa-sum ${b < 0 ? 'neg' : 'pos'}">${money(b)}</span>
      <i class="fa-track"><u style="width:${Math.min(100, Math.abs(b) / max * 100).toFixed(1)}%;background:${b < 0 ? 'var(--c-skipped)' : color}"></u></i>
    </div>`;
  }).join('')}</div>`;
}

/* ── Операции ── */
let selected = new Set();
let selMode = false;
export async function removeTxs(ids) {
  for (const id of ids) await removeItem(id);
}
function renderTxList(box) {
  const list = txsInMonth(curM).sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
  if (!list.length) {
    selMode = false;
    selected.clear();
    box.innerHTML = '<p class="empty">В этом месяце операций нет. Нажмите «+», чтобы добавить.</p>';
    return;
  }
  /* Отметки живут только внутри текущего месяца: ушли из месяца — сбросили */
  const ids = new Set(list.map(t => t.id));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);

  const groups = new Map();
  for (const t of list) {
    if (!groups.has(t.date)) groups.set(t.date, []);
    groups.get(t.date).push(t);
  }
  box.innerHTML = `
  <div class="fin-txbar${selMode ? ' on' : ''}">
    <button type="button" class="btn mini ftb-mode">${selMode ? 'Готово' : 'Выбрать'}</button>
    ${selMode ? `<button type="button" class="btn mini ftb-all">${selected.size === list.length ? 'Снять всё' : 'Выбрать всё'}</button>
      <span class="ftb-count">${selected.size}</span>
      <button type="button" class="btn mini danger ftb-del"${selected.size ? '' : ' disabled'}>Удалить</button>`
    : `<span class="ftb-info">${list.length} оп. · ${money(monthStats(curM).expense)} расход</span>
       <button type="button" class="btn mini danger ftb-wipe">Удалить все</button>`}
  </div>
  <div class="fin-txlist${selMode ? ' selecting' : ''}">${[...groups.entries()].map(([d, arr]) => {
    const sum = arr.reduce((s2, t) => s2 + (t.type === 'income' ? 1 : t.type === 'expense' ? -1 : 0) * (Number(t.amount) || 0), 0);
    return `<div class="ftx-day">
      <div class="ftx-dayhead">
        ${selMode ? `<button type="button" class="ftx-check day" data-day="${d}"></button>` : ''}
        <span>${+d.slice(8)} ${MONTHS[+d.slice(5, 7) - 1]}</span><b class="${sum < 0 ? 'neg' : 'pos'}">${money(sum)}</b></div>
      ${arr.map(t => {
        const c = catById(t.categoryId);
        const a = accById(t.accountId);
        const to = accById(t.toAccountId);
        const label = t.type === 'transfer' ? `Перевод${to ? ' → ' + esc(to.name) : ''}` : (c ? esc(c.name) : 'Без категории');
        const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
        const who = t.personId ? personName(t.personId) : '';
        return `<div class="ftx-row${selected.has(t.id) ? ' picked' : ''}" data-id="${t.id}">
          ${selMode ? `<button type="button" class="ftx-check"></button>` : ''}
          <span class="ftx-dot" style="background:${t.type === 'transfer' ? 'var(--c-postponed)' : (c ? c.color : '#94a3b8')}"></span>
          <span class="ftx-body"><b>${label}</b><i>${esc(a ? a.name : '')}${t.note ? ' · ' + esc(t.note) : ''}</i></span>
          ${who ? `<span class="ftx-who" title="Кто провёл">${esc(who)}</span>` : ''}
          <span class="ftx-amt ${t.type}">${sign}${money(Number(t.amount) || 0)}</span>
        </div>`;
      }).join('')}
    </div>`;
  }).join('')}</div>`;

  const bar = box.querySelector('.fin-txbar');
  bar.querySelector('.ftb-mode').onclick = () => {
    selMode = !selMode;
    if (!selMode) selected.clear();
    renderTxList(box);
  };
  const all = bar.querySelector('.ftb-all');
  if (all) all.onclick = () => {
    if (selected.size === list.length) selected.clear();
    else list.forEach(t => selected.add(t.id));
    renderTxList(box);
  };
  const del = bar.querySelector('.ftb-del');
  if (del) del.onclick = async () => {
    const n = selected.size;
    if (!n || !confirm(`Удалить ${n} ${n === 1 ? 'операцию' : 'операций'}?`)) return;
    await removeTxs([...selected]);
    selected.clear();
    selMode = false;
    rerender();
  };
  const wipe = bar.querySelector('.ftb-wipe');
  if (wipe) wipe.onclick = async () => {
    if (!confirm(`Удалить все ${list.length} операций за ${monthTitle(curM)}? Счета и категории останутся.`)) return;
    await removeTxs(list.map(t => t.id));
    rerender();
  };
  box.querySelectorAll('.ftx-check.day').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const arr = groups.get(b.dataset.day) || [];
    const allOn = arr.every(t => selected.has(t.id));
    arr.forEach(t => allOn ? selected.delete(t.id) : selected.add(t.id));
    renderTxList(box);
  });
  box.querySelectorAll('.ftx-row').forEach(r => r.onclick = () => {
    if (!selMode) { openTxSheet(r.dataset.id); return; }
    const id = r.dataset.id;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    renderTxList(box);
  });
}

/* ── Счета ── */
function renderAccounts(box) {
  const t = totals();
  box.innerHTML = `<div class="fin-stack">
    <section class="fin-card glass">
      <header class="fc-head"><h4>Итого</h4></header>
      <div class="fin-sumrow">
        <div><span>Активы</span><b class="pos">${money(t.assets)}</b></div>
        <div><span>Долги</span><b class="neg">${money(t.debts)}</b></div>
        <div><span>Чистыми</span><b class="${t.net < 0 ? 'neg' : 'pos'}">${money(t.net)}</b></div>
      </div>
    </section>
    <section class="fin-card glass">
      <header class="fc-head"><h4>Счета и обязательства</h4>
        <button type="button" class="btn mini fin-add-acc">＋ Счёт</button></header>
      ${accRowsHTML()}
    </section>
    <section class="fin-card glass">
      <header class="fc-head"><h4>Категории</h4>
        <button type="button" class="btn mini fin-add-cat">＋ Категория</button></header>
      <div class="fin-cats">${['expense', 'income'].map(flow => `
        <div class="fcat-group"><div class="fcat-cap">${flow === 'expense' ? 'Расходы' : 'Доходы'}</div>
        ${getCategories(flow).map(c => `<button type="button" class="fcat-chip" data-id="${c.id}" style="--cc:${c.color}">${esc(c.name)}</button>`).join('') || '<p class="empty">Пусто</p>'}
        </div>`).join('')}</div>
    </section></div>`;
  box.querySelector('.fin-add-acc').onclick = () => openAccSheet(null);
  box.querySelector('.fin-add-cat').onclick = () => openCatSheet(null);
  box.querySelectorAll('.fa-row').forEach(r => r.onclick = () => openAccSheet(r.dataset.id));
  box.querySelectorAll('.fcat-chip').forEach(r => r.onclick = () => openCatSheet(r.dataset.id));
}

/* ── Планы (бюджеты) ── */
function renderPlans(box) {
  const rows = budgetProgress(curM);
  box.innerHTML = `<div class="fin-stack">
    <section class="fin-card glass">
      <header class="fc-head"><h4>Лимиты на ${monthTitle(curM)}</h4>
        <button type="button" class="btn mini fin-add-bud">＋ Лимит</button></header>
      ${rows.length ? `<div class="fin-budgets big">${rows.map(b => `<div class="fb-row" data-id="${b.id}">
        <span class="fb-name">${esc(b.name)}</span>
        <span class="fb-num ${b.pct > 100 ? 'neg' : ''}">${money(b.used)} / ${money(b.limit)}</span>
        <div class="fb-track"><i style="width:${Math.min(100, b.pct).toFixed(1)}%;background:${b.pct > 100 ? 'var(--c-skipped)' : b.color}"></i></div>
        <span class="fb-pct ${b.pct > 100 ? 'neg' : ''}">${b.pct.toFixed(0)}%</span>
      </div>`).join('')}</div>` : '<p class="empty">Лимитов нет. Задайте предел по категории — и увидите, сколько уже потрачено.</p>'}
    </section></div>`;
  box.querySelector('.fin-add-bud').onclick = () => openBudgetSheet(null);
  box.querySelectorAll('.fb-row[data-id]').forEach(r => r.onclick = () => openBudgetSheet(r.dataset.id));
}

/* ══════════════ ФОРМЫ ══════════════ */
function modal(title, inner, onSave, onDelete) {
  const ov = document.createElement('div');
  ov.className = 'notes-list-overlay fin-overlay';
  ov.innerHTML = `<div class="notes-list-modal glass fin-modal">
    <header class="notes-list-head"><h3>${esc(title)}</h3>
      <button type="button" class="notes-list-close">✕</button></header>
    <div class="fin-form">${inner}</div>
    <div class="ne-actions">
      ${onDelete ? '<button type="button" class="btn danger fin-del">Удалить</button>' : ''}
      <span class="spacer"></span>
      <button type="button" class="btn primary fin-save">Сохранить</button>
    </div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.notes-list-close').onclick = close;
  ov.onclick = e => { if (e.target === ov) close(); };
  ov.querySelector('.fin-save').onclick = async () => {
    if (await onSave(ov) !== false) { close(); rerender(); }
  };
  const del = ov.querySelector('.fin-del');
  if (del) del.onclick = async () => {
    if (!confirm('Удалить запись?')) return;
    await onDelete();
    close();
    rerender();
  };
  return ov;
}
const field = (label, html) => `<label class="fin-field"><span>${esc(label)}</span>${html}</label>`;
const val = (ov, sel) => { const e = ov.querySelector(sel); return e ? e.value : ''; };

function openTxSheet(id, preset) {
  const t = id ? getItem(id) : null;
  const pre = preset || {};
  const type = t ? t.type : (pre.type || 'expense');
  const accs = getAccounts();
  const accOpts = a => accs.map(x => `<option value="${x.id}"${a === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  const inner = `
    <div class="fin-typerow">${[['expense', 'Расход'], ['income', 'Доход'], ['transfer', 'Перевод']]
      .map(([v, l]) => `<button type="button" class="fin-type${type === v ? ' on' : ''}" data-t="${v}">${l}</button>`).join('')}</div>
    ${field('Сумма', `<input class="fin-in f-amt" type="number" inputmode="decimal" step="0.01" min="0" value="${t ? t.amount : ''}" placeholder="0.00">`)}
    ${field('Дата', `<input class="fin-in f-date" type="date" value="${t ? t.date : today()}">`)}
    ${field('Счёт', `<select class="fin-in f-acc">${accs.length ? accOpts(t ? t.accountId : (accs[0] || {}).id) : '<option value="">Сначала добавьте счёт</option>'}</select>`)}
    <div class="f-only-transfer"${type === 'transfer' ? '' : ' hidden'}>
      ${field('Куда', `<select class="fin-in f-acc2">${accOpts(t ? t.toAccountId : (pre.toAccountId || ''))}</select>`)}
    </div>
    <div class="f-only-cat"${type === 'transfer' ? ' hidden' : ''}>
      ${field('Категория', '<select class="fin-in f-cat"></select>')}
    </div>
    ${field('Кто провёл', `<select class="fin-in f-person"><option value="">Без отметки</option>${getPeople('all')
      .map(x => `<option value="${x.id}"${t && t.personId === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`)}
    ${field('Заметка', `<input class="fin-in f-note" type="text" maxlength="120" value="${t ? esc(t.note || '') : ''}" placeholder="необязательно">`)}`;
  const ov = modal(t ? 'Операция' : 'Новая операция', inner, async o => {
    const amount = parseFloat(val(o, '.f-amt').replace(',', '.'));
    if (!amount || amount <= 0) { alert('Укажите сумму'); return false; }
    const cur = o.querySelector('.fin-type.on').dataset.t;
    await saveItem('tx', {
      type: cur, amount, date: val(o, '.f-date') || today(),
      accountId: val(o, '.f-acc'),
      toAccountId: cur === 'transfer' ? val(o, '.f-acc2') : '',
      categoryId: cur === 'transfer' ? '' : val(o, '.f-cat'),
      personId: val(o, '.f-person'),
      note: val(o, '.f-note').trim(),
    }, id);
  }, id ? () => removeItem(id) : null);

  const fillCats = () => {
    const cur = ov.querySelector('.fin-type.on').dataset.t;
    const sel = ov.querySelector('.f-cat');
    const list = getCategories(cur === 'income' ? 'income' : 'expense');
    sel.innerHTML = list.map(c => `<option value="${c.id}"${t && t.categoryId === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  };
  ov.querySelectorAll('.fin-type').forEach(b => b.onclick = () => {
    ov.querySelectorAll('.fin-type').forEach(x => x.classList.toggle('on', x === b));
    const isTr = b.dataset.t === 'transfer';
    ov.querySelector('.f-only-transfer').hidden = !isTr;
    ov.querySelector('.f-only-cat').hidden = isTr;
    fillCats();
  });
  fillCats();
}
function openAccSheet(id) {
  const a = id ? getItem(id) : null;
  const inner = `
    ${field('Название', `<input class="fin-in f-name" type="text" maxlength="40" value="${a ? esc(a.name) : ''}" placeholder="Например, Карта Тинькофф">`)}
    ${field('Тип', `<select class="fin-in f-type">${ACC_TYPES.map(t => `<option value="${t.id}"${a && a.type === t.id ? ' selected' : ''}>${t.icon} ${t.label}</option>`).join('')}</select>`)}
    ${field('Текущий остаток', `<input class="fin-in f-bal" type="number" inputmode="decimal" step="0.01" value="${a ? a.balance : 0}">`)}
    ${field('Цвет', `<input class="fin-in f-color" type="color" value="${a && a.color ? a.color : '#2563eb'}">`)}
    <div class="f-only-debt"${a && isDebt(a) ? '' : ' hidden'}>
      <div class="fin-row2">
        ${field('День платежа', `<input class="fin-in f-due" type="number" min="1" max="31" value="${a && a.dueDay ? a.dueDay : ''}" placeholder="например, 15">`)}
        ${field('Платёж в месяц', `<input class="fin-in f-pay" type="number" inputmode="decimal" step="0.01" min="0" value="${a && a.payment ? a.payment : ''}">`)}
      </div>
      ${field('Ставка, % годовых', `<input class="fin-in f-rate" type="number" step="0.01" min="0" value="${a && a.rate ? a.rate : ''}">`)}
    </div>
    <p class="hint">Для кредитов и кредиток укажите остаток долга со знаком минус. Платёж вносите переводом с обычного счёта на кредитный — долг уменьшится, баланс тоже.</p>`;
  const ov = modal(a ? 'Счёт' : 'Новый счёт', inner, async o => {
    const name = val(o, '.f-name').trim();
    if (!name) { alert('Укажите название'); return false; }
    await saveItem('account', {
      name, type: val(o, '.f-type'),
      balance: parseFloat(val(o, '.f-bal')) || 0,
      color: val(o, '.f-color'),
      dueDay: parseInt(val(o, '.f-due'), 10) || 0,
      payment: parseFloat(val(o, '.f-pay')) || 0,
      rate: parseFloat(val(o, '.f-rate')) || 0,
      order: a ? a.order : getAccounts().length,
    }, id);
  }, id ? () => removeItem(id) : null);
  /* Поля кредита показываем только для долговых типов */
  const typeSel = ov.querySelector('.f-type');
  const debtBox = ov.querySelector('.f-only-debt');
  typeSel.onchange = () => {
    debtBox.hidden = !ACC_TYPES.some(t2 => t2.id === typeSel.value && t2.side === 'debt');
  };
}
function openCatSheet(id) {
  const c = id ? getItem(id) : null;
  const inner = `
    ${field('Название', `<input class="fin-in f-name" type="text" maxlength="40" value="${c ? esc(c.name) : ''}">`)}
    ${field('Тип', `<select class="fin-in f-flow">
      <option value="expense"${c && c.flow === 'expense' ? ' selected' : ''}>Расход</option>
      <option value="income"${c && c.flow === 'income' ? ' selected' : ''}>Доход</option></select>`)}
    ${field('Цвет', `<input class="fin-in f-color" type="color" value="${c && c.color ? c.color : '#8b5cf6'}">`)}`;
  modal(c ? 'Категория' : 'Новая категория', inner, async o => {
    const name = val(o, '.f-name').trim();
    if (!name) { alert('Укажите название'); return false; }
    await saveItem('cat', { name, flow: val(o, '.f-flow'), color: val(o, '.f-color') }, id);
  }, id ? () => removeItem(id) : null);
}
function openBudgetSheet(id) {
  const b = id ? getItem(id) : null;
  const inner = `
    ${field('Категория', `<select class="fin-in f-cat">${getCategories('expense')
      .map(c => `<option value="${c.id}"${b && b.categoryId === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`)}
    ${field('Лимит в месяц', `<input class="fin-in f-lim" type="number" inputmode="decimal" step="1" min="0" value="${b ? b.limit : ''}">`)}
    <p class="hint">Лимит действует каждый месяц, пока вы его не измените.</p>`;
  modal(b ? 'Лимит' : 'Новый лимит', inner, async o => {
    const limit = parseFloat(val(o, '.f-lim'));
    if (!limit || limit <= 0) { alert('Укажите лимит'); return false; }
    await saveItem('budget', { categoryId: val(o, '.f-cat'), limit, month: null }, id);
  }, id ? () => removeItem(id) : null);
}

/* ══════════════ ИМПОРТ / ЭКСПОРТ ══════════════ */
/* Ключ дедупликации живёт прямо в операции: повторный импорт той же
   выписки (или пересекающегося периода) не создаст дублей. */
const txKey = t => fingerprint({ date: t.date, amount: t.amount, type: t.type, note: t.note });
function existingKeys() {
  const s = new Set();
  for (const t of getTxs()) s.add(t.impKey || txKey(t));
  return s;
}
async function ensureAccount(name) {
  const n = (name || '').trim();
  if (!n) return (getAccounts()[0] || {}).id || '';
  const found = getAccounts().find(a => a.name.toLowerCase() === n.toLowerCase());
  if (found) return found.id;
  const a = await saveItem('account', {
    name: n.slice(0, 40), type: 'bank', balance: 0,
    color: PALETTE[getAccounts().length % PALETTE.length], order: getAccounts().length,
  });
  return a.id;
}
async function ensureCategory(name, flow) {
  const n = (name || '').trim();
  if (!n) return '';
  const found = getCategories(flow).find(c => c.name.toLowerCase() === n.toLowerCase());
  if (found) return found.id;
  const c = await saveItem('cat', {
    name: n.slice(0, 40), flow,
    color: PALETTE[getCategories().length % PALETTE.length],
  });
  return c.id;
}

export function exportTxCSV() {
  const rows = [['Дата', 'Тип', 'Сумма', 'Валюта', 'Счёт', 'Категория', 'Заметка']];
  const label = { expense: 'Расход', income: 'Доход', transfer: 'Перевод' };
  for (const t of getTxs().slice().sort((a, b) => a.date.localeCompare(b.date))) {
    const a = accById(t.accountId), c = catById(t.categoryId);
    rows.push([
      t.date, label[t.type] || t.type, String(Number(t.amount) || 0).replace('.', ','), 'RUB',
      a ? a.name : '', c ? c.name : (t.type === 'transfer' ? ((accById(t.toAccountId) || {}).name || '') : ''),
      t.note || '',
    ]);
  }
  download(`gma-finance-${today()}.csv`, toCSV(rows));
}

function openIOSheet() {
  const ov = document.createElement('div');
  ov.className = 'notes-list-overlay fin-overlay';
  ov.innerHTML = `<div class="notes-list-modal glass fin-modal">
    <header class="notes-list-head"><h3>Импорт и экспорт</h3>
      <button type="button" class="notes-list-close">✕</button></header>
    <div class="fin-form">
      <div class="fin-io-drop">
        <b>Перетащите файл сюда</b>
        <span>или нажмите, чтобы выбрать</span>
        <i>CSV, TSV и XLSX — в том числе выписка из банка как есть</i>
        <input type="file" class="fin-file" accept=".csv,.tsv,.txt,.xlsx,.xlsm" hidden>
      </div>
      <div class="fin-io-result" hidden></div>
      <button type="button" class="btn fin-export">Выгрузить все операции в CSV</button>
      <button type="button" class="btn danger fin-wipe-all">Удалить все операции</button>
      <p class="hint">Одинаковые операции при повторном импорте пропускаются — сравниваем дату, сумму, направление и описание.</p>
    </div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.notes-list-close').onclick = close;
  ov.onclick = e => { if (e.target === ov) close(); };
  ov.querySelector('.fin-export').onclick = () => { exportTxCSV(); close(); };
  ov.querySelector('.fin-wipe-all').onclick = async () => {
    const all = getTxs();
    if (!all.length) { alert('Операций нет'); return; }
    if (!confirm(`Удалить все ${all.length} операций? Счета, категории и лимиты останутся.`)) return;
    await removeTxs(all.map(t => t.id));
    close();
    rerender();
  };

  const drop = ov.querySelector('.fin-io-drop');
  const input = ov.querySelector('.fin-file');
  const result = ov.querySelector('.fin-io-result');
  drop.onclick = () => input.click();
  input.onchange = () => { if (input.files[0]) handle(input.files[0]); };
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault();
    drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault();
    drop.classList.remove('over');
  }));
  drop.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) handle(f);
  });

  async function handle(file) {
    result.hidden = false;
    result.innerHTML = '<p class="hint">Читаю файл…</p>';
    let rows;
    try {
      rows = await readFinanceFile(file);
    } catch (err) {
      const msg = err && err.message === 'old-xls'
        ? 'Старый формат .xls не читается. Пересохраните как .xlsx или .csv.'
        : err && err.message === 'no-ds'
          ? 'Браузер не умеет распаковывать .xlsx. Сохраните файл как CSV.'
          : 'Не смог разобрать файл. Проверьте, что это CSV или XLSX.';
      result.innerHTML = `<p class="fin-err">${esc(msg)}</p>`;
      return;
    }
    const det = detectColumns(rows);
    const parsed = rowsToTx(rows, { columns: det });
    if (parsed.error || !parsed.list.length) {
      result.innerHTML = `<p class="fin-err">${esc(parsed.error || 'В файле не нашлось операций с датой и суммой.')}</p>`;
      return;
    }
    const have = existingKeys();
    const fresh = [], dup = [];
    const seen = new Set();
    for (const t of parsed.list) {
      const k = fingerprint(t);
      if (have.has(k) || seen.has(k)) dup.push(t);
      else { seen.add(k); fresh.push(t); }
    }
    const preview = fresh.slice(0, 6);
    result.innerHTML = `
      <div class="fin-io-sum">
        <div><b>${parsed.list.length}</b><span>в файле</span></div>
        <div class="ok"><b>${fresh.length}</b><span>новых</span></div>
        <div class="dim"><b>${dup.length}</b><span>уже есть</span></div>
      </div>
      ${preview.length ? `<div class="fin-io-prev">${preview.map(t => `<div class="fio-row">
        <span>${esc(t.date)}</span>
        <b class="${t.type === 'income' ? 'pos' : 'neg'}">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</b>
        <i>${esc(t.catName || t.note || '')}</i></div>`).join('')}
        ${fresh.length > preview.length ? `<p class="hint">…и ещё ${fresh.length - preview.length}</p>` : ''}</div>` : ''}
      ${fresh.length ? '<button type="button" class="btn primary fin-do-import">Импортировать ' + fresh.length + '</button>'
                     : '<p class="hint">Новых операций нет — всё из этого файла уже импортировано.</p>'}`;
    const go = result.querySelector('.fin-do-import');
    if (go) go.onclick = async () => {
      go.disabled = true;
      go.textContent = 'Импортирую…';
      const accCache = new Map(), catCache = new Map();
      for (const t of fresh) {
        const aKey = t.accName || '';
        if (!accCache.has(aKey)) accCache.set(aKey, await ensureAccount(aKey));
        const cKey = t.type + '|' + (t.catName || '');
        if (!catCache.has(cKey)) catCache.set(cKey, await ensureCategory(t.catName, t.type));
        await saveItem('tx', {
          type: t.type, amount: t.amount, date: t.date,
          accountId: accCache.get(aKey), toAccountId: '',
          categoryId: catCache.get(cKey), note: t.note,
          impKey: fingerprint(t), imported: true,
        });
      }
      close();
      rerender();
    };
  }
}

/* ══════════════ ВИДЖЕТ «ФИНАНСЫ» ══════════════ */
/* Компактная сводка для дока: кольцо расходов по категориям и
   строки с ключевыми цифрами месяца. Правила те же, что у остальных
   панелей — ручка переноса, стекло, растяжение по ширине. */
export function renderFinanceWidget(box) {
  if (!box) return;
  const m = curMonth();
  const s = monthStats(m);
  const t = totals();
  const cats = byCategory(m, 'expense');
  const top = cats.slice(0, 4);
  const rest = cats.slice(4);
  const parts = rest.length
    ? [...top, { id: 'other', name: 'Прочее', color: '#94a3b8', sum: rest.reduce((a, c) => a + c.sum, 0) }]
    : top;
  box.innerHTML = `
    <div class="fw-head">
      <span class="fw-title">Финансы</span>
      <span class="fw-month">${monthTitle(m)}</span>
    </div>
    <div class="fw-main">
      ${donutSVG(parts, 'Расход', moneyShort(s.expense), `${cats.length} кат.`)}
      <div class="fw-lines">
        <div class="fw-line"><span>Баланс месяца</span><b class="${s.balance < 0 ? 'neg' : 'pos'}">${money(s.balance)}</b></div>
        <div class="fw-line"><span>Доход</span><b class="pos">${money(s.income)}</b></div>
        <div class="fw-line"><span>Расход</span><b class="neg">${money(s.expense)}</b></div>
        <div class="fw-line"><span>В день</span><b>${money(s.perDay)}</b></div>
        <div class="fw-line"><span>Чистый капитал</span><b class="${t.net < 0 ? 'neg' : 'pos'}">${moneyShort(t.net)}</b></div>
      </div>
    </div>
    ${cats.length ? `<div class="fw-cats">${cats.map(p => `<div class="fw-cat">
      <i style="background:${p.color}"></i>
      <span>${esc(p.name)}</span>
      <b>${moneyShort(p.sum)}</b>
      <em class="fw-track"><u style="width:${s.expense ? Math.min(100, p.sum / s.expense * 100).toFixed(1) : 0}%;background:${p.color}"></u></em>
    </div>`).join('')}</div>` : '<p class="empty fw-empty">Расходов в этом месяце ещё нет</p>'}
    <button type="button" class="fw-open">Открыть финансы →</button>`;
  const btn = box.querySelector('.fw-open');
  if (btn) btn.onclick = () => document.dispatchEvent(new CustomEvent('go-view', { detail: 'finance' }));
}
