/* ══════════════════════════════════════════════════════════════════
   Блок «Timeline» — задачи на временнóй сетке.

   Живёт на месте Running-list и канбана, переключается тем же
   селектором. Показывает 1, 3 или 7 дней вертикальными столбиками.
   Источник размещения — планы задачи (см. store.js): либо заданные
   вручную, либо выведенные из завершённых сессий фокусировки.
   ══════════════════════════════════════════════════════════════════ */
import {
  state, getTask, visibleTasks, isDone, esc, createTask,
  today, addDays, parseISO, WEEKDAYS, MONTHS,
  plansForDay, setTaskPlan, hmToMin, minToHM, setEntry,
  hapticLight, hapticMedium, subscribe,
} from './store.js';
import { openSheet } from './sheet.js';
import { getRoutines, routinesForDay, saveRoutine, removeRoutine, kbSubscribe } from './kb.js';

const HOUR = 46;        // высота часа, px
const SNAP = 5;         // шаг привязки, мин
const MIN_LEN = 15;
const DAY_MIN = 24 * 60;

export const TL_RANGES = [
  { id: 1, label: '1 день' },
  { id: 3, label: '3 дня' },
  { id: 7, label: 'Неделя' },
];
/* На телефоне три колонки по ~110px слишком узкие для карточек —
   по умолчанию показываем один день, на ПК — три */
let tlRange = matchMedia('(max-width: 720px)').matches ? 1 : 3;
/* Смещение первого показанного дня внутри недели из шапки (0 = пн).
   Таймлайн — это ещё один способ показать ТУ ЖЕ неделю, что
   Running-list и канбан, поэтому собственной «своей» даты у него нет:
   он всегда стоит на state.weekStart. */
let tlOffset = null;
let _panel = null;
let _scroll = null;
let trayOpen = false;
/* По умолчанию видно окно в 8 часов, а линия «сейчас» держится по
   центру: едет не линия по панели, а панель под линией. */
const WINDOW_H = 8;
let expanded = false;
let _recenter = null;
let _userScrolledAt = 0;
export const timelineExpanded = () => expanded;
export function toggleExpanded() {
  expanded = !expanded;
  renderTimeline(_panel);
}

const maxOffset = () => Math.max(0, 7 - tlRange);
function offset() {
  if (tlOffset == null) {
    const i = Math.round((parseISO(today()) - parseISO(state.weekStart)) / 86400000);
    tlOffset = (i >= 0 && i <= 6) ? i : 0;   // при открытии стоим на сегодня
  }
  return Math.max(0, Math.min(maxOffset(), tlOffset));
}
/* Шапка таймлайна собирается в одном месте.
   Раньше кнопки навешивались в kanban.js после renderTimeline, но
   панель перерисовывается ещё и по любому изменению задач — и тогда
   обработчики терялись, а троеточие вообще не попадало в заголовок,
   потому что его вставляли только если оно уже было внутри панели. */
let hooks = {};
export function setTimelineHooks(h) { hooks = h || {}; }

export const timelineRange = () => tlRange;
export function setTimelineRange(n) {
  tlRange = Number(n) || 1;
  tlOffset = Math.max(0, Math.min(maxOffset(), offset()));
  renderTimeline(_panel);
}
/* Дошли до края недели — переводим саму неделю, а не уезжаем из неё */
export function shiftTimeline(dir, shiftWeek) {
  const next = offset() + dir * tlRange;
  if (next > maxOffset()) {
    tlOffset = 0;
    if (shiftWeek) shiftWeek(1);
  } else if (next < 0) {
    tlOffset = maxOffset();
    if (shiftWeek) shiftWeek(-1);
  } else {
    tlOffset = next;
  }
  return () => renderTimeline(_panel);
}
const snap = m => Math.round(m / SNAP) * SNAP;

function days() {
  const start = addDays(state.weekStart, tlRange === 7 ? 0 : offset());
  return Array.from({ length: tlRange }, (_, i) => addDays(start, i));
}
export function timelineLabel() {
  const d = days();
  const a = d[0], b = d[d.length - 1];
  if (tlRange === 1) return `${+a.slice(8)} ${MONTHS[+a.slice(5, 7) - 1]}`;
  return `${+a.slice(8)} ${MONTHS[+a.slice(5, 7) - 1]} – ${+b.slice(8)} ${MONTHS[+b.slice(5, 7) - 1]}`;
}

