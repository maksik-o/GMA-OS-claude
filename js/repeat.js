/* ══════════════ ПОВТОРЫ ЗАДАЧ ══════════════
   Правило повтора хранится в задаче (t.repeat), а сами даты — как и у
   обычных задач — в t.days: неделя, канбан, таймлайн и «Главная»
   ничего не знают о повторах и просто видят задачу в нужные дни.
   Даты раскладываются наперёд на HORIZON дней и продлеваются при
   смене суток.

   t.repeat = {
     freq:  'daily' | 'weekly' | 'monthly' | 'yearly',
     every: 1…        — каждые N дней / недель / месяцев / лет,
     days:  [1…7]     — дни недели (ISO: 1 — пн) для weekly,
     mMode: 'day' | 'nth', mDay: 1…31, nth: 1…4 | -1 (последний), nthDow: 1…7,
     start: 'YYYY-MM-DD' — точка отсчёта (для «каждые N» и годовых),
   }
   Время — общее поле задачи t.blockStart / t.blockMin. */
import { iso, parseISO, addDays, mondayOf, MONTHS_FULL } from './store.js';

export const HORIZON = 62;
export const FREQS = [
  { id: '', label: 'Разово' },
  { id: 'daily', label: 'День' },
  { id: 'weekly', label: 'Неделя' },
  { id: 'monthly', label: 'Месяц' },
  { id: 'yearly', label: 'Год' },
];
const DOW_ACC = ['', 'понедельникам', 'вторникам', 'средам', 'четвергам', 'пятницам', 'субботам', 'воскресеньям'];
const DOW_PREP = ['', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];
export const DOW_FULL = ['', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
export const NTH = [{ v: 1, l: 'первый' }, { v: 2, l: 'второй' }, { v: 3, l: 'третий' }, { v: 4, l: 'четвёртый' }, { v: -1, l: 'последний' }];
const NTH_F = { 1: 'первую', 2: 'вторую', 3: 'третью', 4: 'четвёртую', '-1': 'последнюю' };
const NTH_N = { 1: 'первое', 2: 'второе', 3: 'третье', 4: 'четвёртое', '-1': 'последнее' };
const NTH_M = { 1: 'первый', 2: 'второй', 3: 'третий', 4: 'четвёртый', '-1': 'последний' };
const FEM = new Set([3, 5, 6]);       // среда, пятница, суббота
const NEUT = new Set([7]);            // воскресенье

export const isoDow = s => ((parseISO(s).getDay() + 6) % 7) + 1;
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 864e5);
const monthIdx = s => +s.slice(0, 4) * 12 + (+s.slice(5, 7) - 1);
const dim = (y, m) => new Date(y, m + 1, 0).getDate();

export function defaultRepeat(freq, anchor) {
  const dow = isoDow(anchor);
  return {
    freq, every: 1, start: anchor,
    days: freq === 'weekly' ? [dow] : [],
    mMode: 'day', mDay: +anchor.slice(8), nth: Math.min(4, Math.ceil(+anchor.slice(8) / 7)), nthDow: dow,
  };
}

/* Подходит ли дата под правило */
export function matches(r, d) {
  if (!r || !r.freq) return false;
  const start = r.start || d;
  if (d < start) return false;
  const every = Math.max(1, r.every | 0 || 1);
  if (r.freq === 'daily') return daysBetween(start, d) % every === 0;
  if (r.freq === 'weekly') {
    const days = r.days && r.days.length ? r.days : [isoDow(start)];
    if (!days.includes(isoDow(d))) return false;
    return (daysBetween(mondayOf(start), mondayOf(d)) / 7) % every === 0;
  }
  if (r.freq === 'monthly') {
    if ((monthIdx(d) - monthIdx(start)) % every !== 0) return false;
    const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1, day = +d.slice(8);
    if (r.mMode === 'nth') {
      if (isoDow(d) !== (r.nthDow || 1)) return false;
      if (r.nth === -1) return day + 7 > dim(y, m);
      return Math.ceil(day / 7) === r.nth;
    }
    return day === Math.min(r.mDay || 1, dim(y, m));
  }
  if (r.freq === 'yearly') {
    if ((+d.slice(0, 4) - +start.slice(0, 4)) % every !== 0) return false;
    const sm = +start.slice(5, 7), sd = +start.slice(8);
    const y = +d.slice(0, 4);
    return +d.slice(5, 7) === sm && +d.slice(8) === Math.min(sd, dim(y, sm - 1));
  }
  return false;
}
export function occurrences(r, from, to, limit = 400) {
  const out = [];
  if (!r || !r.freq) return out;
  for (let d = from; d <= to && out.length < limit; d = addDays(d, 1)) if (matches(r, d)) out.push(d);
  return out;
}
export function nextN(r, from, n) {
  const out = [];
  if (!r || !r.freq) return out;
  let d = from;
  for (let i = 0; i < 3 * 366 && out.length < n; i++, d = addDays(d, 1)) if (matches(r, d)) out.push(d);
  return out;
}

