/* ══════════════ РАСПИСАНИЕ В РЕДАКТОРЕ ЗАДАЧИ ══════════════
   Верхний блок редактора: когда задача делается и повторяется ли.
   Слева — вид повтора (вкладки), его настройки и циферблат времени
   со стрелками, которые тянутся пальцем. Справа — фраза, в которой
   правило прочитано словами, календарь месяца с отмеченными днями и
   «ближайшие пять». Любое изменение сохраняется сразу.
   Даты повторяющейся задачи раскладывает repeat.js в обычные t.days. */
import { today, addDays, parseISO, MONTHS, MONTHS_FULL, esc, getTask, updateTask, hmToMin, minToHM } from './store.js';
import {
  FREQS, NTH, DOW_FULL, matches, nextN, applyRepeat, describe, defaultRepeat, relDay, isoDow, fmtDur, plural,
} from './repeat.js';

const $ = id => document.getElementById(id);
const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MON_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DURS = [15, 30, 60, 90, 120];
let editId = null;
let cursor = '';        // показанный месяц, YYYY-MM
let onChange = () => {};
let bound = false;

const task = () => getTask(editId);
const repOf = t => (t && t.repeat && t.repeat.freq ? t.repeat : null);
const firstDay = t => {
  const t0 = today();
  const ds = Object.keys((t && t.days) || {}).sort();
  return ds.find(d => d >= t0) || t0;
};

async function save(patch) {
  await updateTask(editId, patch);
  renderSched();
  onChange();
}
async function setRepeat(r) {
  const t = task();
  if (!t) return;
  const t0 = today();
  let days = { ...(t.days || {}) };
  if (r) days = applyRepeat(days, r, t0);
  else {
    /* без повтора: оставляем прошлое и только ближайший запланированный раз */
    const fut = Object.keys(days).filter(d => d >= t0 && days[d] === 'todo').sort();
    fut.slice(1).forEach(d => { delete days[d]; });
  }
  await save({ repeat: r, days });
}
const patchRepeat = p => { const r = repOf(task()); if (r) setRepeat({ ...r, ...p }); };

/* ── Левая колонка ── */
function tabsHTML(r) {
  const cur = r ? r.freq : '';
  return FREQS.map(f => `<button type="button" data-freq="${f.id}" aria-pressed="${f.id === cur}">${f.label}</button>`).join('');
}
const stepper = (key, v, unit) => `<span class="eds-step"><button type="button" data-step="${key}" data-d="-1" aria-label="Меньше">−</button><b>${v}</b><button type="button" data-step="${key}" data-d="1" aria-label="Больше">+</button></span>${unit ? `<span class="eds-unit">${unit}</span>` : ''}`;
function optsHTML(t, r) {
  if (!r) {
    const n = Object.keys(t.days || {}).length;
    return `<p class="eds-hint">${n ? 'Отмечайте дни в календаре — задача будет в каждом из них.' : 'Без даты: задача лежит во «Входящих». Выберите день в календаре.'}</p>
      <div class="eds-presets"><button type="button" data-once="today">Сегодня</button><button type="button" data-once="tomorrow">Завтра</button><button type="button" data-once="none">Без даты</button></div>`;
  }
  const ev = Math.max(1, r.every || 1);
  if (r.freq === 'daily') return `<div class="eds-line"><span class="eds-lab">Каждые</span>${stepper('every', ev, plural(ev, 'день', 'дня', 'дней'))}</div>`;
  if (r.freq === 'weekly') {
    const days = r.days && r.days.length ? r.days : [isoDow(r.start)];
    return `<div class="eds-line"><span class="eds-lab">Каждые</span>${stepper('every', ev, plural(ev, 'неделю', 'недели', 'недель'))}</div>
      <div class="eds-cap">Дни недели</div>
      <div class="eds-dows">${WD.map((w, i) => `<button type="button" data-dow="${i + 1}" aria-pressed="${days.includes(i + 1)}">${w}</button>`).join('')}</div>
      <div class="eds-presets"><button type="button" data-dows="1,2,3,4,5">Будни</button><button type="button" data-dows="6,7">Выходные</button><button type="button" data-dows="1,2,3,4,5,6,7">Все дни</button></div>`;
  }
  if (r.freq === 'monthly') {
    const nth = r.mMode === 'nth';
    return `<div class="eds-line"><span class="eds-lab">Каждые</span>${stepper('every', ev, plural(ev, 'месяц', 'месяца', 'месяцев'))}</div>
      <div class="eds-radio" role="radio" tabindex="0" data-mmode="day" aria-checked="${!nth}"><i></i><span>Числа</span>${stepper('mDay', r.mDay || 1, '')}</div>
      <div class="eds-radio" role="radio" tabindex="0" data-mmode="nth" aria-checked="${nth}"><i></i><span>В</span>
        <select class="eds-sel" data-sel="nth">${NTH.map(o => `<option value="${o.v}"${o.v === r.nth ? ' selected' : ''}>${o.l}</option>`).join('')}</select>
        <select class="eds-sel" data-sel="nthDow">${DOW_FULL.slice(1).map((d, i) => `<option value="${i + 1}"${i + 1 === r.nthDow ? ' selected' : ''}>${d.toLowerCase()}</option>`).join('')}</select></div>`;
  }
  return `<div class="eds-line"><span class="eds-lab">Каждые</span>${stepper('every', ev, plural(ev, 'год', 'года', 'лет'))}</div>
    <div class="eds-line"><span class="eds-lab">Дата</span><input type="date" class="eds-date" data-start value="${r.start}"></div>`;
}