/* Раскладка пересечений внутри одного дня: колонки, как в календаре */
function layout(items) {
  const sorted = items.slice().sort((a, b) => a.s - b.s || b.e - a.e);
  const out = [];
  let cluster = [], end = -1;
  const flush = () => {
    if (!cluster.length) return;
    const cols = [];
    for (const b of cluster) {
      let ci = cols.findIndex(c => c[c.length - 1].e <= b.s);
      if (ci < 0) { cols.push([b]); ci = cols.length - 1; }
      else cols[ci].push(b);
      b.col = ci;
    }
    cluster.forEach(b => { b.cols = cols.length; out.push(b); });
    cluster = [];
    end = -1;
  };
  for (const b of sorted) {
    if (cluster.length && b.s >= end) flush();
    cluster.push(b);
    end = Math.max(end, b.e);
  }
  flush();
  return out;
}

/* Задача попадает в день, если на этот день есть план — даже когда
   самого дня нет в её квадратах. Раньше бралось только tasksForDay,
   поэтому запланированные вручную задачи в таймлайн не попадали. */
/* Таймлайн показывает ВСЁ, что запланировано на день, включая
   выполненное: он отвечает на вопрос «как прошёл день», а не «что
   осталось сделать». Переключатель «скрыть выполненные» из меню
   Running-list на него намеренно не влияет. */
function dayItems(day) {
  const items = [];
  const seen = new Set();
  for (const t of visibleTasks()) {
    if (seen.has(t.id)) continue;
    const plans = plansForDay(t, day);
    if (!plans.length) continue;
    seen.add(t.id);
    for (const p of plans) {
      const s = hmToMin(p.start);
      const e = Math.max(s + MIN_LEN, hmToMin(p.end || p.start));
      items.push({ t, s, e: Math.min(DAY_MIN, e), auto: !!p.auto });
    }
  }
  return layout(items);
}
/* Задачи дня, которым ещё не задано время */
function unplanned(day) {
  return visibleTasks().filter(t => (t.days || {})[day] && !isDone(t) && !plansForDay(t, day).length);
}

