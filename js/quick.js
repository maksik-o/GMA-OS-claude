/* ══════════════════════════════════════════════════════════════════
   Панель ввода новой задачи — варианты на выбор (Настройки → Ввод
   новой задачи):

   smart   — «умная строка»: одна фраза, дата/время/приоритет/режим/
             тип распознаются из текста и показываются чипами;
   builder — «конструктор»: название и лента кнопок-свойств, каждая
             раскрывает свой выбор прямо в панели, внизу превью;
   dump    — «штурм и раскладка»: сначала пишем всё подряд (строка =
             задача), потом смахиваем карточки по дням.

   Выбор хранится в этом браузере (как тема и раскладка виджетов).
   ══════════════════════════════════════════════════════════════════ */
import {
  state, today, addDays, WEEKDAYS, MODES, TYPE_LABEL, PRIORITY_LABEL,
  createTask, uid, esc, parseISO, getTagsDict, getTagColor, addTagsToDict,
} from './store.js';
import { attachFile } from './files.js';
import { limitNote, attachLimit, fmtSize } from './attach.js';

const STYLE_KEY = 'rl_quick_style';
const DUMP_KEY = 'rl_quick_dump';

export const QUICK_STYLES = [
  {
    id: 'builder', label: 'Конструктор', icon: '⚙',
    desc: 'Название и кнопки-свойства: всё задаётся сразу, без большого редактора.',
    how: [
      'Под названием — кнопки: Дни · Время · Приоритет · Режим · Тип · Теги · Подзадачи · Файл.',
      'Тап по кнопке раскрывает её выбор прямо в панели; выбранное пишется на кнопке.',
      'Внизу — превью: так задача будет выглядеть в списке.',
      '«Подробнее» создаёт задачу и открывает её полную карточку.',
    ],
  },
  {
    id: 'smart', label: 'Умная строка', icon: '⌁',
    desc: 'Одна фраза — приложение само понимает дату, время, приоритет, режим и тип.',
    how: [
      'Даты: «сегодня», «завтра», «послезавтра», «в пятницу», «пн», «20.10».',
      'Время и длительность: «в 15:00», «15:30», «30м», «1ч».',
      'Приоритет: «!» — высокий, «!!» — средний, «!!!» — низкий, или слово «срочно».',
      'Режим: #работа, #дом, #учёба. Любое другое #слово — тег. Тип: «встреча», «проект», «событие», «мелочь».',
      'Распознанное видно чипами под строкой; тап по чипу убирает его.',
      'Enter — добавить и сразу вводить следующую. Esc — закрыть.',
    ],
  },
  {
    id: 'dump', label: 'Штурм и раскладка', icon: '❖',
    desc: 'Сначала записать всё из головы, потом разложить по дням жестами.',
    how: [
      'Шаг 1: пишете задачи подряд — каждая строка станет задачей.',
      'Шаг 2: задачи по одной показываются карточкой. Смахните вправо — на сегодня, влево — на завтра, вверх — без даты; кнопкой «День…» — на любой день недели.',
      'Под карточкой — неделя с числом задач по дням: видно перегруженные дни.',
      'Не разложенные задачи дождутся следующего открытия панели.',
      '«Всё на сегодня» — короткий путь, без раскладки.',
    ],
  },
];

export function quickStyle() {
  let s = '';
  try { s = localStorage.getItem(STYLE_KEY) || ''; } catch {}
  return QUICK_STYLES.some(x => x.id === s) ? s : 'builder';   // «классика» убрана — её выбор тоже ведёт сюда
}
export function setQuickStyle(id) {
  try { localStorage.setItem(STYLE_KEY, id); } catch {}
}