/* Циферблат: часовая и минутная стрелки тянутся пальцем */
function clockHTML(t) {
  const has = !!t.blockStart;
  const m = has ? hmToMin(t.blockStart) : 9 * 60;
  const hh = Math.floor(m / 60), mm = m % 60;
  const aH = ((hh % 12) + mm / 60) * 30, aM = mm * 6;
  let ticks = '';
  for (let i = 0; i < 60; i++) {
    const big = i % 5 === 0, a = i * 6 * Math.PI / 180, r1 = big ? 78 : 82;
    ticks += `<line x1="${(100 + r1 * Math.sin(a)).toFixed(1)}" y1="${(100 - r1 * Math.cos(a)).toFixed(1)}" x2="${(100 + 88 * Math.sin(a)).toFixed(1)}" y2="${(100 - 88 * Math.cos(a)).toFixed(1)}" class="${big ? 'big' : ''}"/>`;
  }
  const dur = t.blockMin || 30;
  return `<div class="eds-face${has ? '' : ' off'}">
      <svg viewBox="0 0 200 200" class="eds-dial" aria-label="Циферблат: тяните стрелки">
        <circle cx="100" cy="100" r="96" class="rim"/>
        <g class="ticks">${ticks}</g>
        <g class="hand hour" style="transform:rotate(${aH}deg)"><line x1="100" y1="100" x2="100" y2="52"/><circle cx="100" cy="46" r="7"/></g>
        <g class="hand min" style="transform:rotate(${aM}deg)"><line x1="100" y1="100" x2="100" y2="24"/><circle cx="100" cy="20" r="6"/></g>
        <circle cx="100" cy="100" r="4.5" class="hub"/>
      </svg>
    </div>
    <div class="eds-tinfo">
      <div class="eds-cap">Время</div>
      <label class="eds-big">${has ? `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` : '<span class="eds-none">--:--</span>'}<input type="time" step="300" class="eds-time-in" value="${has ? t.blockStart : ''}" aria-label="Время задачи"></label>
      <div class="eds-ampm"><button type="button" data-half="am" aria-pressed="${has && hh < 12}">☀ до 12</button><button type="button" data-half="pm" aria-pressed="${has && hh >= 12}">☾ после 12</button></div>
      <div class="eds-durs">${DURS.map(d => `<button type="button" data-dur="${d}" aria-pressed="${has && d === dur}">${d < 60 ? d + 'м' : (d / 60).toString().replace('.', ',') + 'ч'}</button>`).join('')}</div>
      <button type="button" class="eds-notime" data-notime aria-pressed="${!has}">${has ? 'Убрать время' : 'Без времени — тяните стрелки'}</button>
    </div>`;
}