export function renderTimeline(panel) {
  if (!panel) return;
  _panel = panel;
  const list = days();
  const t0 = today();
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  /* 25 меток: и 00:00 сверху, и 24:00 снизу. Верхняя и нижняя
     прижимаются к краю, иначе половина подписи уходит за границу. */
  const hours = Array.from({ length: 25 }, (_, h) => h);
  /* Лоток общий на весь показанный диапазон: одна задача может
     висеть на нескольких днях, и раскладывать её удобнее из общего
     списка, а не искать нужную колонку. */
  /* Задача уходит из лотка, как только ей задано время хотя бы на
     одном показанном дне. Раньше проверялся каждый день отдельно, и
     задача, висящая на нескольких днях, оставалась в лотке после
     того, как её уже поставили на сетку. */
  const seenTray = new Set();
  const trayList = [];
  for (const d of list) {
    for (const t of visibleTasks()) {
      if (seenTray.has(t.id) || isDone(t) || !(t.days || {})[d]) continue;
      seenTray.add(t.id);
      if (!list.some(dd => plansForDay(t, dd).length)) trayList.push(t);
    }
  }

  panel.innerHTML =
    '<div class="kb-head kb-head-hold">' +
      '<div class="kb-row">' +
        '<button type="button" class="kb-board-title" id="tlTitle" title="Выбор вида: Running-list / kanban / Timeline">Timeline</button>' +
        '<div class="kb-rangenav">' +
          '<button type="button" class="kb-arrow" id="tlPrev" title="Назад">‹</button>' +
          `<button type="button" class="kb-rangelabel" id="tlRangeChip" title="Диапазон таймлайна">${esc(timelineLabel())}</button>` +
          '<button type="button" class="kb-arrow" id="tlNext" title="Вперёд">›</button>' +
        '</div>' +
        '<div class="kb-right">' +
          '<button type="button" class="tl-tray-btn" id="tlRoutines" title="Повседневные дела — только в Timeline">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>' +
            '<span class="tlb-lab">Расписание</span></button>' +
          `<button type="button" class="tl-tray-btn${trayOpen ? ' on' : ''}" id="tlTray" title="Задачи без планирования">` +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h10M4 17h7"/></svg>' +
            `<span class="tlb-lab">Без времени</span><i>${trayList.length}</i></button>` +
        '</div>' +
      '</div>' +
      `<div class="tl-tray${trayOpen ? ' open' : ''}">` +
        (trayList.length
          ? trayList.map(t => `<button type="button" class="tl-chip m-${esc(t.mode)}" data-id="${esc(t.id)}" title="Перетащите на сетку">${esc(t.title)}</button>`).join('')
          : '<span class="tl-tray-empty">Все задачи этих дней уже расставлены</span>') +
      '</div>' +
    '</div>' +
    '<div class="tl-body">' +
      '<div class="tl-gutter">' +
        '<div class="tl-corner"></div>' +
        `<div class="tl-hours" style="height:${24 * HOUR + 1}px">` +
          hours.map(h => `<span class="${h === 0 ? 'first' : h === 24 ? 'last' : ''}" style="top:${h * HOUR}px">${String(h).padStart(2, '0')}:00</span>`).join('') +
        '</div>' +
      '</div>' +
      '<div class="tl-cols">' +
        list.map(d => {
          const items = dayItems(d);
          const wd = WEEKDAYS[(parseISO(d).getDay() + 6) % 7];
          return `<section class="tl-col${d === t0 ? ' today' : ''}" data-day="${d}">
            <header class="tl-colhead"><span class="tl-wd">${wd}</span><b>${+d.slice(8)}</b><i>${MONTHS[+d.slice(5, 7) - 1]}</i></header>

            <div class="tl-area" style="height:${24 * HOUR}px">
              ${hours.map(h => `<i class="tl-line" style="top:${h * HOUR}px"></i>${h < 24 ? `<i class="tl-line half" style="top:${h * HOUR + HOUR / 2}px"></i>` : ''}`).join('')}
              ${routinesForDay(d).map(r => routineHTML(r)).join('')}
              ${items.map(b => blockHTML(b, d)).join('')}
              ${d === t0 ? `<div class="tl-now" style="top:${(nowMin / 60) * HOUR}px"><i></i></div>` : ''}
            </div>
          </section>`;
        }).join('') +
      '</div>' +
    '</div>';

  /* Троеточие — такое же, как у Running-list и канбана, слева от
     заголовка. Берём общий элемент у владельца и переносим сюда. */
  const title = panel.querySelector('#tlTitle');
  const vb = hooks.viewBtn && hooks.viewBtn();
  if (vb && title) title.insertAdjacentElement('beforebegin', vb);
  if (title && hooks.onTitle) title.onclick = e => { e.stopPropagation(); hooks.onTitle(title); };
  const chip = panel.querySelector('#tlRangeChip');
  if (chip && hooks.onRange) chip.onclick = e => { e.stopPropagation(); hooks.onRange(chip); };
  const pv = panel.querySelector('#tlPrev');
  const nx = panel.querySelector('#tlNext');
  if (pv && hooks.onStep) pv.onclick = () => hooks.onStep(-1);
  if (nx && hooks.onStep) nx.onclick = () => hooks.onStep(1);

  const rb = panel.querySelector('#tlRoutines');
  if (rb) rb.onclick = e => { e.stopPropagation(); openRoutines(); };

  const trayBtn = panel.querySelector('#tlTray');
  if (trayBtn) trayBtn.onclick = e => {
    e.stopPropagation();
    trayOpen = !trayOpen;
    renderTimeline(panel);
  };
  panel.querySelectorAll('.tl-tray .tl-chip').forEach(c => bindTrayChip(c, panel));
  panel.querySelectorAll('.tl-block .tlb-check').forEach(c => {
    c.addEventListener('pointerdown', e => e.stopPropagation());
    c.onclick = async e => {
      e.stopPropagation();
      const blk = c.closest('.tl-block');
      const t = getTask(blk.dataset.id);
      if (!t) return;
      const day = blk.dataset.day;
      const cur = (t.days || {})[day];
      hapticMedium();
      await setEntry(t.id, day, cur === 'done' ? 'todo' : 'done');
      refreshTimeline();
    };
  });
  panel.querySelectorAll('.tl-block').forEach(n => bindBlock(n));
  panel.querySelectorAll('.tl-routine').forEach(n => bindRoutine(n));
  panel.querySelectorAll('.tl-area').forEach(a => bindArea(a));

  const body = panel.querySelector('.tl-body');
  panel.classList.toggle('tl-expanded', expanded);
  if (expanded) {
    body.style.maxHeight = '';
    if (_scroll != null) body.scrollTop = _scroll;
    else centerNow(body);
  } else {
    /* Окно на 8 часов: панель не растёт на весь экран и не мешает
       странице скроллиться. */
    body.style.maxHeight = (WINDOW_H * HOUR + 42) + 'px';
    centerNow(body);
  }
  body.addEventListener('scroll', () => {
    _scroll = body.scrollTop;
    _userScrolledAt = Date.now();
  }, { passive: true });
  clearInterval(_recenter);
  if (!expanded) {
    _recenter = setInterval(() => {
      const b = _panel && _panel.querySelector('.tl-body');
      if (!b || !b.isConnected) { clearInterval(_recenter); return; }
      if (Date.now() - _userScrolledAt < 20000) return;   // не мешаем ручной прокрутке
      centerNow(b, true);
    }, 30000);
  }
}
function centerNow(body, smooth) {
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  const top = Math.max(0, (now / 60) * HOUR - (WINDOW_H / 2) * HOUR);
  if (smooth && body.scrollTo) body.scrollTo({ top, behavior: 'smooth' });
  else body.scrollTop = top;
  _scroll = top;
}
export const refreshTimeline = () => { if (_panel && !_panel.hidden) renderTimeline(_panel); };

