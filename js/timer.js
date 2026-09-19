import { getTask, updateTask, hapticLight, setEntry, today, state } from './store.js';

const $ = id => document.getElementById(id);

/* Базовое название вкладки */
const BASE_TITLE = document.title;

let activeTimer = null; // { taskId, startedAt, pausedAt, accumulated }
let tickInterval = null;
let pomodoroCount = 0;
const POMODORO_WORK_MS = 30 * 60 * 1000; // помидор = 30 мин активного времени
const GRACE_MS = 5000;  // первые 5 секунд пилюля не сворачивается
const ANIM_MS = 580;    // длительность «шторки»
let pillRevealedAt = 0;

const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5l12 7-12 7z"/></svg>';

export const activeFor = taskId => activeTimer && activeTimer.taskId === taskId;
export const isPaused = () => !!(activeTimer && activeTimer.pausedAt);

const elapsedNow = () => activeTimer
  ? activeTimer.accumulated + ((activeTimer.pausedAt || Date.now()) - activeTimer.startedAt)
  : 0;

export function getActive() {
  if (!activeTimer) return null;
  return { taskId: activeTimer.taskId, elapsed: elapsedNow(), paused: isPaused() };
}

function fmtTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getPill() { return $('timerPill'); }
const isCollapsed = () => { const p = getPill(); return !!p && p.dataset.collapsed === '1'; };

/* ── Кнопка таймера над «+» ── */
function getTimerFab() { return document.getElementById('timerFab'); }
function ensureTimerFab() {
  let b = getTimerFab();
  if (b) return b;
  b = document.createElement('button');
  b.type = 'button';
  b.id = 'timerFab';
  b.className = 'timer-fab';
  b.title = 'Открыть пилюлю таймера';
  b.innerHTML = ICON_PLAY;
  b.onclick = e => { e.stopPropagation(); expandPill(); };
  (document.getElementById('app') || document.body).appendChild(b);
  return b;
}

function updatePillUI() {
  const pill = getPill();
  if (!pill) return;
  const fab = ensureTimerFab();
  if (!(state.widgets || []).includes('focus')) {
    pill.classList.remove('on', 'shut');
    pill.dataset.collapsed = '';
    fab.classList.remove('open');
    fab.style.display = 'none';
    document.title = BASE_TITLE;
    return;
  }
  if (!activeTimer) {
    pill.style.transition = 'none';
    pill.classList.remove('on', 'shut');
    pill.dataset.collapsed = '';
    void pill.offsetHeight;
    pill.style.transition = '';
    fab.classList.remove('open');
    fab.style.display = 'none';
    document.title = BASE_TITLE; // возвращаем название приложения
    return;
  }
  const task = getTask(activeTimer.taskId);
  if (!task) { stop(); return; }
  const elapsed = elapsedNow();
  const titleEl = pill.querySelector('.tp-title');
  const timeEl = pill.querySelector('.tp-time');
  const pomEl = pill.querySelector('.tp-pom');
  const pauseBtn = pill.querySelector('.tp-btn.pause');
  if (titleEl) titleEl.textContent = 'Фокус на: ' + task.title;
  if (timeEl) timeEl.textContent = fmtTime(elapsed);
  if (pomEl) pomEl.textContent = '';
  if (pauseBtn) {
    pauseBtn.innerHTML = isPaused() ? ICON_PLAY : ICON_PAUSE;
    pauseBtn.title = isPaused() ? 'Продолжить' : 'Пауза';
  }
  // Не разворачиваем пилюлю, пока она свёрнута в кнопку
  if (pill.dataset.collapsed !== '1' && !pill.classList.contains('on')) {
    pill.classList.add('on');
  }
  pill.classList.toggle('paused', isPaused());
  fab.style.display = '';
  // Таймер в заголовке вкладки
  document.title = (isPaused() ? '⏸ ' : '') + fmtTime(elapsed) + ' · Фокус';
}

function tick() {
  // Помидоры считаем только по активному (не паузному) времени
  const p = Math.floor(elapsedNow() / POMODORO_WORK_MS);
  if (p > pomodoroCount) {
    pomodoroCount = p;
    try { if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 100]); } catch (e) {}
  }
  updatePillUI();
  document.dispatchEvent(new CustomEvent('timer-changed'));
}

export function start(taskId) {
  if (!(state.widgets || []).includes('focus')) return;
  const task = getTask(taskId);
  if (!task) return;
  if (activeTimer && activeTimer.taskId !== taskId) stop();
  if (activeTimer && activeTimer.taskId === taskId) { stop(); return; }
  activeTimer = { taskId, startedAt: Date.now(), accumulated: 0, pausedAt: null };
  setEntry(taskId, today(), 'started'); // квадрат → «Начато»
  pomodoroCount = 0;
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(tick, 1000);
  // Пилюля разворачивается «шторкой», кнопка над «+» прячется
  pillRevealedAt = Date.now();
  const pill = getPill();
  if (pill) {
    pill.dataset.collapsed = '';
    pill.style.transition = 'none';
    pill.classList.add('on', 'shut');
    void pill.offsetHeight;
    pill.style.transition = '';
    requestAnimationFrame(() => pill.classList.remove('shut'));
  }
  const fab = getTimerFab();
  if (fab) fab.classList.remove('open');
  hapticLight();
  tick();
}