/* ── Правая колонка ── */
function summaryHTML(t, r) {
  const time = t.blockStart || '';
  const parts = describe(r, time, time ? t.blockMin || 30 : 0);
  if (parts) return parts.map(p => p.k ? `<mark>${esc(p.s)}</mark>` : esc(p.s)).join('');
  const ds = Object.keys(t.days || {}).filter(d => d >= today()).sort();
  if (!ds.length) return Object.keys(t.days || {}).length ? 'Все дни задачи уже в прошлом' : 'Без даты — <mark>во «Входящих»</mark>';
  const lab = d => `${+d.slice(8)} ${MONTHS[+d.slice(5, 7) - 1]}`;
  return `Однократно: <mark>${ds.slice(0, 3).map(lab).join(', ')}${ds.length > 3 ? ` и ещё ${ds.length - 3}` : ''}</mark>${time ? `, в <mark>${time}</mark>` : ''}`;
}
function monthHTML(t, r) {
  const t0 = today();
  const y = +cursor.slice(0, 4), m = +cursor.slice(5, 7) - 1;
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7;
  const start = addDays(`${cursor}-01`, -lead);
  const days = t.days || {};
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const st = days[d];
    const out = +d.slice(5, 7) - 1 !== m;
    let cls = out ? 'out' : '';
    if (st === 'done') cls += ' done';
    else if (st === 'skipped' || st === 'postponed') cls += ' miss';
    else if (st) cls += ' on';
    else if (r && d > addDays(t0, 0) && matches(r, d)) cls += ' proj';   // за горизонтом — проекция правила
    if (d === t0) cls += ' today';
    if (r && d === r.start) cls += ' anchor';
    cells += `<button type="button" class="${cls.trim()}" data-day="${d}">${+d.slice(8)}</button>`;
  }
  return `<div class="eds-mhead"><button type="button" data-mon="-1" aria-label="Прошлый месяц">‹</button><b>${MON_NOM[m]} ${y}</b><button type="button" data-mon="1" aria-label="Следующий месяц">›</button></div>
    <div class="eds-mgrid">${WD.map(w => `<span>${w}</span>`).join('')}${cells}</div>
    <p class="eds-mnote">${r ? 'Нажмите день, чтобы начать повтор с него' : 'Нажмите день, чтобы добавить или убрать'}</p>`;
}
function nextHTML(t, r) {
  const t0 = today();
  const list = r ? nextN(r, t0, 5).filter(d => (t.days || {})[d] !== 'skipped') : Object.keys(t.days || {}).filter(d => d >= t0 && t.days[d] === 'todo').sort().slice(0, 5);
  const time = t.blockStart || '';
  const rows = list.map((d, i) => {
    const dow = DOW_FULL[isoDow(d)];
    return `<div class="eds-nrow${i ? '' : ' first'}"><b class="eds-nday">${+d.slice(8)}</b><span><i>${dow}</i><small>${MONTHS[+d.slice(5, 7) - 1]} · ${relDay(d, t0)}</small></span><em>${time || 'весь день'}</em></div>`;
  }).join('');
  return `<div class="eds-cap">${r ? 'Ближайшие пять' : 'Ближайшие дни'}</div>${rows || '<p class="eds-hint">Нет запланированных дней</p>'}`;
}
function footHTML(t, r) {
  const t0 = today();
  const nx = r ? nextN(r, t0, 1)[0] : Object.keys(t.days || {}).filter(d => d >= t0 && t.days[d] === 'todo').sort()[0];
  if (!nx) return '';
  const d = parseISO(nx);
  return `<i class="eds-dot"></i>Следующий раз <b>${DOW_FULL[isoDow(nx)].toLowerCase()}, ${d.getDate()} ${MONTHS_FULL[d.getMonth()]}${t.blockStart ? ', ' + t.blockStart : ''}</b> · ${relDay(nx, t0)}${t.blockStart ? ` · ${fmtDur(t.blockMin || 30)}` : ''}`;
}