/* Полоса повседневного дела. Может переходить через полночь («Сон
   23:00–07:00»): тогда в этом дне рисуется хвост до 24:00 и начало с
   00:00 — оба куска, чтобы ночь читалась целиком. */
function routineHTML(r) {
  const s = hmToMin(r.start), e = hmToMin(r.end);
  const parts = e > s ? [[s, e]] : [[0, e], [s, DAY_MIN]];
  /* part: whole — обычное дело; eve — вечерний кусок ночного дела
     (у него двигается только начало); morn — утренний (только конец) */
  const kind = parts.length === 1 ? 'whole' : null;
  return parts.filter(([a, b]) => b - a >= 5).map(([a, b], i) => {
    const part = kind || (i === 0 ? 'morn' : 'eve');
    return `<div class="tl-routine part-${part}" data-id="${esc(r.id)}" data-part="${part}" style="top:${(a / 60) * HOUR}px;height:${((b - a) / 60) * HOUR}px;--rc:${esc(r.color || '#64748b')}" title="${esc(r.title)} · ${esc(r.start)}–${esc(r.end)}">
      <span class="tlr-title">${esc(r.title)}</span>
      <span class="tlr-time">${esc(r.start)}–${esc(r.end)}</span>
      <button type="button" class="tlr-del" title="Удалить из расписания" aria-label="Удалить">✕</button>
      ${part !== 'morn' ? '<span class="tlb-grip top"></span>' : ''}
      ${part !== 'eve' ? '<span class="tlb-grip bottom"></span>' : ''}
    </div>`;
  }).join('');
}
/* ── Карточка задачи на таймлайне ──
   Спокойная тонированная карточка с цветной кромкой режима вместо
   сплошной заливки: текст читается на любом фоне, а соседние задачи не
   сливаются в одно пятно. На карточке — то, что нужно, не открывая
   редактор: отметка выполнения за этот день, время и длительность,
   приоритет, прогресс подзадач. */
const fmtDur = m => m >= 60 ? `${Math.floor(m / 60)} ч${m % 60 ? ' ' + (m % 60) + ' мин' : ''}` : `${m} мин`;
const PRIO_FLAG = { 1: 'Высокий', 2: 'Средний', 3: 'Низкий' };
function blockHTML(b, day) {
  const t = b.t;
  const w = 100 / b.cols;
  const len = b.e - b.s;
  const size = len < 30 ? 'xs' : len < 50 ? 'sm' : 'md';
  const st = (t.days || {})[day] || '';
  const done = st === 'done' || isDone(t);
  const subs = (t.subtasks || []);
  const subDone = subs.filter(x => x.done).length;
  return `<div class="tl-block m-${esc(t.mode)} p${t.priority} sz-${size}${done ? ' done' : ''}${st === 'started' ? ' started' : ''}${b.auto ? ' auto' : ''}"
      data-id="${esc(t.id)}" data-day="${day}"
      style="top:${(b.s / 60) * HOUR}px;height:${(len / 60) * HOUR}px;left:calc(${b.col * w}% + 2px);width:calc(${w}% - 5px)"
      title="${esc(t.title)} · ${minToHM(b.s)}–${minToHM(b.e)}">
    <button type="button" class="tlb-check" title="${done ? 'Вернуть в работу' : 'Выполнено'}" aria-label="Отметить">${done ? '✓' : ''}</button>
    <div class="tlb-body">
      <b class="tlb-title">${esc(t.title)}</b>
      <span class="tlb-meta">
        <span class="tlb-time">${minToHM(b.s)}–${minToHM(b.e)}</span>
        ${size === 'md' ? `<span class="tlb-dur">${fmtDur(len)}</span>` : ''}
        ${size === 'md' && subs.length ? `<span class="tlb-sub">${subDone}/${subs.length}</span>` : ''}
        ${b.auto ? '<span class="tlb-auto" title="Время из сессий фокусировки">⚡</span>' : ''}
      </span>
    </div>
    ${t.priority === 1 ? `<i class="tlb-prio" title="${PRIO_FLAG[1]} приоритет"></i>` : ''}
    <span class="tlb-grip top"></span><span class="tlb-grip bottom"></span>
  </div>`;
}