/* ── общее ── */
const realModes = () => MODES.filter(m => m.id !== 'all');
const modeLabel = id => (MODES.find(m => m.id === id) || {}).label || id;
const defaultMode = () => (state.mode && state.mode !== 'all' ? state.mode : 'work');
const dayOff = (ds) => Math.round((parseISO(ds) - parseISO(today())) / 864e5);
function dayLabel(ds) {
  const off = dayOff(ds);
  if (off === 0) return 'Сегодня';
  if (off === 1) return 'Завтра';
  if (off === 2) return 'Послезавтра';
  const d = parseISO(ds);
  return WEEKDAYS[(d.getDay() + 6) % 7] + ' ' + d.getDate();
}
const durLabel = m => (m >= 60 ? (m % 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m / 60} ч`) : `${m} мин`);
function rowPreview(t) {
  const days = Object.keys(t.days || {}).sort();
  const when = days.length ? days.map(dayLabel).join(', ') : 'без даты';
  const bits = [when, t.blockStart ? '⏰ ' + t.blockStart : '', t.subtasks && t.subtasks.length ? `☑ 0/${t.subtasks.length}` : '',
    ...(t.tags || []).map(x => '#' + x)].filter(Boolean);
  return `<div class="qx-row"><i style="background:var(--mode-${t.mode || defaultMode()})"></i>
    <span>${t.priority === 1 ? '<b class="qx-p1">! </b>' : ''}${esc(t.title || 'Новая задача')}</span><em>${esc(bits.join(' · '))}</em></div>`;
}
let ctx = null;   // { host, close, openEditor, rerender }
function done() { if (ctx && ctx.rerender) ctx.rerender(); }

/* Точка входа: нарисовать выбранный вариант в host */
export function renderQuickAlt(host, opts) {
  ctx = { host, ...opts };
  const st = quickStyle();
  host.dataset.qs = st;
  if (st === 'smart') smartInit(host);
  else if (st === 'builder') builderInit(host);
  else if (st === 'dump') dumpInit(host);
}

/* ══════════════ 1. Умная строка ══════════════ */
const WD = { 'пн': 0, 'понедельник': 0, 'вт': 1, 'вторник': 1, 'ср': 2, 'среду': 2, 'среда': 2, 'чт': 3, 'четверг': 3,
  'пт': 4, 'пятницу': 4, 'пятница': 4, 'сб': 5, 'субботу': 5, 'суббота': 5, 'вс': 6, 'воскресенье': 6 };
const TYPE_WORDS = { 'встреча': 'meeting', 'встречу': 'meeting', 'проект': 'project', 'событие': 'event', 'мелочь': 'small' };
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function parseQuick(text) {
  let s = ' ' + text + ' ';
  const out = { day: undefined, time: '', dur: 0, pri: 0, mode: '', type: '', marks: [] };
  const take = (re, fn) => { s = s.replace(re, (...m) => { fn(m); out.marks.push({ text: m[0].trim(), kind: fn.kind }); return ' '; }); };
  const T = today();
  const k = (kind, fn) => { fn.kind = kind; return fn; };
  take(/\s(сегодня)(?=\s)/i, k('day', () => { out.day = T; }));
  take(/\s(послезавтра)(?=\s)/i, k('day', () => { out.day = addDays(T, 2); }));
  take(/\s(завтра)(?=\s)/i, k('day', () => { out.day = addDays(T, 1); }));
  take(/\s(без\s+даты)(?=\s)/i, k('day', () => { out.day = null; }));
  take(/\s(?:во?\s)?(понедельник|вторник|среду|среда|четверг|пятницу|пятница|субботу|суббота|воскресенье|пн|вт|ср|чт|пт|сб|вс)(?=\s)/i,
    k('day', m => { const w = WD[m[1].toLowerCase()]; const ti = (parseISO(T).getDay() + 6) % 7; out.day = addDays(T, (w - ti + 7) % 7); }));
  take(/\s(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?=\s)/, k('day', m => {
    const now = parseISO(T); let y = m[3] ? +m[3] : now.getFullYear(); if (y < 100) y += 2000;
    const d = new Date(y, +m[2] - 1, +m[1]);
    if (!m[3] && d < now) d.setFullYear(y + 1);   // «05.01» в декабре — это следующий год
    if (!isNaN(d)) out.day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }));
  take(/\s(?:в\s)?([01]?\d|2[0-3]):([0-5]\d)(?=\s)/, k('time', m => { out.time = m[1].padStart(2, '0') + ':' + m[2]; }));
  take(/\s(\d{1,3})\s?(м|мин|ч|час|часа|часов)(?=\s)/i, k('dur', m => { out.dur = (/^ч/i.test(m[2]) ? 60 : 1) * +m[1]; }));
  take(/\s(!{1,3})(?=\s)/, k('pri', m => { out.pri = m[1].length; }));
  take(/\s(срочно)(?=\s)/i, k('pri', () => { out.pri = 1; }));
  const modeNames = [];
  for (const md of realModes()) {
    modeNames.push([md.label.toLowerCase().replace(/\s+/g, ''), md.id]);
    const def = { work: ['работа'], home: ['дом'], study: ['учёба', 'учеба'] }[md.id] || [];
    def.forEach(n => modeNames.push([n, md.id]));
  }
  if (modeNames.length) {
    const re = new RegExp('\\s#(' + modeNames.map(([n]) => reEsc(n)).join('|') + ')(?=\\s)', 'i');
    take(re, k('mode', m => { const hit = modeNames.find(([n]) => n === m[1].toLowerCase()); if (hit) out.mode = hit[1]; }));
  }
  /* Слово типа в начале фразы — часть названия («Встреча с куратором»):
     тип ставим, но из текста не вырезаем. В остальных местах — вырезаем. */
  const lead = s.match(/^\s*(встреча|встречу|проект|событие|мелочь)(?=\s)/i);
  if (lead) {
    out.type = TYPE_WORDS[lead[1].toLowerCase()];
    const head = s.slice(0, lead[0].length);
    s = s.slice(lead[0].length);
    take(/\s(встреча|встречу|проект|событие|мелочь)(?=\s)/i, k('type', () => {}));
    s = head + s;
  } else {
    take(/\s(встреча|встречу|проект|событие|мелочь)(?=\s)/i, k('type', m => { out.type = TYPE_WORDS[m[1].toLowerCase()]; }));
  }
  /* Остальные #слова — теги (режимы уже разобраны выше) */
  out.tags = [];
  let tm;
  const tagRe = /\s#([^\s#]{1,40})(?=\s)/;
  while ((tm = s.match(tagRe))) {
    const name = tm[1];
    const known = getTagsDict().find(t => t.name.toLowerCase() === name.toLowerCase());
    const nm = known ? known.name : name;
    if (!out.tags.some(x => x.toLowerCase() === nm.toLowerCase())) out.tags.push(nm);
    out.marks.push({ text: tm[0].trim(), kind: 'tag', tag: nm });
    s = s.replace(tagRe, ' ');
  }
  out.title = s.replace(/\s+/g, ' ').trim();
  return out;
}
function smartTask(p) {
  const day = p.day === undefined ? today() : p.day;
  return {
    title: p.title, days: day ? { [day]: 'todo' } : {},
    priority: p.pri || 2, mode: p.mode || undefined, type: p.type || 'task',
    blockStart: p.time || null, blockMin: p.dur || 30, tags: p.tags || [],
  };
}
function smartInit(host) {
  const added = [];
  host.innerHTML = `
    <div class="qx qx-smart">
      <div class="qx-line">
        <input class="qx-in" type="text" maxlength="400" autocomplete="off" enterkeyhint="send"
          placeholder="Например: отчёт пт 10:00 !">
        <button type="button" class="qx-send" title="Добавить (Enter)" disabled>↑</button>
      </div>
      <div class="qx-chips"></div>
      <div class="qx-sugg">${['завтра', 'в пятницу', 'в 10:00', '30м', '!', ...realModes().map(m => '#' + m.label.toLowerCase().replace(/\s+/g, '')), 'встреча',
        ...getTagsDict().slice(0, 6).map(t => '#' + t.name.replace(/\s+/g, '_'))]
        .map(w => `<button type="button">${esc(w)}</button>`).join('')}</div>
      <div class="qx-added"></div>
      <p class="qx-help">Enter — добавить и продолжить · Esc — закрыть</p>
    </div>`;
  const inp = host.querySelector('.qx-in');
  const send = host.querySelector('.qx-send');
  const chips = host.querySelector('.qx-chips');
  const upd = () => {
    const p = parseQuick(inp.value);
    const list = [];
    const dayTxt = p.day === undefined ? null : p.day === null ? 'Без даты' : dayLabel(p.day);
    for (const mk of p.marks) {
      let lbl = '';
      if (mk.kind === 'day') lbl = '📅 ' + dayTxt;
      else if (mk.kind === 'time') lbl = '⏰ ' + p.time;
      else if (mk.kind === 'dur') lbl = '⏳ ' + durLabel(p.dur);
      else if (mk.kind === 'pri') lbl = '⚑ ' + PRIORITY_LABEL[p.pri];
      else if (mk.kind === 'mode') lbl = '● ' + modeLabel(p.mode);
      else if (mk.kind === 'type') lbl = '▣ ' + TYPE_LABEL[p.type];
      else if (mk.kind === 'tag') lbl = '# ' + mk.tag;
      const tc = mk.kind === 'tag' ? getTagColor(mk.tag) : null;
      const tint = mk.kind === 'mode' ? ` style="--k:var(--mode-${p.mode})"` : tc ? ` style="--k:${tc}"` : '';
      list.push(`<button type="button" class="qx-chip k-${mk.kind}"${tint} data-t="${esc(mk.text)}" title="Убрать">${esc(lbl)}<span>✕</span></button>`);
    }
    if (p.type && !p.marks.some(m => m.kind === 'type')) list.push(`<span class="qx-chip k-type">▣ ${esc(TYPE_LABEL[p.type])}</span>`);
    chips.innerHTML = list.length
      ? list.join('') + (p.title ? `<span class="qx-to">→ «${esc(p.title)}»</span>` : '')
      : `<span class="qx-to">${p.title ? 'Сегодня · ' + esc(modeLabel(defaultMode())) + ' · средний приоритет' : 'Распознанное появится здесь'}</span>`;
    send.disabled = !p.title;
  };
  const add = async () => {
    const p = parseQuick(inp.value);
    if (!p.title) return;
    const data = smartTask(p);
    if (data.tags.length) await addTagsToDict(data.tags);
    await createTask(data);
    added.unshift(data);
    inp.value = '';
    upd();
    host.querySelector('.qx-added').innerHTML = added.slice(0, 4).map(t => rowPreview({ ...t, mode: t.mode || defaultMode() })).join('');
    done();
    inp.focus();
  };
  inp.addEventListener('input', upd);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); add(); }
    else if (e.key === 'Escape') { e.preventDefault(); ctx.close(); }
  });
  send.onclick = add;
  chips.onclick = e => {
    const c = e.target.closest('.qx-chip');
    if (!c) return;
    const t = c.dataset.t;
    const i = inp.value.toLowerCase().indexOf(t.toLowerCase());
    if (i >= 0) inp.value = (inp.value.slice(0, i) + inp.value.slice(i + t.length)).replace(/\s{2,}/g, ' ');
    upd(); inp.focus();
  };
  host.querySelector('.qx-sugg').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    inp.value = (inp.value.trim() + ' ' + b.textContent).trim() + ' ';
    upd(); inp.focus();
  };
  upd();
  requestAnimationFrame(() => inp.focus());
}

/* ══════════════ 2. Конструктор ══════════════ */
function builderInit(host) {
  const b = {
    title: '', days: { [today()]: 'todo' }, weekStart: state.weekStart, time: '', dur: 30,
    pri: 2, mode: defaultMode(), type: 'task', subs: [], tags: [], file: null, open: 'days',
  };
  host.innerHTML = `
    <div class="qx qx-builder">
      <textarea class="f-title qx-title" rows="1" maxlength="400" placeholder="Новая задача…"></textarea>
      <div class="qx-tools"></div>
      <div class="qx-pop"></div>
      <div class="qx-preview"><div class="qx-cap">Так будет в списке</div><div class="qx-prev"></div></div>
    </div>
    <div class="qx-actions">
      <button type="button" class="btn qx-more">Подробнее</button>
      <span class="spacer"></span>
      <button type="button" class="btn primary qx-add" disabled>Добавить</button>
    </div>`;
  const title = host.querySelector('.qx-title');
  const tools = host.querySelector('.qx-tools');
  const pop = host.querySelector('.qx-pop');
  const grow = () => { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; };
  const daysTxt = () => { const d = Object.keys(b.days).sort(); return !d.length ? 'Без даты' : d.length === 1 ? dayLabel(d[0]) : `${dayLabel(d[0])} +${d.length - 1}`; };
  const TOOLS = [
    ['days', '📅', daysTxt, () => true],
    ['time', '⏰', () => (b.time ? `${b.time} · ${durLabel(b.dur)}` : 'Время'), () => !!b.time],
    ['pri', '⚑', () => PRIORITY_LABEL[b.pri], () => b.pri !== 2],
    ['mode', '', () => modeLabel(b.mode), () => true],
    ['type', '▣', () => TYPE_LABEL[b.type], () => b.type !== 'task'],
    ['tags', '#', () => (b.tags.length ? b.tags.join(', ') : 'Теги'), () => b.tags.length > 0],
    ['subs', '☑', () => (b.subs.length ? `Подзадачи · ${b.subs.length}` : 'Подзадачи'), () => b.subs.length > 0],
    ['file', '📎', () => (b.file ? b.file.name : 'Файл'), () => !!b.file],
  ];
  const seg = (key, opts) => `<div class="qx-seg">${opts.map(([v, l]) =>
    `<button type="button" data-k="${key}" data-v="${esc(String(v))}" class="${String(b[key]) === String(v) ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
  const task = () => ({
    title: b.title.trim(), days: { ...b.days }, priority: b.pri, mode: b.mode, type: b.type,
    blockStart: b.time || null, blockMin: b.dur, tags: b.tags.slice(),
    subtasks: b.subs.map(text => ({ id: uid(), text, done: false })),
  });
  function render() {
    tools.innerHTML = TOOLS.map(([id, ic, lbl, set]) =>
      `<button type="button" class="qx-tool${set() ? ' set' : ''}${b.open === id ? ' open' : ''}" data-t="${id}">${id === 'mode' ? `<i class="qx-dot" style="background:var(--mode-${b.mode})"></i>` : ic} <span>${esc(lbl())}</span></button>`).join('');
    const o = b.open;
    if (o === 'days') {
      let h = '<div class="qx-cap">Дни <span class="qx-wk"><button type="button" data-wk="-1">‹</button><button type="button" data-wk="1">›</button></span></div><div class="q-days">';
      for (let i = 0; i < 7; i++) {
        const d = addDays(b.weekStart, i);
        const we = i >= 5 ? ' we' : '';
        h += `<button type="button" class="q-day${b.days[d] ? ' on' : ''}${we}" data-day="${d}"><span class="d-name${we}">${WEEKDAYS[i]}</span><span class="d-num${we}">${+d.slice(8)}</span></button>`;
      }
      h += `</div><div class="qx-seg"><button type="button" data-k="nodate" class="${Object.keys(b.days).length ? '' : 'on'}">Без даты</button><button type="button" data-k="today">Сегодня</button></div>`;
      pop.innerHTML = h;
    } else if (o === 'time') {
      pop.innerHTML = '<div class="qx-cap">Начало</div>'
        + seg('time', [['', 'Без времени'], ['09:00', '09:00'], ['12:00', '12:00'], ['15:00', '15:00'], ['18:00', '18:00']])
        + `<label class="qx-timein">Своё: <input type="time" value="${b.time}"></label>`
        + '<div class="qx-cap">Длительность</div>' + seg('dur', [[15, '15 мин'], [30, '30 мин'], [60, '1 ч'], [90, '1,5 ч'], [120, '2 ч']]);
      pop.querySelector('input[type=time]').onchange = e => { b.time = e.target.value; render(); };
    } else if (o === 'pri') pop.innerHTML = '<div class="qx-cap">Приоритет</div>' + seg('pri', [[1, '⚑ Высокий'], [2, 'Средний'], [3, 'Низкий']]);
    else if (o === 'mode') pop.innerHTML = '<div class="qx-cap">Режим</div>' + seg('mode', realModes().map(m => [m.id, m.label]));
    else if (o === 'type') pop.innerHTML = '<div class="qx-cap">Тип</div>' + seg('type', Object.entries(TYPE_LABEL));
    else if (o === 'tags') {
      const dict = getTagsDict();
      const all = [...dict.map(t => t.name), ...b.tags.filter(n => !dict.some(t => t.name === n))];
      pop.innerHTML = `<div class="qx-cap">Теги</div>
        <div class="qx-seg qx-tags">${all.map(n => { const c = getTagColor(n); return `<button type="button" data-tag="${esc(n)}" class="${b.tags.includes(n) ? 'on' : ''}"${c ? ` style="--tc:${c}"` : ''}># ${esc(n)}</button>`; }).join('')
          || '<span class="qx-to">Тегов пока нет — введите первый ниже</span>'}</div>
        <div class="qx-subin"><input type="text" maxlength="40" placeholder="Новый тег и Enter" enterkeyhint="done"><button type="button" class="btn mini">＋</button></div>`;
      const ti = pop.querySelector('.qx-subin input');
      const addTag = () => {
        const v = ti.value.trim().replace(/^#/, '');
        if (!v) return;
        const known = dict.find(t => t.name.toLowerCase() === v.toLowerCase());
        const nm = known ? known.name : v;
        if (!b.tags.includes(nm)) b.tags.push(nm);
        render(); pop.querySelector('.qx-subin input').focus();
      };
      ti.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } };
      pop.querySelector('.qx-subin button').onclick = addTag;
    } else if (o === 'subs') {
      pop.innerHTML = `<div class="qx-cap">Подзадачи</div><div class="qx-subin"><input type="text" maxlength="200" placeholder="Шаг и Enter" enterkeyhint="done"><button type="button" class="btn mini">＋</button></div>
        <ul class="qx-subs">${b.subs.map((s, i) => `<li><span>☐ ${esc(s)}</span><button type="button" data-rm="${i}" title="Убрать">✕</button></li>`).join('')}</ul>`;
      const si = pop.querySelector('.qx-subin input');
      const addSub = () => { const v = si.value.trim(); if (!v) return; b.subs.push(v); render(); pop.querySelector('.qx-subin input').focus(); };
      si.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addSub(); } };
      pop.querySelector('.qx-subin button').onclick = addSub;
    } else if (o === 'file') {
      const note = limitNote();
      pop.innerHTML = `<div class="qx-cap">Вложение</div>
        <div class="qx-seg"><label class="qx-filebtn">📎 ${b.file ? 'Другой файл…' : 'Выбрать файл…'}<input type="file" hidden></label>${b.file ? '<button type="button" data-k="nofile">Убрать</button>' : ''}</div>
        ${b.file ? `<p class="qx-filename">${esc(b.file.name)} · ${fmtSize(b.file.size)}</p>` : ''}
        ${note ? `<p class="file-limit">⚠ ${esc(note)}</p>` : ''}`;
      pop.querySelector('input[type=file]').onchange = e => {
        const f = e.target.files[0];
        if (!f) return;
        const lim = attachLimit();
        if (lim && f.size > lim.bytes) { alert(`«${f.name}» — ${fmtSize(f.size)}. ${lim.text}.`); return; }
        if (f.size > 5 * 1024 * 1024) { alert('Файл больше 5 МБ'); return; }
        b.file = f; render();
      };
    } else pop.innerHTML = '';
    pop.hidden = !o;
    host.querySelector('.qx-prev').innerHTML = rowPreview(task());
    host.querySelector('.qx-add').disabled = !b.title.trim();
  }
  async function create() {
    const t = task();
    if (!t.title) { title.focus(); return null; }
    if (t.tags.length) await addTagsToDict(t.tags);
    const made = await createTask(t);
    if (b.file && made) { try { await attachFile(made.id, b.file); } catch (e) { alert(e.message); } }
    done();
    return made;
  }
  tools.onclick = e => { const t = e.target.closest('.qx-tool'); if (t) { b.open = b.open === t.dataset.t ? '' : t.dataset.t; render(); } };
  pop.onclick = e => {
    const wk = e.target.closest('[data-wk]');
    if (wk) { b.weekStart = addDays(b.weekStart, 7 * +wk.dataset.wk); render(); return; }
    const d = e.target.closest('[data-day]');
    if (d) { if (b.days[d.dataset.day]) delete b.days[d.dataset.day]; else b.days[d.dataset.day] = 'todo'; render(); return; }
    const tg = e.target.closest('[data-tag]');
    if (tg) { const n = tg.dataset.tag; b.tags = b.tags.includes(n) ? b.tags.filter(x => x !== n) : [...b.tags, n]; render(); return; }
    const r = e.target.closest('[data-rm]');
    if (r) { b.subs.splice(+r.dataset.rm, 1); render(); return; }
    const s = e.target.closest('[data-k]');
    if (!s) return;
    const key = s.dataset.k;
    if (key === 'nodate') b.days = {};
    else if (key === 'today') { b.days = { [today()]: 'todo' }; b.weekStart = state.weekStart; }
    else if (key === 'nofile') b.file = null;
    else { const v = s.dataset.v; b[key] = (key === 'pri' || key === 'dur') ? +v : v; }
    render();
  };
  title.addEventListener('input', () => { b.title = title.value; grow(); render(); });
  title.addEventListener('keydown', async e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (await create()) ctx.close(); }
    else if (e.key === 'Escape') { e.preventDefault(); ctx.close(); }
  });
  host.querySelector('.qx-add').onclick = async () => { if (await create()) ctx.close(); };
  host.querySelector('.qx-more').onclick = async () => {
    const made = await create();
    if (made) { ctx.close(); ctx.openEditor && ctx.openEditor(made); }
  };
  render();
  requestAnimationFrame(() => title.focus());
}

/* ══════════════ 3. Штурм и раскладка ══════════════ */
function loadDump() {
  try { const d = JSON.parse(localStorage.getItem(DUMP_KEY) || 'null'); if (d && Array.isArray(d.queue)) return d; } catch {}
  return { stage: 'dump', text: '', queue: [], placed: 0, nodate: 0 };
}
function saveDump(d) {
  try { localStorage.setItem(DUMP_KEY, JSON.stringify(d)); } catch {}
}
function dumpInit(host) {
  const d = loadDump();
  if (d.stage === 'sort' && !d.queue.length) Object.assign(d, { stage: 'dump', placed: 0, nodate: 0 });
  const weekLoad = (start) => {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const ds = addDays(start, i);
      out.push({ ds, n: state.tasks.filter(t => t && !t.deleted && t.days && t.days[ds]).length });
    }
    return out;
  };
  const steps = () => `<div class="qx-steps"><span class="${d.stage === 'dump' ? 'on' : ''}">1 · Выгрузить</span><span class="${d.stage !== 'dump' ? 'on' : ''}">2 · Разложить</span></div>`;
  const lines = txt => txt.split('\n').map(x => x.trim()).filter(Boolean);
  function render(hl) {
    saveDump(d);
    if (d.stage === 'dump') {
      host.innerHTML = `<div class="qx qx-dump">${steps()}
        <textarea class="qx-lines" placeholder="Каждая строка — отдельная задача"></textarea>
        <div class="qx-count"></div></div>
        <div class="qx-actions">
          <button type="button" class="btn qx-alltoday">Всё на сегодня</button>
          <span class="spacer"></span>
          <button type="button" class="btn primary qx-go">Разложить →</button>
        </div>`;
      const ta = host.querySelector('.qx-lines');
      ta.value = d.text;
      const cnt = () => {
        const n = lines(ta.value).length;
        host.querySelector('.qx-count').textContent = n ? `Задач: ${n}` : 'Пишите по одной задаче в строке, Enter — новая строка';
        host.querySelector('.qx-go').disabled = !n;
        host.querySelector('.qx-alltoday').disabled = !n;
      };
      ta.oninput = () => { d.text = ta.value; saveDump(d); cnt(); };
      ta.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); ctx.close(); } };
      cnt();
      host.querySelector('.qx-go').onclick = () => { d.queue = lines(d.text); d.text = ''; d.stage = 'sort'; d.placed = 0; d.nodate = 0; render(); };
      host.querySelector('.qx-alltoday').onclick = async () => {
        for (const title of lines(d.text)) await createTask({ title, days: { [today()]: 'todo' }, priority: 2, type: 'task', tags: [] });
        d.text = ''; saveDump(d); done(); ctx.close();
      };
      requestAnimationFrame(() => ta.focus());
      return;
    }
    if (!d.queue.length) {
      host.innerHTML = `<div class="qx qx-dump">${steps()}<div class="qx-done">Всё разложено ✓
        <small>${d.placed ? `В неделю: ${d.placed}. ` : ''}${d.nodate ? `Без даты: ${d.nodate}.` : ''}</small></div></div>
        <div class="qx-actions"><button type="button" class="btn qx-again">Ещё задачи</button><span class="spacer"></span><button type="button" class="btn primary qx-fin">Готово</button></div>`;
      host.querySelector('.qx-again').onclick = () => { d.stage = 'dump'; render(); };
      host.querySelector('.qx-fin').onclick = () => { d.stage = 'dump'; saveDump(d); ctx.close(); };
      return;
    }
    const [a, b2, c] = d.queue;
    const T = today();
    const load = weekLoad(state.weekStart);
    host.innerHTML = `<div class="qx qx-dump">${steps()}
      <div class="qx-deck">
        ${c ? `<div class="qx-card back2">${esc(c)}</div>` : ''}${b2 ? `<div class="qx-card back">${esc(b2)}</div>` : ''}
        <div class="qx-card top"><span class="qx-stamp l">ЗАВТРА</span><span class="qx-stamp r">СЕГОДНЯ</span><span class="qx-stamp u">БЕЗ ДАТЫ</span>
          <span class="qx-card-t">${esc(a)}</span><small>осталось ${d.queue.length}</small></div>
      </div>
      <div class="qx-dirs">
        <button type="button" data-go="tomorrow">← Завтра</button>
        <button type="button" data-go="nodate">↑ Без даты</button>
        <button type="button" data-go="today">Сегодня →</button>
      </div>
      <div class="qx-cap">Или на день недели — сейчас задач:</div>
      <div class="qx-load">${load.map((x, i) => `<button type="button" data-day="${x.ds}" class="${x.ds === T ? 'today' : ''}${hl === x.ds ? ' hl' : ''}${x.n >= 6 ? ' busy' : ''}">
        <span>${WEEKDAYS[i]} ${+x.ds.slice(8)}</span><b>${x.n}</b></button>`).join('')}</div>
    </div>
    <div class="qx-actions"><button type="button" class="btn qx-back">← К списку</button><span class="spacer"></span><button type="button" class="btn qx-skip">Пропустить</button></div>`;
    const top = host.querySelector('.qx-card.top');
    const stamps = top.querySelectorAll('.qx-stamp');
    async function place(ds, fx, fy) {
      top.style.transition = 'transform .28s ease, opacity .28s ease';
      top.style.transform = `translate(${fx}px, ${fy}px) rotate(${fx / 22}deg)`;
      top.style.opacity = '0';
      const title = d.queue.shift();
      if (ds) d.placed++; else d.nodate++;
      saveDump(d);
      await createTask({ title, days: ds ? { [ds]: 'todo' } : {}, priority: 2, type: 'task', tags: [] });
      done();
      setTimeout(() => render(ds || null), 240);
    }
    const go = w => {
      if (w === 'today') place(T, 420, 0);
      else if (w === 'tomorrow') place(addDays(T, 1), -420, 0);
      else place(null, 0, -380);
    };
    host.querySelector('.qx-dirs').onclick = e => { const btn = e.target.closest('[data-go]'); if (btn) go(btn.dataset.go); };
    host.querySelector('.qx-load').onclick = e => { const btn = e.target.closest('[data-day]'); if (btn) place(btn.dataset.day, 0, 260); };
    host.querySelector('.qx-skip').onclick = () => { d.queue.push(d.queue.shift()); render(); };
    host.querySelector('.qx-back').onclick = () => { d.text = d.queue.join('\n'); d.queue = []; d.stage = 'dump'; render(); };
    /* жест: карточка едет за пальцем */
    let sx = 0, sy = 0, dx = 0, dy = 0, drag = false;
    const loadBtns = host.querySelectorAll('.qx-load button');
    const hlDay = ds => loadBtns.forEach(x => x.classList.toggle('hl', x.dataset.day === ds));
    top.addEventListener('pointerdown', e => { drag = true; sx = e.clientX; sy = e.clientY; dx = dy = 0; top.setPointerCapture(e.pointerId); top.style.transition = 'none'; });
    top.addEventListener('pointermove', e => {
      if (!drag) return;
      dx = e.clientX - sx; dy = e.clientY - sy;
      top.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
      stamps[0].style.opacity = Math.max(0, -dx / 90);
      stamps[1].style.opacity = Math.max(0, dx / 90);
      stamps[2].style.opacity = Math.max(0, -dy / 90 - Math.abs(dx) / 120);
      hlDay(dx > 60 ? T : dx < -60 ? addDays(T, 1) : null);
    });
    const end = () => {
      if (!drag) return;
      drag = false;
      if (dx > 90) go('today');
      else if (dx < -90) go('tomorrow');
      else if (dy < -90) go('nodate');
      else { top.style.transition = 'transform .25s'; top.style.transform = ''; stamps.forEach(s => { s.style.opacity = 0; }); hlDay(null); }
    };
    top.addEventListener('pointerup', end);
    top.addEventListener('pointercancel', end);
  }
  render();
}

/* ══════════════ Настройки: «Ввод новой задачи» ══════════════ */
export function renderQuickSettings(el, onTry) {
  if (!el) return;
  const cur = quickStyle();
  el.innerHTML = `<p class="hint">Как выглядит панель, которая открывается по «＋» и клавише N. Выбор хранится на этом устройстве.</p>
    <div class="qs-opts">${QUICK_STYLES.map(s => `
      <div class="qs-opt${s.id === cur ? ' on' : ''}" data-qs="${s.id}" role="button" tabindex="0">
        <div class="qs-top"><span class="qs-ico">${s.icon}</span><b>${esc(s.label)}</b>${s.id === cur ? '<span class="vo-badge on">выбрано</span>' : ''}</div>
        <p class="qs-desc">${esc(s.desc)}</p>
        <ul class="qs-how">${s.how.map(h => `<li>${esc(h)}</li>`).join('')}</ul>
      </div>`).join('')}</div>
    <div class="auth-row"><button type="button" class="btn primary qs-try">Открыть панель</button></div>`;
  el.querySelectorAll('.qs-opt').forEach(o => {
    const pick = () => { setQuickStyle(o.dataset.qs); renderQuickSettings(el, onTry); };
    o.onclick = pick;
    o.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  });
  el.querySelector('.qs-try').onclick = () => onTry && onTry();
}