export function pause() {
  if (!activeTimer || activeTimer.pausedAt) return;
  activeTimer.pausedAt = Date.now();
  hapticLight();
  tick();
}

export function resume() {
  if (!activeTimer || !activeTimer.pausedAt) return;
  activeTimer.accumulated += activeTimer.pausedAt - activeTimer.startedAt;
  activeTimer.startedAt = Date.now();
  activeTimer.pausedAt = null;
  hapticLight();
  tick();
}

export async function stop() {
  if (!activeTimer) return;
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  const elapsed = elapsedNow();
  const elapsedMin = Math.round(elapsed / 60000);
  const task = getTask(activeTimer.taskId);
  if (task && elapsedMin >= 1) {
    const now = new Date();
    const started = new Date(now.getTime() - elapsed);
    const two = n => String(n).padStart(2, '0');
    const session = {
      date: today(),
      start: `${two(started.getHours())}:${two(started.getMinutes())}`,
      end: `${two(now.getHours())}:${two(now.getMinutes())}`,
      min: elapsedMin,
      at: now.toISOString(),   // чья правка свежее — таймера или ручная
    };
    const sessions = [...(task.sessions || []), session];
    await updateTask(task.id, { sessions, spentMin: (task.spentMin || 0) + elapsedMin });
    await setEntry(task.id, today(), 'done'); // квадрат → «Выполнено»
    /* Фактическое время сессии становится тайм-блоком задачи в дне:
       режим «День» показывает, как день прошёл, а не как планировался. */
    document.dispatchEvent(new CustomEvent('focus-session', {
      detail: { taskId: task.id, date: session.date, start: session.start, min: elapsedMin },
    }));
  }
  activeTimer = null;
  pomodoroCount = 0;
  updatePillUI();
  document.dispatchEvent(new CustomEvent('timer-changed'));
}

/* ── Шторка: пилюля ↔ кнопка над «+» (одновременно) ── */
export function collapsePill() {
  const pill = getPill();
  if (!pill || !activeTimer || pill.dataset.collapsed === '1') return;
  if (!pill.classList.contains('on')) return;
  const fab = ensureTimerFab();
  pill.classList.add('shut');  // пилюля: полукруглые края к центру
  fab.classList.add('open');   // кнопка: одновременно разворачивается
  setTimeout(() => {
    pill.style.transition = 'none'; // тихо прячем, без «обратной» анимации
    pill.classList.remove('on', 'shut');
    pill.dataset.collapsed = '1';
    void pill.offsetHeight;
    pill.style.transition = '';
  }, ANIM_MS);
}

export function expandPill() {
  const pill = getPill();
  if (!pill || !activeTimer) return;
  const fab = getTimerFab();
  if (fab) fab.classList.remove('open'); // кнопка сжимается
  pillRevealedAt = Date.now(); // новые 5 секунд неприкосновенности
  pill.dataset.collapsed = '';
  pill.style.transition = 'none';
  pill.classList.add('on', 'shut');
  void pill.offsetHeight;
  pill.style.transition = '';
  requestAnimationFrame(() => pill.classList.remove('shut')); // пилюля разворачивается
}

export function timerInit() {
  const pill = getPill();
  if (!pill) { console.warn('[timer] timerPill not found in DOM, timer disabled'); return; }
  const stopBtn = pill.querySelector('.tp-btn.stop');
  if (stopBtn) {
    stopBtn.onclick = e => { e.stopPropagation(); stop(); };
    if (!pill.querySelector('.tp-btn.pause')) {
      const pb = document.createElement('button');
      pb.type = 'button';
      pb.className = 'tp-btn pause';
      pb.title = 'Пауза';
      pb.innerHTML = ICON_PAUSE;
      pill.insertBefore(pb, stopBtn);
    }
  }
  const pauseBtn = pill.querySelector('.tp-btn.pause');
  if (pauseBtn) pauseBtn.onclick = e => { e.stopPropagation(); isPaused() ? resume() : pause(); };
  // Клик по пилюле — открыть задачу
  pill.onclick = () => {
    if (!activeTimer) return;
    const task = getTask(activeTimer.taskId);
    if (!task) return;
    import('./sheet.js').then(({ openSheet }) => openSheet(task));
  };
  ensureTimerFab();
  // Сворачиваем при любом тапе/клике, КРОМЕ пилюли и её кнопки, после 5 секунд
  document.addEventListener('pointerdown', e => {
    if (!activeTimer || isCollapsed()) return;
    if (Date.now() - pillRevealedAt < GRACE_MS) return;
    const t = e.target;
    if (t.closest && (t.closest('.tpill') || t.closest('#timerFab'))) return;
    collapsePill();
  }, { capture: true });
  // И при скролле ленты — тоже с задержкой 5 секунд
  const appEl = $('app');
  if (appEl) {
    appEl.addEventListener('scroll', () => {
      if (!activeTimer || isCollapsed()) return;
      if (Date.now() - pillRevealedAt < GRACE_MS) return;
      collapsePill();
    }, { passive: true });
  }
  document.addEventListener('sync-done', updatePillUI);
  document.addEventListener('user-change', updatePillUI);
}