/* ── Выделение диапазона на пустом месте ──
   Тянем по пустой области — рисуется полоса от начала до конца
   выделения. Отпустили — выбираем, какую задачу поставить в это окно,
   или заводим новую прямо с этим временем. */
function bindArea(area) {
  let band = null, y0 = 0, s0 = 0, cur = 0, active = false;
  const day = area.closest('.tl-col').dataset.day;
  const minAt = y => {
    const r = area.getBoundingClientRect();
    return Math.max(0, Math.min(DAY_MIN, ((y - r.top + area.parentElement.scrollTop * 0) / HOUR) * 60));
  };
  const paint = () => {
    const a = Math.min(s0, cur), b = Math.max(s0, cur);
    band.style.top = `${(a / 60) * HOUR}px`;
    band.style.height = `${Math.max(2, ((b - a) / 60) * HOUR)}px`;
    band.querySelector('span').textContent = `${minToHM(a)}–${minToHM(Math.max(b, a + MIN_LEN))}`;
  };
  const onMove = e => {
    cur = snap(minAt(e.clientY));
    if (!active && Math.abs(e.clientY - y0) < 5) return;
    if (!active) {
      active = true;
      band = document.createElement('div');
      band.className = 'tl-band';
      band.innerHTML = '<span></span>';
      area.appendChild(band);
      document.body.classList.add('tl-dragging');
      hapticLight();
    }
    paint();
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('tl-dragging');
    if (!active) { if (band) band.remove(); band = null; return; }
    active = false;
    const a = Math.min(s0, cur);
    const b = Math.max(Math.max(s0, cur), a + MIN_LEN);
    if (band) { band.remove(); band = null; }
    openPlanPicker(day, minToHM(a), minToHM(b));
  };
  area.addEventListener('pointerdown', e => {
    if (e.target.closest('.tl-block') || e.target.closest('.tl-chip') || e.target.closest('.tl-routine')) return;
    if (e.button === 1 || e.button === 2) return;
    e.preventDefault();
    y0 = e.clientY;
    s0 = snap(minAt(e.clientY));
    cur = s0 + 60;
    active = false;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });
}