export function renderSched() {
  const t = task();
  if (!t) return;
  const r = repOf(t);
  if (!cursor) cursor = firstDay(t).slice(0, 7);
  const set = (id, html) => { const el = $(id); if (el && el.innerHTML !== html) el.innerHTML = html; };
  set('edFreq', tabsHTML(r));
  set('edFreqOpts', optsHTML(t, r));
  if (!dragging) set('edClock', clockHTML(t));
  set('edSummary', summaryHTML(t, r));
  set('edMonth', monthHTML(t, r));
  set('edNext', nextHTML(t, r));
  set('edFoot', footHTML(t, r));
  const eb = $('edEyebrow');
  if (eb) eb.textContent = r ? '↻ Повторяющаяся задача' : 'Задача';
}
export function openSched(id, changed) {
  editId = id;
  onChange = changed || (() => {});
  cursor = '';
  bind();
  renderSched();
}

/* ── Перетаскивание стрелок ── */
let dragging = null;
function angleAt(svg, e) {
  const r = svg.getBoundingClientRect();
  const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
  return (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360;
}
function startDial(e) {
  const svg = e.target.closest('.eds-dial');
  if (!svg) return;
  e.preventDefault();
  const t = task();
  const has = !!t.blockStart;
  let min = has ? hmToMin(t.blockStart) : 9 * 60;
  const a = angleAt(svg, e);
  /* какую стрелку взяли: ближайшую по углу; у центра — часовую */
  const aH = ((Math.floor(min / 60) % 12) + (min % 60) / 60) * 30, aM = (min % 60) * 6;
  const diff = (x, y) => Math.min(Math.abs(x - y), 360 - Math.abs(x - y));
  const rr = svg.getBoundingClientRect();
  const dist = Math.hypot(e.clientX - (rr.left + rr.width / 2), e.clientY - (rr.top + rr.height / 2)) / (rr.width / 2);
  const which = dist < .55 ? 'hour' : diff(a, aM) <= diff(a, aH) ? 'min' : 'hour';
  dragging = { svg, which, min, pm: Math.floor(min / 60) >= 12, lastA: a };
  svg.closest('.eds-face').classList.remove('off');
  svg.classList.add('grab');
  const move = ev => {
    const ang = angleAt(svg, ev);
    if (dragging.which === 'min') {
      let mm = Math.round(ang / 6 / 5) * 5 % 60;
      /* переход через 12 часов назад/вперёд двигает час */
      const prev = dragging.min % 60;
      let h = Math.floor(dragging.min / 60);
      if (prev >= 45 && mm <= 15 && dragging.lastA > 270 && ang < 90) h = (h + 1) % 24;
      else if (prev <= 15 && mm >= 45 && dragging.lastA < 90 && ang > 270) h = (h + 23) % 24;
      dragging.min = h * 60 + mm;
    } else {
      const h12 = Math.round(ang / 30) % 12;
      dragging.min = (h12 + (dragging.pm ? 12 : 0)) * 60 + (dragging.min % 60);
    }
    dragging.lastA = ang;
    paintDial(dragging.min);
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    svg.classList.remove('grab');
    const v = minToHM(dragging.min);
    dragging = null;
    save({ blockStart: v, blockMin: task().blockMin || 30 });
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
  move(e);
}
function paintDial(min) {
  const box = $('edClock');
  if (!box) return;
  const hh = Math.floor(min / 60), mm = min % 60;
  const h = box.querySelector('.hand.hour'), m = box.querySelector('.hand.min');
  if (h) h.style.transform = `rotate(${((hh % 12) + mm / 60) * 30}deg)`;
  if (m) m.style.transform = `rotate(${mm * 6}deg)`;
  const big = box.querySelector('.eds-big');
  const txt = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  if (big && big.firstChild) {
    if (big.firstChild.nodeType === 3) big.firstChild.nodeValue = txt;
    else big.firstChild.replaceWith(document.createTextNode(txt));
  }
}

function bind() {
  if (bound) return;
  bound = true;
  const root = document.querySelector('.ed-sched');
  if (!root) return;
  root.addEventListener('pointerdown', e => { if (e.target.closest('.eds-dial')) startDial(e); });
  root.addEventListener('click', e => {
    if (e.target.closest('.eds-sel')) return;
    const b = e.target.closest('button, .eds-radio');
    if (!b || !root.contains(b)) return;
    const t = task();
    if (!t) return;
    const r = repOf(t);
    const t0 = today();
    if ('freq' in b.dataset) {
      const f = b.dataset.freq;
      if ((r ? r.freq : '') === f) return;
      return setRepeat(f ? { ...defaultRepeat(f, r ? r.start : firstDay(t)), ...(r && r.freq === f ? r : {}) } : null);
    }
    if (b.dataset.once) {
      const days = { ...(t.days || {}) };
      Object.keys(days).forEach(d => { if (d >= t0 && days[d] === 'todo') delete days[d]; });
      if (b.dataset.once === 'today') days[t0] = days[t0] || 'todo';
      if (b.dataset.once === 'tomorrow') days[addDays(t0, 1)] = 'todo';
      cursor = (b.dataset.once === 'tomorrow' ? addDays(t0, 1) : t0).slice(0, 7);
      return save({ days });
    }
    if (b.dataset.step) {
      const k = b.dataset.step, d = +b.dataset.d;
      if (k === 'every') return patchRepeat({ every: Math.max(1, Math.min(99, (r.every || 1) + d)) });
      if (k === 'mDay') return patchRepeat({ mDay: ((r.mDay || 1) - 1 + d + 31) % 31 + 1, mMode: 'day' });
    }
    if (b.dataset.dow) {
      const v = +b.dataset.dow;
      const cur = r.days && r.days.length ? r.days : [isoDow(r.start)];
      const next = cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v];
      return patchRepeat({ days: next.length ? next.sort() : cur });
    }
    if (b.dataset.dows) return patchRepeat({ days: b.dataset.dows.split(',').map(Number) });
    if (b.dataset.mmode) return patchRepeat({ mMode: b.dataset.mmode });
    if (b.dataset.mon) {
      const [y, m] = cursor.split('-').map(Number);
      const dt = new Date(y, m - 1 + +b.dataset.mon, 1);
      cursor = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      return renderSched();
    }
    if (b.dataset.day) {
      const d = b.dataset.day;
      if (r) return setRepeat({ ...r, start: d, ...(r.freq === 'monthly' && r.mMode !== 'nth' ? { mDay: +d.slice(8) } : {}), ...(r.freq === 'weekly' && !(r.days || []).length ? { days: [isoDow(d)] } : {}) });
      const days = { ...(t.days || {}) };
      if (days[d]) delete days[d]; else days[d] = 'todo';
      return save({ days });
    }
    if (b.dataset.half) {
      if (!t.blockStart) return save({ blockStart: b.dataset.half === 'pm' ? '15:00' : '09:00', blockMin: t.blockMin || 30 });
      let m = hmToMin(t.blockStart);
      if (b.dataset.half === 'pm' && m < 720) m += 720;
      if (b.dataset.half === 'am' && m >= 720) m -= 720;
      return save({ blockStart: minToHM(m) });
    }
    if (b.dataset.dur) return save({ blockMin: +b.dataset.dur, blockStart: t.blockStart || '09:00' });
    if ('notime' in b.dataset) return t.blockStart ? save({ blockStart: null }) : save({ blockStart: '09:00', blockMin: t.blockMin || 30 });
  });
  root.addEventListener('change', e => {
    const el = e.target;
    const r = repOf(task());
    if (el.matches('.eds-sel') && r) patchRepeat({ [el.dataset.sel]: +el.value, mMode: 'nth' });
    else if (el.matches('[data-start]') && r && el.value) setRepeat({ ...r, start: el.value });
    else if (el.matches('.eds-time-in')) save(el.value ? { blockStart: el.value, blockMin: task().blockMin || 30 } : { blockStart: null });
  });
}
