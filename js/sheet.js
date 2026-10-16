import {
  state, WEEKDAYS, addDays, today, iso, TYPE_LABEL, PRIORITY_LABEL,
  getTagsDict, getTagColor, addTagsToDict, createTask, updateTask, removeTask, getTask,
  addSubtask, toggleSubtask, delSubtask,
  esc, MONTHS, taskPlans, setTaskPlan, removeTaskPlan, hmToMin, minToHM,
} from './store.js';
import { attachFile, openTaskFile, removeTaskFile, fmtSize } from './files.js';
import { limitNote } from './attach.js';
import { quickStyle, renderQuickAlt } from './quick.js';
import { renderAll } from './week.js';
import { createCalDrum, calTitle } from './cal.js';
import * as tm from './timer.js';

const $ = id => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const sheet = $('sheet'), editor = $('editor'), daySheet = $('daySheet');
let editId = null;
let edDrum = null;
export const sheetOpen = () =>
  (sheet && sheet.classList.contains('open')) ||
  (editor && editor.classList.contains('open')) ||
  (daySheet && daySheet.classList.contains('open'));
export function refreshBackdrop() {
  const backdrop = $('backdrop');
  if (!backdrop) return;
  const anyOpen = document.querySelector('.sheet.open, .auth.open, .drawer.open, .editor.open, .searchpanel.open');
  backdrop.classList.toggle('open', !!anyOpen);
}
function mkChip(label, on, cls, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip' + (cls ? ' ' + cls : '') + (on ? ' on' : '');
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}
function growEl(el) { if (!el) return; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
export function openSheet(task) { if (task) openEditor(task); else openQuick(); }
export function closeSheet() {
  if (sheet) {
    sheet.classList.remove('open', 'drag');
    sheet.style.transform = '';
  }
  if (editor) editor.classList.remove('open');
  refreshBackdrop();
}
export function closeDay() {
  if (daySheet) {
    daySheet.classList.remove('open', 'drag');
    daySheet.style.transform = '';
  }
  refreshBackdrop();
}
function openQuick() {
  const alt = $('qAlt');
  editId = null;
  if (sheet) sheet.dataset.qs = quickStyle();
  renderQuickAlt(alt, { close: closeSheet, openEditor, rerender: renderAll });
  if (sheet) sheet.classList.add('open');
  refreshBackdrop();
}
/* Ввод в панели идёт через quick.js; Enter в поле не должен отправлять форму */
sheet?.addEventListener('submit', e => e.preventDefault());
/* ── Универсальный bindDrag для ЛЮБОГО sheet с grip ── */
function attachDragHandlers(sheetEl, gripEl, onClose) {
  if (!sheetEl || !gripEl) return;
  let startY = 0, dy = 0, activeDrag = false;
  gripEl.addEventListener('pointerdown', e => {
    activeDrag = true;
    dy = 0;
    startY = e.clientY;
    gripEl.setPointerCapture(e.pointerId);
    sheetEl.classList.add('drag');
    gripEl.classList.add('dragging');
  });
  gripEl.addEventListener('pointermove', e => {
    if (!activeDrag) return;
    dy = e.clientY - startY;
    if (dy > 0) {
      sheetEl.style.transform = `translate(-50%, ${dy}px)`;
    }
  });
  const finish = () => {
    if (!activeDrag) return;
    activeDrag = false;
    sheetEl.classList.remove('drag');
    gripEl.classList.remove('dragging');
    sheetEl.style.transform = '';
    if (dy > 120) onClose();
    dy = 0;
  };
  gripEl.addEventListener('pointerup', finish);
  gripEl.addEventListener('pointercancel', finish);
}
// Привязываем drag к sheet (быстрый ввод)
attachDragHandlers(sheet, $('sheetGrip'), closeSheet);
// Привязываем drag к daySheet (открыть день) — закрытие свайпом вниз
attachDragHandlers(daySheet, daySheet?.querySelector('.grip'), closeDay);
/* ── Композиция редактора (один раз при первом открытии):
   ряд 1: календарь 70% + приоритет 30%;
   тип — во всю ширину;
   ряд 2: таймер 50% + подзадачи 50%;
   теги, ссылки — во всю ширину;
   ряд 3: заметки 60% + файлы 40%. ── */
let editorLaidOut = false;
function ensureEditorLayout() {
  if (!editor || editorLaidOut) return;
  const scroll = editor.querySelector('.ed-scroll');
  if (!scroll) return;
  const cardWith = id => { const el = $(id); return el ? el.closest('.ed-card') : null; };
  const calCard = cardWith('edCal') || cardWith('edDays');
  const planCard = cardWith('edPlans');
  const prioCard = cardWith('edPrio');
  const timeCard = cardWith('edSessions');
  const subCard = cardWith('edSub');
  const notesCard = cardWith('edNotes');
  const filesCard = cardWith('edFiles');
  if (!calCard || !prioCard) return;
  const row1 = document.createElement('div');
  row1.className = 'ed-row ed-row-cal';
  scroll.insertBefore(row1, planCard || calCard);
  /* «Планирование» стоит слева от календаря */
  if (planCard) row1.appendChild(planCard);
  row1.appendChild(calCard);
  row1.appendChild(prioCard);
  if (timeCard && subCard) {
    const row2 = document.createElement('div');
    row2.className = 'ed-row ed-row-half';
    scroll.insertBefore(row2, timeCard);
    row2.appendChild(timeCard);
    row2.appendChild(subCard);
  }
  if (notesCard && filesCard) {
    const row3 = document.createElement('div');
    row3.className = 'ed-row ed-row-notes';
    scroll.insertBefore(row3, notesCard);
    row3.appendChild(notesCard);
    row3.appendChild(filesCard);
  }
  const h = calCard.querySelector('h4');
  if (h) h.textContent = 'Календарь';
  editorLaidOut = true;
}
function openEditor(task) {
  editId = task.id;
  const et = $('edTitle');
  if (et) { et.value = task.title; growEl(et); }
  const en = $('edNotes');
  if (en) { en.value = task.notes || ''; growEl(en); }
  ensureEditorLayout();
  renderEditor();
  if (editor) editor.classList.add('open');
  refreshBackdrop();
}
export function closeEditor() {
  if (editor) editor.classList.remove('open');
  refreshBackdrop();
  editId = null;
}
/* ── Блок «Планирование» ──
   Строка на каждый день: во сколько задача начинается и заканчивается
   в таймлайне. Автоматические строки (выведенные из завершённых
   сессий фокусировки) помечены и превращаются в ручные, как только их
   правят. Сессии разных дней дают разные строки — по одной на день. */
function renderEdPlans(t) {
  const box = $('edPlans');
  if (!box) return;
  const plans = taskPlans(t);
  const dayOpts = Object.keys(t.days || {}).sort();
  box.innerHTML = plans.length ? plans.map(p => `<div class="plan-row" data-date="${esc(p.date)}">
      <span class="plan-date">${+p.date.slice(8)} ${MONTHS[+p.date.slice(5, 7) - 1]}${p.auto ? '<i class="plan-auto" title="Из сессий фокусировки">авто</i>' : ''}</span>
      <input class="plan-t plan-s" type="time" step="300" value="${esc(p.start)}">
      <span class="plan-dash">–</span>
      <input class="plan-t plan-e" type="time" step="300" value="${esc(p.end || p.start)}">
      <button type="button" class="plan-del" title="Убрать строку">✕</button>
    </div>`).join('')
    : '<p class="plan-empty">Пока не запланирована. Добавьте строку или запустите таймер фокусировки — время подставится само.</p>';

  box.querySelectorAll('.plan-row').forEach(row => {
    const date = row.dataset.date;
    const commit = async () => {
      const s = row.querySelector('.plan-s').value || '09:00';
      let e = row.querySelector('.plan-e').value || s;
      if (hmToMin(e) <= hmToMin(s)) e = minToHM(hmToMin(s) + 30);
      await setTaskPlan(editId, date, s, e);
      renderEditor();
    };
    row.querySelector('.plan-s').onchange = commit;
    row.querySelector('.plan-e').onchange = commit;
    row.querySelector('.plan-del').onclick = async () => {
      await removeTaskPlan(editId, date);
      renderEditor();
    };
  });
  const add = $('edPlanAdd');
  if (add) add.onclick = async () => {
    const free = dayOpts.find(d => !plans.some(p => p.date === d)) || dayOpts[0] || today();
    await setTaskPlan(editId, free, '09:00', '10:00');
    renderEditor();
  };
}
function renderEditor() {
  const t = getTask(editId);
  if (!t) return;
  renderEdDays(t);
  renderEdPlans(t);
  renderEdPrio(t);
  renderEdType(t);
  renderEdSub(t);
  renderEdTime(t);
  renderEdTags(t);
  renderEdNotesLinks(t);
  renderEdFiles(t);
}
/* ── Календарь редактора: барабан как инлайн в липкой шапке,
   но без полосок под числами; выбранные дни подсвечены.
   ВАЖНО: #edCal в разметке приходит с hidden — снимаем его ДО постройки
   барабана, иначе месяцы измеряются нулевой высотой и календарь не виден. ── */
function renderEdDays(t) {
  const ec = $('edCal');
  if (!ec) return;
  ec.hidden = false;
  if (!edDrum) {
    ec.innerHTML =
      '<div class="cal-head"><span class="cal-title" title="К текущему месяцу"></span></div>' +
      '<div class="cal-m-week">' + ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((w, i) => `<span class="${i >= 5 ? 'we' : ''}">${w}</span>`).join('') + '</div>' +
      '<div class="ed-drum"></div>';
    edDrum = createCalDrum(ec.querySelector('.ed-drum'), {
      cellH: 28,
      week: false,
      markDay: d => (((getTask(editId) || {}).days || {})[d] ? 'on' : ''),
      onDay: d => {
        const task = getTask(editId);
        if (!task) return;
        const days = { ...(task.days || {}) };
        if (days[d]) delete days[d];
        else days[d] = 'todo';
        updateTask(editId, { days }).then(() => {
          edDrum.refresh();
          renderAll();
        });
      },
      onCenter: a => {
        const ti = ec.querySelector('.cal-title');
        if (ti) ti.textContent = calTitle(a);
      },
    });
    const ti = ec.querySelector('.cal-title');
    if (ti) {
      ti.textContent = calTitle(edDrum.currentMonth());
      ti.onclick = () => { edDrum.goCurrent(); edDrum.refresh(); };
    }
  } else {
    edDrum.refresh();
  }
}
function renderEdPrio(t) {
  const fp = $('edPrio');
  if (!fp) return;
  fp.innerHTML = '';
  for (const [v, l] of Object.entries(PRIORITY_LABEL)) {
    fp.appendChild(mkChip(l, t.priority === +v, 'pr' + v, async () => {
      await updateTask(editId, { priority: +v });
      renderEditor();
      renderAll();
    }));
  }
}
function renderEdType(t) {
  const e = $('edType');
  if (!e) return;
  e.innerHTML = '';
  for (const [v, l] of Object.entries(TYPE_LABEL)) {
    e.appendChild(mkChip(l, t.type === v, '', async () => {
      await updateTask(editId, { type: v });
      renderEditor();
      renderAll();
    }));
  }
}
function renderEdSub(t) {
  const box = $('edSub');
  if (!box) return;
  box.innerHTML = '';
  (t.subtasks || []).forEach(s => {
    const row = document.createElement('div');
    row.className = 'sub-row';
    const tog = document.createElement('button');
    tog.type = 'button';
    tog.className = 'cell sub ' + (s.done ? 'c-done' : 'c-todo');
    tog.title = s.done ? 'Выполнено' : 'Запланировано';
    tog.onclick = async () => {
      await toggleSubtask(t.id, s.id);
      renderEdSub(getTask(t.id));
      renderAll();
    };
    const nm = document.createElement('span');
    nm.className = 'sub-text' + (s.done ? ' done' : '');
    nm.textContent = s.text;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'sub-del';
    del.textContent = '✕';
    del.title = 'Удалить подзадачу';
    del.onclick = async () => {
      await delSubtask(t.id, s.id);
      renderEdSub(getTask(t.id));
      renderAll();
    };
    row.append(tog, nm, del);
    box.appendChild(row);
  });
}
async function edAddSub() {
  const inp = $('edSubInput');
  if (!inp) return;
  const v = inp.value.trim();
  if (!v) return;
  await addSubtask(editId, v);
  inp.value = '';
  const task = getTask(editId);
  if (task) renderEdSub(task);
  renderAll();
}
on('edSubAdd', 'click', edAddSub);
on('edSubInput', 'keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); edAddSub(); }
});
function renderEdTime(t) {
  const box = $('edSessions');
  if (!box) return;
  box.innerHTML = '';
  // Чип запуска/остановки таймера прямо в карточке
  const run = tm.activeFor(t.id);
  const chipRow = document.createElement('div');
  chipRow.className = 'chip-row';
  chipRow.appendChild(mkChip(run ? '⏹ Остановить таймер' : '▶ Таймер', run, '', async () => {
    if (tm.activeFor(t.id)) await tm.stop();
    else tm.start(t.id);
    renderEdTime(getTask(editId));
  }));
  box.appendChild(chipRow);
  const sess = t.sessions || [];
  if (sess.length) {
    let total = 0;
    sess.slice().reverse().forEach(s => {
      total += s.min || 0;
      const dm = `${s.date.slice(8, 10)}.${s.date.slice(5, 7)}`;
      const row = document.createElement('div');
      row.className = 'time-session';
      row.textContent = `${dm} с ${s.start} до ${s.end} (${s.min} мин)`;
      box.appendChild(row);
    });
    const tot = document.createElement('div');
    tot.className = 'time-total';
    tot.textContent = `Итого: ${total} мин`;
    box.appendChild(tot);
  } else {
    const dim = document.createElement('div');
    dim.className = 'time-session dim';
    dim.textContent = 'Нет завершённых таймеров';
    box.appendChild(dim);
  }
}
function renderEdTags(t) {
  const e = $('edTags');
  if (!e) return;
  e.innerHTML = '';
  (t.tags || []).forEach(name => {
    const c = getTagColor(name);
    const b = mkChip(name, true, 'tag', async () => {
      await updateTask(editId, { tags: (t.tags || []).filter(x => x !== name) });
      renderEditor();
      renderAll();
    });
    if (c) b.style.setProperty('--tc', c);
    e.appendChild(b);
  });
  getTagsDict().forEach(tg => {
    if ((t.tags || []).includes(tg.name)) return;
    const b = mkChip(tg.name, false, 'tag dim', async () => {
      await updateTask(editId, { tags: [...(t.tags || []), tg.name] });
      renderEditor();
      renderAll();
    });
    if (tg.color) b.style.setProperty('--tc', tg.color);
    e.appendChild(b);
  });
  const inp = $('edTagInput');
  if (!inp) return;
  inp.value = '';
  inp.onkeydown = async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = inp.value.trim();
    if (!v) return;
    await addTagsToDict([v]);
    await updateTask(editId, { tags: [...(t.tags || []), v] });
    renderEditor();
    renderAll();
  };
}
function renderEdNotesLinks(t) {
  const box = $('edLinks');
  if (!box) return;
  box.innerHTML = '';
  ((t.notes || '').match(/https?:\/\/[^\s]+/g) || []).forEach(u => {
    const a = document.createElement('a');
    a.className = 'chip link';
    a.href = u;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = u.replace(/^https?:\/\//, '').slice(0, 34);
    box.appendChild(a);
  });
}
let fileInput = null, uploading = false;
function getFileInput() {
  if (fileInput) return fileInput;
  fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.name = 'taskFile';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f || !editId) return;
    uploading = true;
    const task = getTask(editId);
    if (task) renderEdFiles(task);
    try { await attachFile(editId, f); }
    catch (err) { alert(err.message); }
    uploading = false;
    const t2 = getTask(editId);
    if (t2) renderEdFiles(t2);
    renderAll();
  });
  return fileInput;
}
function renderEdFiles(t) {
  const box = $('edFiles');
  if (!box) return;
  box.innerHTML = '';
  (t.files || []).forEach(f => {
    const row = document.createElement('div');
    row.className = 'file-line';
    const nm = document.createElement('span');
    nm.className = 'fl-name';
    nm.title = f.name;
    nm.textContent = `📎 ${f.name}`;
    const sz = document.createElement('i');
    sz.textContent = fmtSize(f.size || 0);
    nm.appendChild(sz);
    const openB = document.createElement('button');
    openB.type = 'button';
    openB.className = 'fl-btn';
    openB.textContent = 'Открыть';
    openB.onclick = () => openTaskFile(f).catch(err => alert('Не удалось открыть: ' + err.message));
    const delB = document.createElement('button');
    delB.type = 'button';
    delB.className = 'fl-btn del';
    delB.textContent = '✕';
    delB.title = 'Удалить файл';
    delB.onclick = async () => {
      try {
        await removeTaskFile(t.id, f.id);
        const t2 = getTask(t.id);
        if (t2) renderEdFiles(t2);
        renderAll();
      } catch (err) { alert('Не удалось удалить: ' + err.message); }
    };
    row.append(nm, openB, delB);
    box.appendChild(row);
  });
  if (uploading) {
    const up = document.createElement('div');
    up.className = 'file-uploading';
    up.innerHTML = '<span class="upload-spin"></span><span>Загрузка…</span>';
    box.appendChild(up);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'chip';
  add.textContent = '＋ Прикрепить файл';
  add.onclick = () => { if (!uploading) getFileInput().click(); };
  box.appendChild(add);
  const note = limitNote();
  if (note) {
    const hint = document.createElement('p');
    hint.className = 'file-limit';
    hint.textContent = '⚠ ' + note;
    box.appendChild(hint);
  }
}
on('edTitle', 'input', e => {
  if (editId) {
    updateTask(editId, { title: e.target.value });
    growEl(e.target);
  }
});
on('edNotes', 'input', e => {
  if (editId) {
    updateTask(editId, { notes: e.target.value });
    growEl(e.target);
    const t = getTask(editId);
    if (t) renderEdNotesLinks(t);
  }
});
on('edCancel', 'click', closeEditor);
on('edConfirm', 'click', async () => {
  const t = getTask(editId);
  if (!t) return;
  await updateTask(editId, {
    title: $('edTitle')?.value.trim() || t.title,
    notes: $('edNotes')?.value || ''
  });
  closeEditor();
  renderAll();
});
on('edDelete', 'click', async () => {
  if (editId && confirm('Удалить задачу?')) {
    await removeTask(editId);
    closeEditor();
    renderAll();
  }
});