function openPlanPicker(day, start, end) {
  const free = unplanned(day);
  const ov = document.createElement('div');
  ov.className = 'notes-list-overlay';
  ov.innerHTML = `<div class="notes-list-modal glass">
    <header class="notes-list-head"><h3>${esc(start)}–${esc(end)}</h3>
      <button type="button" class="notes-list-close">✕</button></header>
    <div class="tl-newrow">
      <input class="tl-newtitle" type="text" maxlength="200" placeholder="Новая задача на это время">
      <button type="button" class="btn primary tl-newbtn">＋</button>
    </div>
    <div class="notes-list-content">${free.length
      ? free.map(t => `<button type="button" class="kb-pick" data-id="${esc(t.id)}">${esc(t.title)}</button>`).join('')
      : '<p class="empty">Все задачи этого дня уже стоят в таймлайне</p>'}</div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.notes-list-close').onclick = close;
  ov.onclick = e => { if (e.target === ov) close(); };
  ov.querySelectorAll('.kb-pick').forEach(b => b.onclick = async () => {
    close();
    await setTaskPlan(b.dataset.id, day, start, end);
    refreshTimeline();
  });
  const inp = ov.querySelector('.tl-newtitle');
  const add = async () => {
    const v = inp.value.trim();
    if (!v) { inp.focus(); return; }
    const t = await createTask({
      title: v,
      mode: state.mode === 'all' ? 'work' : state.mode,
      days: { [day]: 'todo' },
    });
    close();
    await setTaskPlan(t.id, day, start, end);
    refreshTimeline();
  };
  ov.querySelector('.tl-newbtn').onclick = add;
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  setTimeout(() => inp.focus(), 60);
}

/* ── Перетаскивание задачи из лотка на сетку ──
   Pointer-события: один код и для мыши, и для пальца. Отпустили над
   колонкой — задача встаёт на это время, дальше её можно растянуть.
   Esc отменяет. */
function bindTrayChip(chip, panel) {
  let ghost = null, started = false, sx = 0, sy = 0, cancelled = false;
  const onKey = e => { if (e.key === 'Escape') { cancelled = true; finish(); } };
  const move = e => {
    if (cancelled) return;
    if (!started) {
      if (Math.abs(e.clientX - sx) < 6 && Math.abs(e.clientY - sy) < 6) return;
      started = true;
      ghost = document.createElement('div');
      ghost.className = 'tl-drag-ghost';
      ghost.textContent = chip.textContent;
      document.body.appendChild(ghost);
      document.body.classList.add('tl-dragging');
      hapticLight();
    }
    ghost.style.transform = `translate(${e.clientX + 10}px, ${e.clientY + 10}px)`;
    const area = areaAt(e.clientX, e.clientY);
    panel.querySelectorAll('.tl-col').forEach(c => c.classList.remove('drop-over'));
    if (area) {
      area.closest('.tl-col').classList.add('drop-over');
      ghost.dataset.time = minToHM(timeAt(area, e.clientY));
      ghost.setAttribute('data-has-time', '1');
    } else {
      ghost.removeAttribute('data-has-time');
    }
  };
  const areaAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('.tl-area') : null;
  };
  const timeAt = (area, y) => {
    const r = area.getBoundingClientRect();
    return Math.max(0, Math.min(DAY_MIN - 60, snap(((y - r.top) / HOUR) * 60)));
  };
  function finish(e) {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', cancel);
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('tl-dragging');
    panel.querySelectorAll('.tl-col').forEach(c => c.classList.remove('drop-over'));
    if (ghost) { ghost.remove(); ghost = null; }
    const wasStarted = started;
    started = false;
    if (cancelled || !wasStarted || !e) return;
    const area = areaAt(e.clientX, e.clientY);
    if (!area) return;
    const day = area.closest('.tl-col').dataset.day;
    const start = timeAt(area, e.clientY);
    hapticMedium();
    setTaskPlan(chip.dataset.id, day, minToHM(start), minToHM(start + 60)).then(refreshTimeline);
  }
  const up = e => finish(e);
  const cancel = () => { cancelled = true; finish(); };
  chip.addEventListener('pointerdown', e => {
    e.preventDefault();
    sx = e.clientX;
    sy = e.clientY;
    started = false;
    cancelled = false;
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('keydown', onKey);
  });
}

/* ── Перетаскивание и растягивание ── */
function bindBlock(node) {
  let mode = null, sy = 0, s0 = 0, len0 = 0, moved = false, raf = null, lastY = 0;
  const scroller = node.closest('.tl-body');
  const apply = (s, len) => {
    node.style.top = `${(s / 60) * HOUR}px`;
    node.style.height = `${(len / 60) * HOUR}px`;
    const lab = node.querySelector('.tlb-body span');
    if (lab) lab.textContent = `${minToHM(s)}–${minToHM(s + len)}`;
  };
  const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = null; } };
  const tick = () => {
    raf = null;
    if (!mode || !scroller) return;
    const r = scroller.getBoundingClientRect();
    const EDGE = 56;
    let v = 0;
    if (lastY < r.top + EDGE) v = -11;
    else if (lastY > r.bottom - EDGE) v = 11;
    if (v) {
      const before = scroller.scrollTop;
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, before + v));
      sy -= scroller.scrollTop - before;   // блок остаётся под пальцем
      onMove({ clientY: lastY });
    }
    raf = requestAnimationFrame(tick);
  };
  const onMove = e => {
    lastY = e.clientY;
    if (!moved && Math.abs(e.clientY - sy) < 4) return;
    moved = true;
    node.classList.add('dragging');
    const d = snap(((e.clientY - sy) / HOUR) * 60);
    if (mode === 'move') apply(Math.max(0, Math.min(DAY_MIN - len0, s0 + d)), len0);
    else if (mode === 'bottom') apply(s0, Math.max(MIN_LEN, Math.min(DAY_MIN - s0, len0 + d)));
    else {
      const s = Math.max(0, Math.min(s0 + len0 - MIN_LEN, s0 + d));
      apply(s, s0 + len0 - s);
    }
  };
  const onUp = async () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('tl-dragging');
    stop();
    node.classList.remove('dragging');
    mode = null;
    if (!moved) { openSheet(getTask(node.dataset.id)); return; }
    const s = Math.round((parseFloat(node.style.top) / HOUR) * 60);
    const len = Math.max(MIN_LEN, Math.round((parseFloat(node.style.height) / HOUR) * 60));
    hapticMedium();
    await setTaskPlan(node.dataset.id, node.dataset.day, minToHM(s), minToHM(s + len));
    refreshTimeline();
  };
  node.addEventListener('pointerdown', e => {
    if (e.button === 1 || e.button === 2) return;
    e.preventDefault();
    const t = getTask(node.dataset.id);
    if (!t) return;
    const grip = e.target.closest('.tlb-grip');
    mode = grip ? (grip.classList.contains('top') ? 'top' : 'bottom') : 'move';
    sy = e.clientY;
    lastY = e.clientY;
    s0 = Math.round((parseFloat(node.style.top) / HOUR) * 60);
    len0 = Math.max(MIN_LEN, Math.round((parseFloat(node.style.height) / HOUR) * 60));
    moved = false;
    hapticLight();
    document.body.classList.add('tl-dragging');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    if (scroller) tick();
  });
}

/* ── Полоса расписания на сетке ──
   Тянем за края — меняем начало и конец, тянем за середину — сдвигаем
   дело целиком. Правка общая для всех дней, где дело повторяется: это
   одна запись расписания, а не отдельные копии. Клик без движения
   открывает окно дела, крестик удаляет. */
function bindRoutine(node) {
  const del = node.querySelector('.tlr-del');
  if (del) {
    del.addEventListener('pointerdown', e => e.stopPropagation());
    del.onclick = async e => {
      e.stopPropagation();
      const r = getRoutines().find(x => x.id === node.dataset.id);
      if (!r || !confirm(`Удалить «${r.title}» из расписания?`)) return;
      await removeRoutine(r.id);
      refreshTimeline();
    };
  }
  const part = node.dataset.part;
  let mode = null, sy = 0, top0 = 0, h0 = 0, moved = false;
  const onMove = e => {
    if (!mode) return;                       // у куска ночного дела середина не двигается
    if (!moved && Math.abs(e.clientY - sy) < 4) return;
    moved = true;
    node.classList.add('dragging');
    const d = (e.clientY - sy);
    const minPx = (MIN_LEN / 60) * HOUR;
    const maxPx = 24 * HOUR;
    let top = top0, h = h0;
    if (mode === 'move') top = Math.max(0, Math.min(maxPx - h0, top0 + d));
    else if (mode === 'bottom') h = Math.max(minPx, Math.min(maxPx - top0, h0 + d));
    else { top = Math.max(0, Math.min(top0 + h0 - minPx, top0 + d)); h = top0 + h0 - top; }
    const snapPx = v => Math.round(((v / HOUR) * 60) / SNAP) * SNAP / 60 * HOUR;
    top = snapPx(top); h = snapPx(h);
    node.style.top = top + 'px';
    node.style.height = h + 'px';
    const tm = node.querySelector('.tlr-time');
    if (tm) tm.textContent = `${minToHM((top / HOUR) * 60)}–${minToHM(((top + h) / HOUR) * 60)}`;
  };
  const onUp = async () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('tl-dragging');
    node.classList.remove('dragging');
    const r = getRoutines().find(x => x.id === node.dataset.id);
    if (!r) return;
    if (!moved) { openRoutineEditor(r.id); return; }
    const a = Math.round((parseFloat(node.style.top) / HOUR) * 60);
    const b = Math.round(((parseFloat(node.style.top) + parseFloat(node.style.height)) / HOUR) * 60);
    const patch = {};
    if (part === 'whole') { patch.start = minToHM(a); patch.end = minToHM(Math.min(b, DAY_MIN - 1)); }
    else if (part === 'eve') patch.start = minToHM(a);          // ночное дело: вечером двигаем начало
    else patch.end = minToHM(Math.min(b, DAY_MIN - 1));          // утром — конец
    hapticMedium();
    await saveRoutine(patch, r.id);
    refreshTimeline();
  };
  node.addEventListener('pointerdown', e => {
    if (e.button === 1 || e.button === 2) return;
    e.preventDefault();
    e.stopPropagation();
    const grip = e.target.closest('.tlb-grip');
    mode = grip ? (grip.classList.contains('top') ? 'top' : 'bottom') : (part === 'whole' ? 'move' : null);
    sy = e.clientY;
    top0 = parseFloat(node.style.top);
    h0 = parseFloat(node.style.height);
    moved = false;
    document.body.classList.add('tl-dragging');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });
}

/* ── Окно «Расписание» ── */
const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const R_COLORS = ['#64748b', '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
function openRoutines() {
  const ov = document.createElement('div');
  ov.className = 'notes-list-overlay';
  const draw = () => {
    const list = getRoutines();
    ov.innerHTML = `<div class="notes-list-modal glass tl-rsheet">
      <header class="notes-list-head"><h3>Расписание</h3>
        <button type="button" class="notes-list-close">✕</button></header>
      <p class="hint">Повседневные дела — обед, сон, дорога. Видны только в Timeline и не попадают в список задач.</p>
      <div class="notes-list-content">${list.length ? list.map(r => `
        <button type="button" class="tl-rrow" data-id="${esc(r.id)}" style="--rc:${esc(r.color || '#64748b')}">
          <i></i><b>${esc(r.title)}</b>
          <span>${esc(r.start)}–${esc(r.end)}</span>
          <em>${(r.days || []).length === 7 ? 'каждый день' : (r.days || []).map(n => WD[n - 1]).join(' ')}</em>
        </button>`).join('') : '<p class="empty">Пока пусто</p>'}</div>
      <div class="ne-actions"><span class="spacer"></span>
        <button type="button" class="btn primary tl-radd">＋ Дело</button></div></div>`;
    ov.querySelector('.notes-list-close').onclick = () => ov.remove();
    ov.querySelector('.tl-radd').onclick = () => openRoutineEditor(null, draw);
    ov.querySelectorAll('.tl-rrow').forEach(b => b.onclick = () => openRoutineEditor(b.dataset.id, draw));
  };
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
  draw();
  document.body.appendChild(ov);
}
function openRoutineEditor(id, after) {
  const r = id ? getRoutines().find(x => x.id === id) : null;
  let days = r ? [...(r.days || [])] : [1, 2, 3, 4, 5, 6, 7];
  let color = (r && r.color) || R_COLORS[0];
  const ov = document.createElement('div');
  ov.className = 'notes-list-overlay';
  ov.innerHTML = `<div class="notes-list-modal glass tl-rsheet">
    <header class="notes-list-head"><h3>${r ? 'Дело' : 'Новое дело'}</h3>
      <button type="button" class="notes-list-close">✕</button></header>
    <div class="fin-form">
      <label class="fin-field"><span>Название</span>
        <input class="fin-in tr-title" type="text" maxlength="60" value="${r ? esc(r.title) : ''}" placeholder="Обед, Сон, Дорога…"></label>
      <div class="fin-row2">
        <label class="fin-field"><span>Начало</span><input class="fin-in tr-s" type="time" step="300" value="${r ? esc(r.start) : '13:00'}"></label>
        <label class="fin-field"><span>Конец</span><input class="fin-in tr-e" type="time" step="300" value="${r ? esc(r.end) : '14:00'}"></label>
      </div>
      <div class="fin-field"><span>Дни</span><div class="tr-days">${WD.map((w, i) =>
        `<button type="button" class="tr-day${days.includes(i + 1) ? ' on' : ''}" data-d="${i + 1}">${w}</button>`).join('')}</div></div>
      <div class="fin-field"><span>Цвет</span><div class="kg-colors">${R_COLORS.map(c =>
        `<button type="button" class="kg-dot${c === color ? ' on' : ''}" data-c="${c}" style="--c:${c}"></button>`).join('')}</div></div>
      <p class="hint">Конец раньше начала — значит, дело идёт через полночь (например, сон 23:00–07:00).</p>
    </div>
    <div class="ne-actions">
      ${r ? '<button type="button" class="btn danger tr-del">Удалить</button>' : ''}
      <span class="spacer"></span>
      <button type="button" class="btn primary tr-save">Сохранить</button></div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.notes-list-close').onclick = close;
  ov.onclick = e => { if (e.target === ov) close(); };
  ov.querySelectorAll('.tr-day').forEach(b => b.onclick = () => {
    const d = +b.dataset.d;
    days = days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort();
    b.classList.toggle('on', days.includes(d));
  });
  ov.querySelectorAll('.kg-dot').forEach(b => b.onclick = () => {
    color = b.dataset.c;
    ov.querySelectorAll('.kg-dot').forEach(x => x.classList.toggle('on', x === b));
  });
  ov.querySelector('.tr-save').onclick = async () => {
    const title = ov.querySelector('.tr-title').value.trim();
    if (!title) { ov.querySelector('.tr-title').focus(); return; }
    if (!days.length) { alert('Выберите хотя бы один день'); return; }
    await saveRoutine({
      title: title.slice(0, 60),
      start: ov.querySelector('.tr-s').value || '13:00',
      end: ov.querySelector('.tr-e').value || '14:00',
      days, color,
    }, id);
    close();
    refreshTimeline();
    if (after) after();
  };
  const del = ov.querySelector('.tr-del');
  if (del) del.onclick = async () => {
    if (!confirm('Удалить дело из расписания?')) return;
    await removeRoutine(id);
    close();
    refreshTimeline();
    if (after) after();
  };
  setTimeout(() => ov.querySelector('.tr-title').focus(), 60);
}
kbSubscribe(() => refreshTimeline());

/* Любая правка задачи (в том числе блок «Планирование» в редакторе)
   должна тут же отражаться на сетке */
document.addEventListener('focus-session', () => refreshTimeline());
subscribe(() => refreshTimeline());