/* Даты задачи под правило: прошлое не трогаем; будущие «запланированные»
   дни, которые больше не подходят, убираем; подходящие — добавляем
   на горизонт вперёд. */
export function applyRepeat(days, r, t0) {
  const out = { ...(days || {}) };
  for (const d of Object.keys(out)) {
    if (d >= t0 && out[d] === 'todo' && !matches(r, d)) delete out[d];
  }
  if (r && r.freq) for (const d of occurrences(r, t0, addDays(t0, HORIZON))) if (!out[d]) out[d] = 'todo';
  return out;
}

/* Фраза-описание: части-ключи возвращаются отдельно, чтобы подсветить их */
export function describe(r, time, dur) {
  const P = [];
  const k = s => P.push({ k: 1, s });
  const t = s => P.push({ k: 0, s });
  if (!r || !r.freq) return null;
  const every = Math.max(1, r.every | 0 || 1);
  t('Повторяется ');
  if (r.freq === 'daily') k(every === 1 ? 'каждый день' : `каждые ${every} ${plural(every, 'день', 'дня', 'дней')}`);
  else if (r.freq === 'weekly') {
    const days = (r.days && r.days.length ? r.days : [isoDow(r.start)]).slice().sort();
    k(every === 1 ? 'каждую неделю' : `каждые ${every} ${plural(every, 'неделю', 'недели', 'недель')}`);
    t(', ');
    if (days.length === 7) k('ежедневно');
    else if (days.join() === '1,2,3,4,5') k('по будням');
    else if (days.join() === '6,7') k('по выходным');
    else k('по ' + joinRu(days.map(d => DOW_ACC[d])));
  } else if (r.freq === 'monthly') {
    if (r.mMode === 'nth') {
      const dw = r.nthDow || 1;
      const word = FEM.has(dw) ? NTH_F[r.nth] : NEUT.has(dw) ? NTH_N[r.nth] : NTH_M[r.nth];
      t('в '); k(`${word} ${DOW_PREP[dw]}`); t(' ');
    } else { k(`${r.mDay || 1}-го числа`); t(' '); }
    k(every === 1 ? 'каждого месяца' : `каждые ${every} ${plural(every, 'месяц', 'месяца', 'месяцев')}`);
  } else if (r.freq === 'yearly') {
    k(every === 1 ? 'каждый год' : `каждые ${every} ${plural(every, 'год', 'года', 'лет')}`);
    t(', '); k(`${+r.start.slice(8)} ${MONTHS_FULL[+r.start.slice(5, 7) - 1]}`);
  }
  if (time) { t(', в '); k(time); if (dur) { t(' на '); k(fmtDur(dur)); } }
  return P;
}
export const fmtDur = m => m >= 60 ? `${Math.floor(m / 60)} ч${m % 60 ? ' ' + (m % 60) + ' мин' : ''}` : `${m} мин`;
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
const joinRu = arr => arr.length < 2 ? arr.join('') : arr.slice(0, -1).join(', ') + ' и ' + arr[arr.length - 1];
export function relDay(d, t0) {
  const n = daysBetween(t0, d);
  if (n === 0) return 'сегодня';
  if (n === 1) return 'завтра';
  if (n < 0) return `${-n} ${plural(-n, 'день', 'дня', 'дней')} назад`;
  if (n < 45) return `через ${n} ${plural(n, 'день', 'дня', 'дней')}`;
  const mo = Math.round(n / 30);
  return `через ${mo} ${plural(mo, 'месяц', 'месяца', 'месяцев')}`;
}
export { iso };
