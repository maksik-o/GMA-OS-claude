import {
  init, state, addDays, today, MODES,
  getTagsDict, addTagsToDict, setTagColor, renameTag, deleteTag,
  loadModeColors, getModeColors, setModeColor, resetModeColor, resetModeColors,
  subscribe, getTimeAtmosphere, checkDayRollover,
  setModeLabel, resetModeLabel, resetAllModeLabels,
  rolloverDay, scheduleRollover,
} from './store.js';
import { renderAll, shiftWeek, goToday, dayOpen, openDay, closeDay, closeCellMenu, refreshRunning, blockSwap } from './week.js';
import { openSheet, closeSheet, sheetOpen, refreshBackdrop } from './sheet.js';
import { syncInit, syncNow, renderSyncPanel } from './vault.js';
import { searchInit, openSearch, closeSearch, searchOpen } from './search.js';
import { dbGetKV, dbSetKV } from './db.js';
import * as hk from './hotkeys.js';
import { timerInit } from './timer.js';
import { init as contactsInit, renderContactsView, contactsSubscribe, openNewPersonSheet } from './contacts.js';
import { init as notesInit } from './notes.js';
import { init as financeInit, renderFinanceView, financeSubscribe } from './finance.js';
import { init as kbInit, renderKbView, kbSubscribe, newKbNote } from './kb.js';
import { focusInit } from './focus.js';
import { widgetsInit, openWidgetsPanel } from './widgets.js';
import { renderHomeView, homeInit } from './home.js';
import { kanbanInit, toggleKanbanView, kanbanOpen, kanbanForceClose, renderKanban, currentBlock } from './kanban.js';

const $ = id => document.getElementById(id);

/* ── ТЕМЫ ──
   Тема меняет весь вид приложения: шрифт, материал и форму панелей,
   рамки, тени, кнопки, вкладки режимов, квадраты задач и палитру
   режимов. Вся оформительская часть — в css/themes.css по
   атрибуту data-theme; здесь только список и переключение.
   «Авто» следует светлой/тёмной теме iPhone. */
const THEMES = [
  { id: 'auto',   label: 'Авто', auto: true },
  { id: 'note',   label: 'Тетрадь', surf: 'light' },
  { id: 'brutal', label: 'Лего', surf: 'light' },
  { id: 'term',   label: 'Терминал', surf: 'dark' },
  { id: 'glass',  label: 'Стекло', surf: 'dark' },
  { id: 'swiss',  label: 'Швейцарский', surf: 'light' },
  { id: 'neon',   label: 'Неон', surf: 'dark' },
  { id: 'coral',  label: 'Коралл', surf: 'dark' },
];
/* Прежние темы → ближайшие новые */
const THEME_MIGRATE = {
  sky: 'swiss', winter: 'swiss', light: 'swiss', mist: 'swiss', mint: 'swiss', lavender: 'swiss',
  mountains: 'note', amber: 'note', paper: 'note', dawn: 'note', sand: 'note',
  waves: 'glass', ocean: 'glass', aurora: 'glass', forest: 'glass', midnight: 'glass', graphite: 'glass', dark: 'glass', nord: 'glass',
  sunset: 'neon', lava: 'neon', plum: 'neon', cherry: 'neon', oled: 'term',
};
const mqDark = matchMedia('(prefers-color-scheme: dark)');
const resolveTheme = id => {
  const t = THEMES.find(x => x.id === id) || THEMES[0];
  return t.auto ? THEMES.find(x => x.id === (mqDark.matches ? 'glass' : 'swiss')) : t;
};
/* Мини-экран темы для «Оформления»: рисуется переменными самой темы */
const themeMini = t => t.auto
  ? '<span class="tmini t-auto"><b>A</b></span>'
  : `<span class="tmini t-${t.id}"><span class="tm-title">Задачи</span>
      <span class="tm-card"><i class="tm-chip"></i><i class="tm-line"></i><i class="tm-line s"></i></span>
      <span class="tm-card"><span class="tm-sqs"><i class="d"></i><i class="d"></i><i class="s"></i><i></i></span></span></span>`;
const BG_GRADIENT_PRESETS = [
  { id: 'sunset-grad', c: 'linear-gradient(135deg,#ff6b6b,#feca57,#48dbfb)' },
  { id: 'ocean-grad', c: 'linear-gradient(135deg,#667eea,#764ba2)' },
  { id: 'forest-grad', c: 'linear-gradient(135deg,#134e5e,#71b280)' },
  { id: 'aurora-grad', c: 'linear-gradient(135deg,#a8edea,#fed6e3)' },
  { id: 'night-grad', c: 'linear-gradient(135deg,#0f2027,#203a43,#2c5364)' },
  { id: 'candy-grad', c: 'linear-gradient(135deg,#ff9a9e,#fecfef,#fecfef)' },
];
const BG_PRESETS = ['#eef2f7', '#f8e8d4', '#0b1220', '#04222e', '#221129', '#101c10'];
const FONTS = [{ id: 's', label: 'S' }, { id: 'm', label: 'M' }, { id: 'l', label: 'L' }];
const TAG_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#2563eb', '#8b5cf6', '#ec4899'];

let storedTheme = 'auto';
let storedBg = '';
let storedBgImage = '';
let storedBgOpacity = 1;      // яркость слоя фона: узор темы или своя картинка
/* Прозрачность панелей — своя у каждой темы: у «Стекла» панели
   полупрозрачные, у матовых тем плотные. Одно общее значение делало
   бы «Брутал» прозрачным после настройки «Стекла». */
let panelAlphaByTheme = {};
const PANEL_ALPHA_DEFAULT = { glass: 0.4, neon: 0.88 };
const panelAlphaFor = id => panelAlphaByTheme[id] ?? PANEL_ALPHA_DEFAULT[id] ?? 1;
let storedFont = 'm';

function applyPanelAlpha() {
  const v = panelAlphaFor(resolveTheme(storedTheme).id);
  const r = document.documentElement.style;
  r.setProperty('--panel-a', v);        // прозрачность панелей (css/themes.css)
  /* Блюр привязан к прозрачности, как было; у плотных панелей он не
     виден, поэтому его не считаем — меньше работы при прокрутке */
  r.setProperty('--panel-blur-k', v >= 0.99 ? 0 : v);
  const s = $('panelOpacitySlider');
  if (s) { s.min = 0.1; s.max = 1; s.step = 0.05; s.value = v; }
  const l = $('panelOpacityLabel');
  if (l) l.textContent = Math.round(v * 100) + '%';
}
async function setPanelAlpha(v) {
  panelAlphaByTheme[resolveTheme(storedTheme).id] = v;
  applyPanelAlpha();
  await dbSetKV('panelAlphaByTheme', panelAlphaByTheme);
}
function applyTheme() {
  const th = resolveTheme(storedTheme);
  const root = document.documentElement;
  root.dataset.theme = th.id;
  root.style.removeProperty('--tint');
  root.style.removeProperty('--bg-mesh');
  /* Свой цвет фона заменяет только подложку; панели и текст остаются
     от темы, поэтому surf (светлая/тёмная) всегда берём из темы. */
  if (storedBg) {
    root.style.setProperty('--bg', storedBg);
    root.style.setProperty('--bg-mesh', 'none');
  } else root.style.removeProperty('--bg');
  document.body.dataset.surf = th.surf;
  /* То же — в localStorage: скрипт в <head> поставит тему до первой
     отрисовки, и при запуске не мигает тема по умолчанию. */
  try { localStorage.setItem('rl_boot_theme', JSON.stringify({ id: th.id, surf: th.surf, bg: storedBg || '' })); } catch {}
  applyPanelAlpha();
  applyBgImage(); // тема ставит и обои
  requestAnimationFrame(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#000';
  });
}
function applyBgImage() {
  const img = storedBgImage;
  /* Относительный путь внутри var() Chrome разрешает относительно
     таблицы стилей (css/style.css), а не документа — отсюда были
     запросы вида css/images/sunset.jpg. Отдаём абсолютный URL. */
  let url = '';
  if (img) {
    try { url = /^(data:|blob:|https?:)/.test(img) ? img : new URL(img, document.baseURI).href; }
    catch { url = img; }
  }
  /* Своя картинка заменяет узор темы; без неё ползунок «Фон» меняет
     яркость узора (body::before в style.css) */
  const r = document.documentElement.style;
  if (url) r.setProperty('--bg-layer', `url("${url}") center / cover no-repeat`);
  else r.removeProperty('--bg-layer');
  r.setProperty('--bg-image-opacity', storedBgOpacity);
}
function applyFont() { document.body.dataset.font = storedFont; }
function updateTimeAtmosphere() {
  document.documentElement.style.setProperty('--time-atmosphere', getTimeAtmosphere());
}

function closeTagColorMenu() { const m = $('tagColorMenu'); if (m) m.classList.remove('open'); }
function openTagColorMenu(anchor, t) {
  const m = $('tagColorMenu');
  if (!m) return;
  m.innerHTML = '<div class="tc-row">' + TAG_COLORS.map(c => '<button type="button" class="tc-dot' + (t.color === c ? ' on' : '') + '" data-c="' + c + '" style="background:' + c + '" title="' + c + '"></button>').join('') + '</div><div class="tc-row"><input type="color" class="tc-input" id="tagColorPick" name="tagColorPick" autocomplete="off" value="' + (/^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '#ec4899') + '"><span class="tc-label">свой цвет</span></div>';
  m.classList.add('open');
  const r = anchor.getBoundingClientRect();
  const mw = 200;
  const mh = m.offsetHeight || 96;
  const x = Math.min(Math.max(8, r.left + r.width / 2 - mw / 2), innerWidth - mw - 8);
  let y = r.bottom + 8;
  if (y + mh > innerHeight - 8) y = r.top - mh - 8;
  m.style.left = x + 'px';
  m.style.top = Math.max(8, y) + 'px';
  m.querySelectorAll('.tc-dot').forEach(d => {
    d.onclick = async () => {
      await setTagColor(t.name, d.dataset.c);
      closeTagColorMenu();
      renderTagsPanel();
      renderCurrent();
    };
  });
  const ci = m.querySelector('.tc-input');
  if (ci) {
    ci.onchange = async e => {
      await setTagColor(t.name, e.target.value);
      closeTagColorMenu();
      renderTagsPanel();
      renderCurrent();
    };
  }
  setTimeout(() => {
    const close = e => {
      if (!m.contains(e.target) && !anchor.contains(e.target)) {
        closeTagColorMenu();
        document.removeEventListener('pointerdown', close);
      }
    };
    document.addEventListener('pointerdown', close);
  }, 0);
}
async function setBg(c) { storedBg = c; await dbSetKV('bg', c); applyTheme(); renderLookPanel(); }
async function setFont(id) {
  if (!FONTS.some(f => f.id === id)) return;
  storedFont = id;
  await dbSetKV('fontSize', id);
  applyFont();
  renderLookPanel();
}
async function handleBgImageUpload(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { alert('Выберите изображение'); return; }
  /* Фото с телефона весит мегабайты и целиком лежало бы в базе и в
     памяти как data:URL. Ужимаем до 2048 px по длинной стороне. */
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    storedBgImage = c.toDataURL('image/jpeg', 0.82);
  } catch { alert('Не удалось открыть изображение'); return; }
  finally { URL.revokeObjectURL(url); }
  if (storedBgOpacity < 0.2) storedBgOpacity = 1;
  await dbSetKV('bgImage', storedBgImage);
  await dbSetKV('bgLayerOpacity', storedBgOpacity);
  applyBgImage();
  renderLookPanel();
}
async function clearBgImage() {
  storedBgImage = '';
  await dbSetKV('bgImage', '');
  applyBgImage();
  renderLookPanel();
}
async function setBgOpacity(val) {
  storedBgOpacity = parseFloat(val);
  applyBgImage();
  await dbSetKV('bgLayerOpacity', storedBgOpacity);
  const label = $('bgOpacityLabel');
  if (label) label.textContent = Math.round(storedBgOpacity * 100) + '%';
}
/* ── Панель оформления: не перестраиваем скрытую, защита от повторного входа,
   кружки тем красим шорткатом background (цвет И градиент), обои — слоем сверху ── */
let _lookBusy = false;
function renderLookPanel() {
  const dt = $('drawerTheme');
  if (dt && dt.hidden) return; // панель не открыта — строить нечего
  if (_lookBusy) return;
  _lookBusy = true;
  try {
    const row = $('themeRow');
    if (row) {
      row.innerHTML = '';
      for (const t of THEMES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'theme-dot' + (t.id === storedTheme && !storedBg ? ' on' : '');
        b.title = t.label;
        b.innerHTML = themeMini(t) + `<span class="theme-name">${t.label}</span>`;
        b.onclick = async () => {
          storedTheme = t.id;
          storedBg = '';   // выбор темы снимает свой цвет фона
          await dbSetKV('theme', t.id);
          await dbSetKV('bg', '');
          applyTheme();
          renderLookPanel();
        };
        row.appendChild(b);
      }
    }
    const bgRow = $('bgRow');
    if (bgRow) {
      bgRow.innerHTML = '';
      for (const c of BG_PRESETS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bg-dot' + (storedBg === c ? ' on' : '');
        b.title = c;
        b.style.background = c;
        b.onclick = () => setBg(c);
        bgRow.appendChild(b);
      }
    }
    const bc = $('bgColor');
    if (bc) {
      bc.value = /^#[0-9a-f]{6}$/i.test(storedBg) ? storedBg : '#eef2f7';
      bc.onchange = e => setBg(e.target.value);
    }
    const br = $('bgReset');
    if (br) br.onclick = () => setBg('');
    const bgPresets = $('bgPresets');
    if (bgPresets) {
      bgPresets.innerHTML = '';
      for (const p of BG_GRADIENT_PRESETS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bg-preset' + (storedBg === p.c ? ' on' : '');
        b.style.background = p.c;
        b.onclick = () => setBg(p.c);
        bgPresets.appendChild(b);
      }
    }
    const bgUploadBtn = $('bgUploadBtn');
    const bgFileInput = $('bgFileInput');
    const bgClearBtn = $('bgClearBtn');
    const bgOpacitySlider = $('bgOpacitySlider');
    const bgOpacityLabel = $('bgOpacityLabel');
    if (bgUploadBtn && bgFileInput) {
      bgUploadBtn.onclick = () => bgFileInput.click();
      bgFileInput.onchange = e => {
        const file = e.target.files[0];
        if (file) handleBgImageUpload(file);
      };
    }
    if (bgClearBtn) {
      bgClearBtn.onclick = clearBgImage;
      bgClearBtn.disabled = !storedBgImage;
    }
    if (bgOpacitySlider) {
      bgOpacitySlider.min = 0;
      bgOpacitySlider.max = 1;
      bgOpacitySlider.value = storedBgOpacity;
      bgOpacitySlider.oninput = e => setBgOpacity(e.target.value);
    }
    if (bgOpacityLabel) {
      bgOpacityLabel.textContent = Math.round(storedBgOpacity * 100) + '%';
    }
    /* ── Ползунок прозрачности панелей (вставляется один раз) ── */
    const bgOpRow = document.querySelector('.bg-opacity-row');
    if (bgOpRow && !document.getElementById('panelOpacityRow')) {
      const prow = document.createElement('div');
      prow.className = 'bg-opacity-row';
      prow.id = 'panelOpacityRow';
      prow.innerHTML = '<span class="bg-opacity-label">Панели</span><input id="panelOpacitySlider" class="bg-opacity-slider" type="range" min="0.1" max="1" step="0.05"><span class="bg-opacity-label" id="panelOpacityLabel"></span>';
      bgOpRow.insertAdjacentElement('afterend', prow);
    }
    const pSlider = $('panelOpacitySlider');
    if (pSlider) pSlider.oninput = e => setPanelAlpha(parseFloat(e.target.value));
    applyPanelAlpha();
    /* ── Заголовок над ползунками: после строки загрузки ── */
    const uploadRow = document.querySelector('.bg-upload-row');
    if (uploadRow && !document.getElementById('blurHeading')) {
      const h = document.createElement('div');
      h.id = 'blurHeading';
      h.className = 'set-sub';
      h.textContent = 'Фон и панели';
      uploadRow.insertAdjacentElement('afterend', h);
    }
    /* ── Верхний ползунок как «Панели»: слева «Фон», справа % ── */
    const bgRowFirst = document.querySelector('.bg-opacity-row');
    if (bgRowFirst && !bgRowFirst.querySelector('.bg-left-label')) {
      const lab = document.createElement('span');
      lab.className = 'bg-opacity-label bg-left-label';
      lab.textContent = 'Фон';
      bgRowFirst.insertBefore(lab, bgRowFirst.firstChild);
    }
    const frow = $('fontRow');
    if (frow) {
      frow.innerHTML = '';
      for (const f of FONTS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'font-btn' + (f.id === storedFont ? ' on' : '') + ' ' + f.id;
        b.textContent = f.label;
        b.onclick = () => setFont(f.id);
        frow.appendChild(b);
      }
    }
    /* ── ЕДИНЫЙ БЛОК "Настройки режимов" (цвет + название) ── */
    const ms = $('modeSettings');
    if (ms) {
      ms.innerHTML = '';
      const colors = getModeColors();
      for (const m of MODES) {
        const rowEl = document.createElement('div');
        rowEl.className = 'mode-setting-row';
        const colorWrap = document.createElement('div');
        colorWrap.className = 'mode-color-wrap';
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'mode-color-input';
        colorInput.id = 'modeColor_' + m.id;
        colorInput.name = 'modeColor_' + m.id;
        colorInput.autocomplete = 'off';
        colorInput.value = colors[m.id] || '#888888';
        colorInput.title = 'Цвет режима';
        colorInput.onchange = async () => {
          await setModeColor(m.id, colorInput.value);
          renderLookPanel();
          renderCurrent();
        };
        colorWrap.appendChild(colorInput);
        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'mode-label-input';
        labelInput.id = 'modeLabel_' + m.id;
        labelInput.name = 'modeLabel_' + m.id;
        labelInput.autocomplete = 'off';
        labelInput.value = m.label;
        labelInput.maxLength = 30;
        labelInput.placeholder = 'Название';
        const commit = async () => {
          const v = labelInput.value.trim();
          if (v === m.label) return; // ничего не изменилось — не перерисовываем
          if (!v) await resetModeLabel(m.id);
          else await setModeLabel(m.id, v);
          renderLookPanel();
          renderCurrent();
        };
        labelInput.onblur = commit;
        labelInput.onkeydown = async e => {
          if (e.key === 'Enter') { e.preventDefault(); labelInput.blur(); }
          if (e.key === 'Escape') { labelInput.value = m.label; labelInput.blur(); }
        };
        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'mode-label-reset';
        resetBtn.title = 'Сбросить к умолчаниям';
        resetBtn.textContent = '↺';
        resetBtn.onclick = async () => {
          await resetModeLabel(m.id);
          await resetModeColor(m.id);
          renderLookPanel();
          renderCurrent();
        };
        rowEl.append(colorWrap, labelInput, resetBtn);
        ms.appendChild(rowEl);
      }
      const rstAll = document.createElement('button');
      rstAll.type = 'button';
      rstAll.className = 'btn';
      rstAll.textContent = 'Сбросить все режимы';
      rstAll.style.marginTop = '10px';
      rstAll.onclick = async () => {
        await resetAllModeLabels();
        await resetModeColors();
        renderLookPanel();
        renderCurrent();
      };
      ms.appendChild(rstAll);
    }
  } finally {
    _lookBusy = false;
  }
}
function renderTagsPanel() {
  const dict = getTagsDict();
  const box = $('tagsList');
  if (!box) return;
  box.innerHTML = '';
  if (!dict.length) box.innerHTML = '<p class="hint">Пока пусто. Добавь теги выше.</p>';
  for (const t of dict) {
    const row = document.createElement('div');
    row.className = 'tag-line';
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.textContent = t.name;
    pill.title = t.name;
    if (t.color) pill.style.setProperty('--tc', t.color);
    const pal = document.createElement('button');
    pal.type = 'button';
    pal.className = 'pal-btn';
    pal.title = 'Цвет тега';
    const dot = document.createElement('i');
    dot.style.background = t.color || 'conic-gradient(#ef4444,#f59e0b,#10b981,#2563eb,#8b5cf6,#ec4899,#ef4444)';
    pal.appendChild(dot);
    pal.onclick = () => openTagColorMenu(pal, t);
    const ren = document.createElement('button');
    ren.className = 'fl-btn';
    ren.textContent = '✎';
    ren.title = 'Переименовать';
    const del = document.createElement('button');
    del.className = 'fl-btn del';
    del.textContent = '✕';
    del.title = 'Удалить';
    ren.onclick = () => {
      const inp = document.createElement('input');
      inp.className = 'tag-rename';
      inp.id = 'tagRename_' + Math.random().toString(36).slice(2, 8);
      inp.name = 'tagRename';
      inp.autocomplete = 'off';
      inp.value = t.name;
      pill.replaceWith(inp);
      ren.remove();
      inp.focus();
      const commit = async () => {
        await renameTag(t.name, inp.value);
        renderTagsPanel();
        renderCurrent();
      };
      inp.onkeydown = e => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') renderTagsPanel();
      };
      inp.onblur = commit;
    };
    del.onclick = async () => {
      if (confirm('Удалить тег «' + t.name + '» из словаря и всех задач?')) {
        await deleteTag(t.name);
        renderTagsPanel();
        renderCurrent();
      }
    };
    row.append(pill, pal, ren, del);
    box.appendChild(row);
  }
}
const drawerOpen = () => { const d = $('drawer'); return d && d.classList.contains('open'); };
function setupDrawerGrip() {
  const drawer = $('drawer');
  const drawerMain = $('drawerMain');
  if (!drawer) return;
  if (!drawer.querySelector('.drawer-grip')) {
    const grip = document.createElement('div');
    grip.className = 'drawer-grip';
    drawer.appendChild(grip);
  }
  const grip = drawer.querySelector('.drawer-grip');
  if (!grip || grip._bound) return;
  grip._bound = true;
  let startX = 0, dx = 0, dragging = false;
  grip.addEventListener('pointerdown', e => {
    dragging = true;
    startX = e.clientX;
    dx = 0;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    drawer.classList.add('drag');
  });
  grip.addEventListener('pointermove', e => {
    if (!dragging) return;
    dx = Math.max(0, e.clientX - startX);
    drawer.style.transform = `translateX(${dx}px)`;
  });
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    grip.classList.remove('dragging');
    drawer.classList.remove('drag');
    drawer.style.transform = '';
    if (dx > 80) {
      if (drawerMain && drawerMain.hidden) showDrawerView('main');
      else closeDrawer();
    }
    dx = 0;
  };
  grip.addEventListener('pointerup', finish);
  grip.addEventListener('pointercancel', finish);
}
function showDrawerView(v) {
  const dm = $('drawerMain');
  const ds = $('drawerSync');
  const dt = $('drawerTheme');
  const dg = $('drawerTags');
  const dk = $('drawerKeys');
  if (dm) dm.hidden = v !== 'main';
  if (ds) ds.hidden = v !== 'sync';
  if (dt) dt.hidden = v !== 'theme';
  if (dg) dg.hidden = v !== 'tags';
  if (dk) dk.hidden = v !== 'keys';
  if (v === 'sync') renderSyncPanel($('syncPanel'));
  if (v === 'theme') renderLookPanel();
  if (v === 'tags') renderTagsPanel();
  if (v === 'keys') hk.renderKeysPanel($('keysRows'));
}
function openDrawer(view) {
  const d = $('drawer');
  if (!d) return;
  setupDrawerGrip();
  d.classList.add('open');
  refreshBackdrop();
  showDrawerView(view || 'main');
}
function closeDrawer() {
  const d = $('drawer');
  if (d) d.classList.remove('open');
  refreshBackdrop();
}
/* Свайп вправо закрывает шторку (во вложенном экране — возвращает в
   главное меню). Раньше жест ловился только по pointerup: на iPhone
   горизонтальное движение перехватывала прокрутка шторки, приходил
   pointercancel, и свайп не срабатывал. Теперь шторка разрешает
   браузеру только вертикальную прокрутку (touch-action: pan-y в CSS),
   едет за пальцем и закрывается по расстоянию или по скорости. */
(function bindDrawerSwipe() {
  const d = $('drawer');
  if (!d) return;
  let sx = 0, sy = 0, dx = 0, t0 = 0, mode = '', pid = null;
  d.addEventListener('pointerdown', e => {
    if (!d.classList.contains('open') || e.target.closest('input, textarea, select, .drawer-grip')) return;
    sx = e.clientX; sy = e.clientY; dx = 0; t0 = performance.now(); mode = ''; pid = e.pointerId;
  });
  d.addEventListener('pointermove', e => {
    if (e.pointerId !== pid) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!mode) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      mode = mx > 0 && Math.abs(mx) > Math.abs(my) * 1.2 ? 'x' : 'y';
      if (mode === 'x') {
        d.classList.add('drag');
        try { d.setPointerCapture(pid); } catch {}
      }
    }
    if (mode !== 'x') return;
    dx = Math.max(0, mx);
    d.style.transform = `translateX(${dx}px)`;
  });
  const end = e => {
    if (e.pointerId !== pid) return;
    pid = null;
    if (mode === 'x') {
      const fast = dx / Math.max(1, performance.now() - t0) > 0.5;   // быстрый взмах
      d.classList.remove('drag');
      d.style.transform = '';
      if (dx > Math.min(110, d.offsetWidth * 0.3) || (fast && dx > 30)) {
        const main = $('drawerMain');
        if (main && main.hidden) showDrawerView('main');
        else closeDrawer();
      }
    }
    mode = '';
  };
  d.addEventListener('pointerup', end);
  d.addEventListener('pointercancel', end);
})();
const VIEW_ORDER = ['home', 'week', 'contacts', 'finance', 'kb'];
function setView(v) {
  if (v === state.view) { applyView(v); return; }
  const dir = VIEW_ORDER.indexOf(v) >= VIEW_ORDER.indexOf(state.view) ? 1 : -1;
  blockSwap(dir, () => applyView(v));
}
function applyView(v) {
  /* Блоки недели (канбан и Timeline) живут вне #grid, поэтому сами по
     себе не прячутся — раньше при уходе из недели оставалось пустое
     место от таймлайна. */
  if (v !== 'week' && currentBlock() !== 'week') kanbanForceClose();
  state.view = v;
  const grid = $('grid');
  const cv = $('contactsView');
  const fv = $('financeView');
  const kv = $('kbView');
  const hv = $('homeView');
  const notesPanel = $('notesPanel');
  const focusPanel = $('focusPanel');
  const topbar = document.querySelector('.topbar');
  const week = v === 'week';
  /* Сетку Running-list показываем, только если в неделе выбран именно он:
     при открытых канбане или Timeline повторное «Задачи» поднимало
     вторую панель поверх доски. */
  if (grid) grid.hidden = !week || currentBlock() !== 'week';
  if (cv) cv.hidden = v !== 'contacts';
  if (fv) fv.hidden = v !== 'finance';
  if (kv) kv.hidden = v !== 'kb';
  if (hv) hv.hidden = v !== 'home';
  // Панели-виджеты живут только в режиме недели — включая календарь и финансы
  if (notesPanel) notesPanel.hidden = !week;
  if (focusPanel) focusPanel.hidden = !week;
  document.querySelectorAll('.dock-panel').forEach(p => { p.hidden = !week; });
  document.querySelectorAll('.dock').forEach(d => { d.hidden = !week; });
  if (topbar) {
    topbar.classList.toggle('contacts-active', v === 'contacts');
    topbar.classList.toggle('finance-active', v === 'finance');
    topbar.classList.toggle('kb-active', v === 'kb');
    topbar.classList.toggle('home-active', v === 'home');
  }
  const ab = $('addBtn');
  if (ab) ab.hidden = v === 'finance';
  document.querySelectorAll('#bottomNav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  const ct = $('ctBtn');
  if (ct) ct.classList.toggle('on', v === 'contacts');
  const fb = $('finBtn');
  if (fb) fb.classList.toggle('on', v === 'finance');
  const kbb = $('kbBtn');
  if (kbb) kbb.classList.toggle('on', v === 'kb');
  const tkb = $('tasksBtn');
  if (tkb) tkb.classList.toggle('on', v === 'week');
  const hb = $('homeBtn');
  if (hb) hb.classList.toggle('on', v === 'home');
  /* Режимы (Работа/Дом/Учёба) к финансам отношения не имеют —
     прячем их настройку, пока пользователь в этом режиме. */
  document.body.classList.toggle('view-finance', v === 'finance');
  /* Троеточие панели недели — общий элемент в body. Вне недели его
     не должно быть видно: иначе оно всплывает в углу шапки. */
  document.body.dataset.view = v;
  setTimeout(placeSyncAlert, 0);
  if (v === 'contacts' && cv) renderContactsView(cv, state.mode);
  else if (v === 'finance' && fv) renderFinanceView(fv);
  else if (v === 'kb' && kv) renderKbView(kv);
  else if (v === 'home' && hv) renderHomeView(hv);
  else renderAll();
  placeWeekNav();
}
function renderCurrent() {
  if (state.view === 'week') {
    renderAll();
    // Показываем панели в режиме недели
    const notesPanel = $('notesPanel');
    const focusPanel = $('focusPanel');
    if (notesPanel) notesPanel.hidden = false;
    if (focusPanel) focusPanel.hidden = false;
    if (kanbanOpen()) renderKanban(); // доска обновляется вместе с сеткой
  }
  else {
    const notesPanel = $('notesPanel');
    const focusPanel = $('focusPanel');
    if (notesPanel) notesPanel.hidden = true;
    if (focusPanel) focusPanel.hidden = true;
    document.querySelectorAll('.dock-panel').forEach(p => { p.hidden = true; });
    document.querySelectorAll('.dock').forEach(d => { d.hidden = true; });
    if (state.view === 'contacts') {
      const cv = $('contactsView');
      if (cv) renderContactsView(cv, state.mode);
    } else if (state.view === 'finance') {
      const fv = $('financeView');
      if (fv) renderFinanceView(fv);
    } else if (state.view === 'kb') {
      const kv = $('kbView');
      if (kv) renderKbView(kv);
    } else if (state.view === 'home') {
      renderHomeView($('homeView'));
    }
  }
}
/* ── Липкие шапки (неделя, канбан, финансы) ──
   Пока шапка стоит на своём месте, она прозрачная и сливается с
   карточкой — иначе выглядела «карточкой на карточке». Прилипнув к
   верху, становится плотной: полупрозрачная пропускала текст задач,
   и он читался прямо поверх дней недели. */
(function bindStuckHeads() {
  const app = $('app');
  if (!app) return;
  let raf = 0;
  const check = () => {
    raf = 0;
    const pad = parseFloat(getComputedStyle(app).paddingTop) || 0;
    document.querySelectorAll('.m-head, .l-head, .kb-head, .fin-head').forEach(h => {
      if (!h.offsetParent) return;
      const top = parseFloat(getComputedStyle(h).top);
      if (Number.isNaN(top)) return;
      h.classList.toggle('is-stuck', app.scrollTop > 0 && h.getBoundingClientRect().top <= top + pad + 0.5);
    });
  };
  const queue = () => { if (!raf) raf = requestAnimationFrame(check); };
  app.addEventListener('scroll', queue, { passive: true });
  document.addEventListener('grid-rendered', queue);
  addEventListener('resize', queue);
})();
(function bindPull() {
  const app = $('app');
  const ind = $('pullIndicator');
  if (!app || !ind) return;
  let startY = null, dist = 0;
  app.addEventListener('pointerdown', e => {
    if (app.scrollTop <= 0) { startY = e.clientY; dist = 0; }
  });
  app.addEventListener('pointermove', e => {
    if (startY == null) return;
    dist = Math.max(0, e.clientY - startY);
    if (dist > 12) {
      ind.classList.add('show');
      ind.style.transform = 'translate(-50%, ' + Math.min(46, dist * 0.4) + 'px)';
    }
  });
  const finish = () => {
    if (startY == null) return;
    const trigger = dist > 70;
    startY = null;
    if (trigger) {
      ind.classList.add('spin');
      ind.style.transform = 'translate(-50%, 46px)';
      Promise.resolve(syncNow(true)).finally(() => {
        setTimeout(() => {
          ind.classList.remove('show', 'spin');
          ind.style.transform = '';
        }, 500);
      });
    } else {
      ind.classList.remove('show', 'spin');
      ind.style.transform = '';
    }
    dist = 0;
  };
  app.addEventListener('pointerup', finish);
  app.addEventListener('pointercancel', finish);
})();
async function boot() {
  await init();
  await contactsInit();
  await notesInit();
  await financeInit();
  await kbInit();
  await focusInit();
  widgetsInit();
  homeInit();
  kanbanInit(); // троеточие видов + панель доски + жесты
  await loadModeColors();
  await hk.loadKeys();
  const t = await dbGetKV('theme');
  const tm = THEME_MIGRATE[t] || t;
  if (THEMES.some(x => x.id === tm)) storedTheme = tm;
  mqDark.addEventListener('change', () => { if (storedTheme === 'auto') applyTheme(); });
  storedBg = (await dbGetKV('bg')) || '';
  storedBgImage = (await dbGetKV('bgImage')) || '';
  const bo = parseFloat(await dbGetKV('bgLayerOpacity'));
  storedBgOpacity = Number.isFinite(bo) ? bo : 1;
  const pab = await dbGetKV('panelAlphaByTheme');
  if (pab && typeof pab === 'object') panelAlphaByTheme = pab;
  const f = await dbGetKV('fontSize');
  if (FONTS.some(x => x.id === f)) storedFont = f;
  applyTheme();
  applyFont();
  updateTimeAtmosphere();
  setInterval(updateTimeAtmosphere, 60000);
  setInterval(checkDayRollover, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkDayRollover();
  });
  addEventListener('load', () => window.scrollTo(0, 0));
  addEventListener('pageshow', () => window.scrollTo(0, 0));
  document.addEventListener('hotkeys-changed', renderCurrent);
  document.addEventListener('timer-changed', refreshRunning);
  document.addEventListener('sync-done', renderCurrent);
  document.addEventListener('mode-labels-changed', renderCurrent);
  contactsSubscribe(renderCurrent);
  /* Сутки могли смениться, пока приложение было закрыто или висело
     в фоне: догоняем перенос на старте и дальше ровно в полночь. */
  rolloverDay().then(n => { if (n) renderCurrent(); });
  scheduleRollover(n => { if (n) renderCurrent(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) rolloverDay().then(n => { if (n) renderCurrent(); });
  });
  document.addEventListener('go-view', e => setView(e.detail));
  document.addEventListener('render-now', renderCurrent);
  financeSubscribe(renderCurrent);
  kbSubscribe(renderCurrent);
  subscribe(renderCurrent);
  document.addEventListener('goto-week', e => {
    if (e.detail) {
      state.weekStart = e.detail;
      setView('week');
    }
  });
  bindNav();
  bindNavHide();
  searchAnchor = $('searchBtn') ? $('searchBtn').nextSibling : null;
  document.addEventListener('grid-rendered', placeWeekNav);
  if (mqMobile.addEventListener) mqMobile.addEventListener('change', placeWeekNav);
  bindKeys();
  bindSync();
  timerInit();
  searchInit();
  renderAll();
  syncInit();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
function moveDay(dir) { openDay(addDays(dayOpen() ? state.day : today(), dir)); }
function bindNav() {
  const prevWeek = $('prevWeek');
  const nextWeek = $('nextWeek');
  const weekLabel = $('weekLabel');
  if (prevWeek) prevWeek.onclick = () => shiftWeek(-1);
  if (nextWeek) nextWeek.onclick = () => shiftWeek(1);
  if (weekLabel) weekLabel.onclick = goToday;
  const ab = $('addBtn');
  if (ab) {
    ab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>';
    /* В контактах «+» заводит человека, в финансах у режима своя кнопка */
    ab.onclick = () => {
      if (state.view === 'contacts') openNewPersonSheet();
      else if (state.view === 'kb') newKbNote();
      else if (state.view !== 'finance') openSheet(null);
    };
  }
  const sb = $('searchBtn');
  if (sb) sb.onclick = openSearch;
  const ct = $('ctBtn');
  if (ct) ct.onclick = () => setView('contacts');
  const fb = $('finBtn');
  if (fb) fb.onclick = () => setView('finance');
  const kbb = $('kbBtn');
  if (kbb) kbb.onclick = () => setView('kb');
  const tkb = $('tasksBtn');
  if (tkb) tkb.onclick = () => setView('week');
  const hb = $('homeBtn');
  if (hb) hb.onclick = () => setView('home');
  const wb = $('widgetsBtn');
  if (wb) {
    wb.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    wb.onclick = e => openWidgetsPanel(wb);
  }
  enhanceToolbar();
  const st = $('settingsBtn');
  if (st) st.onclick = () => openDrawer('main');
  const sth = $('setThemes');
  if (sth) sth.onclick = () => showDrawerView('theme');
  const stg = $('setTags');
  if (stg) stg.onclick = () => showDrawerView('tags');
  const sts = $('setSync');
  if (sts) sts.onclick = () => showDrawerView('sync');
  const stk = $('setKeys');
  if (stk) stk.onclick = () => showDrawerView('keys');
  const sbk = $('syncBack');
  if (sbk) sbk.onclick = () => showDrawerView('main');
  const tbk = $('themeBack');
  if (tbk) tbk.onclick = () => showDrawerView('main');
  const tgk = $('tagsBack');
  if (tgk) tgk.onclick = () => showDrawerView('main');
  const kk = $('keysBack');
  if (kk) kk.onclick = () => showDrawerView('main');
  const tb = $('tagsBulk');
  const ta2 = $('tagsAdd');
  if (tb && ta2) {
    const growTa = () => { tb.style.height = 'auto'; tb.style.height = tb.scrollHeight + 'px'; };
    tb.addEventListener('input', growTa);
    growTa();
    const addTags = async () => {
      const names = tb.value.split(/[,;\n]/).map(s => s.trim().replace(/^#/, '')).filter(Boolean);
      if (!names.length) return;
      await addTagsToDict(names);
      tb.value = '';
      growTa();
      renderTagsPanel();
      renderCurrent();
    };
    ta2.onclick = addTags;
    tb.addEventListener('keydown', async e => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      await addTags();
    });
  }
  const backdrop = $('backdrop');
  if (backdrop) {
    backdrop.onclick = () => {
      closeSheet();
      closeSearch();
      closeTagColorMenu();
      closeDrawer();
      closeDay();
      closeCellMenu();
    };
  }
  document.querySelectorAll('#bottomNav button').forEach(b => {
    b.onclick = () => setView(b.dataset.view);
  });
}
function bindNavHide() {
  const app = $('app');
  const nav = $('bottomNav');
  if (!app || !nav) return;
  let t = null;
  app.addEventListener('scroll', () => {
    nav.classList.add('hid');
    clearTimeout(t);
    t = setTimeout(() => nav.classList.remove('hid'), 180);
  }, { passive: true });
}
/* ── ПК: блок недели и поиск в шапке задач; мобилка — топбар.
   Троеточие меню — ПЕРЕД заголовком панели (14px до заголовка). ── */
const mqMobile = matchMedia('(max-width: 720px)');
let navHost = null, searchHost = null, searchAnchor = null;
let navNodes = null;
function getNavNodes() {
  if (!navNodes) {
    navNodes = {
      prev: $('prevWeek'),
      wl: $('weekLabel'),
      next: $('nextWeek'),
      sb: $('searchBtn')
    };
  }
  return navNodes;
}
/* Троеточие-меню: ПК-неделя — перед «Running-list», ПК-канбан — перед
   «Kanban-доска», мобилка-неделя — перед заголовком липкой шапки (ставит
   week.js), мобилка-канбан — перед заголовком доски (ставит kanban.js).
   Если целевой заголовок ещё не построен — НЕ утаскиваем кнопку в топбар:
   её доставит ближайший grid-rendered / renderKanban / adjustMobileHead. */
function placeViewBtn() {
  const vb = $('viewBtn');
  if (!vb) return;
  /* Timeline — третий блок недели. Раньше он здесь не учитывался:
     kanbanOpen() для таймлайна ложно, и функция утаскивала троеточие
     обратно в шапку СКРЫТОГО Running-list — поэтому перед заголовком
     Timeline его никогда не было. */
  if (state.view === 'week' && currentBlock() === 'day') {
    const tt = $('tlTitle');
    if (tt && vb.nextSibling !== tt) tt.insertAdjacentElement('beforebegin', vb);
    return;
  }
  if (state.view === 'week') {
    if (kanbanOpen()) {
      const kt = $('kbBoardTitle');
      if (kt) {
        if (vb.nextSibling !== kt) kt.insertAdjacentElement('beforebegin', vb);
        return;
      }
      return;
    }
    if (!mqMobile.matches) {
      const title = $('grid') && $('grid').querySelector('.r-head .kb-board-title');
      if (title) {
        if (vb.nextSibling !== title) title.insertAdjacentElement('beforebegin', vb);
        return;
      }
      return;
    }
    const mt = $('grid') && $('grid').querySelector('.m-head .kb-board-title');
    if (mt) {
      if (vb.nextSibling !== mt) mt.insertAdjacentElement('beforebegin', vb);
      return;
    }
    return;
  }
  const sh = document.querySelector('.wn-right');
  if (sh && vb.parentNode !== sh) sh.appendChild(vb);
}
function placeWeekNav() {
  const n = getNavNodes();
  if (!n.wl) return;
  if (!navHost) navHost = document.querySelector('.wn-center');
  if (!searchHost) searchHost = document.querySelector('.wn-right');
  const kbOpen = kanbanOpen();
  const toPanel = !mqMobile.matches && state.view === 'week' && !kbOpen;
  if (toPanel) {
    const grid = $('grid');
    const rn = grid && grid.querySelector('.r-nav');
    const rs = grid && grid.querySelector('.r-search');
    if (rn && n.wl.parentNode !== rn) rn.append(n.prev, n.wl, n.next);
    if (rs && n.sb && n.sb.parentNode !== rs) rs.appendChild(n.sb);
  } else if (kbOpen && !mqMobile.matches) {
    const kp = $('kanbanPanel');
    const kr = kp && kp.querySelector('.kb-right');
    if (kr && n.sb && n.sb.parentNode !== kr) kr.appendChild(n.sb);
    if (navHost && n.wl.parentNode !== navHost) navHost.append(n.prev, n.wl, n.next);
  } else {
    /* Мобилка + неделя: селектор недели едет СРАЗУ в липкую шапку сетки.
       Промежуточная посадка в .wn-center раскрывала топбар на лишнюю строку —
       это и был «моргающий» кадр при листании недель и смене вида. */
    let host = navHost;
    if (mqMobile.matches && state.view === 'week' && !kbOpen) {
      const g = $('grid');
      const mHead = g && !g.hidden ? g.querySelector('.m-head-nav') : null;
      if (mHead) host = mHead;
    }
    if (host && n.wl.parentNode !== host) host.append(n.prev, n.wl, n.next);
    if (searchHost && n.sb && n.sb.parentNode !== searchHost) {
      if (searchAnchor && searchAnchor.parentNode === searchHost) searchHost.insertBefore(n.sb, searchAnchor);
      else searchHost.appendChild(n.sb);
    }
  }
  placeViewBtn();
}
function bindKeys() {
  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (typing) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (sheetOpen()) { if (e.key === 'Escape') closeSheet(); return; }
    if (searchOpen()) { if (e.key === 'Escape') closeSearch(); return; }
    if (drawerOpen()) { if (e.key === 'Escape') closeDrawer(); return; }
    if (dayOpen()) { if (e.key === 'Escape') closeDay(); return; }
    if (hk.matches(e, 'new')) { e.preventDefault(); openSheet(null); }
    else if (hk.matches(e, 'search')) { e.preventDefault(); openSearch(); }
    else if (hk.matches(e, 'today')) goToday();
    else if (hk.matches(e, 'weekPrev')) shiftWeek(-1);
    else if (hk.matches(e, 'weekNext')) shiftWeek(1);
    else if (hk.matches(e, 'dayPrev')) { e.preventDefault(); moveDay(-1); }
    else if (hk.matches(e, 'dayNext')) { e.preventDefault(); moveDay(1); }
    else if (hk.matches(e, 'kanban')) { e.preventDefault(); toggleKanbanView(); }
  });
}
function bindSync() {
  const btn = $('syncBtn');
  if (btn) btn.onclick = () => openDrawer('sync');
  document.addEventListener('sync-status', e => {
    if (btn) btn.dataset.state = e.detail;
    showSyncAlert(e.detail);
  });
}

/* ── Кнопки функций в шапке — тулбар в духе Figma ──
   Каждая кнопка = иконка + подпись. Подпись раскрывается у активной
   кнопки (открытый режим: база знаний, финансы, контакты) и при
   наведении мыши. Разметку не переписываем: оборачиваем то, что уже
   лежит в кнопке, чтобы не сломать точку статуса у облака и прочие
   вложенные элементы. */
const TB_LABELS = {
  widgetsBtn: 'Виджеты', searchBtn: 'Поиск', homeBtn: 'Главная', tasksBtn: 'Задачи', kbBtn: 'База знаний',
  finBtn: 'Финансы', ctBtn: 'Контакты', settingsBtn: 'Настройки', syncBtn: 'Синхронизация',
};
const TB_VIEWS = ['homeBtn', 'tasksBtn', 'kbBtn', 'finBtn', 'ctBtn'];
function enhanceToolbar() {
  document.querySelectorAll('.wn-right > button, #searchBtn').forEach(b => {
    if (b.dataset.tb) return;
    const label = TB_LABELS[b.id] || b.title || '';
    if (!label) return;
    b.dataset.tb = '1';
    b.classList.add('tb-btn');
    /* Раскрываться умеют только кнопки режимов приложения — ровно одна
       из них открыта всегда. Действия (виджеты, поиск, настройки,
       облако) остаются иконками. */
    if (TB_VIEWS.includes(b.id)) b.classList.add('tb-view');
    const svg = b.querySelector(':scope > svg');
    const ico = document.createElement('span');
    ico.className = 'tb-ico';
    if (svg) ico.appendChild(svg);
    const dot = b.querySelector(':scope > .dot');
    if (dot) ico.appendChild(dot);   // точка статуса остаётся на иконке
    b.insertBefore(ico, b.firstChild);
    const lab = document.createElement('span');
    lab.className = 'tb-lab';
    lab.innerHTML = '<span></span>';
    lab.firstChild.textContent = label;
    b.appendChild(lab);
    b.setAttribute('aria-label', label);
  });
}

/* ── Пилюля уведомлений о синхронизации ──
   Живёт ровно между кнопками режимов и кнопками функций; на телефоне
   всплывает над плавающей пилюлей переключения режимов. Показывается
   только когда есть о чём сказать: нет авторизации, нет сети,
   синхронизация не настроена или упала. */
const SYNC_MSG = {
  auth: 'Вы не авторизованы — синхронизация не идёт',
  offline: 'Нет сети — изменения сохранятся локально',
  perm: 'Разрешите доступ к файлу данных — нажмите, чтобы продолжить',
  off: 'Синхронизация не настроена',
  err: 'Ошибка синхронизации',
  error: 'Ошибка синхронизации',
  fail: 'Ошибка синхронизации',
};
/* Видимая кнопка «+». offsetParent у position: fixed всегда null,
   поэтому кнопку финансов раньше не находили, и плашка «не
   авторизованы» вставала прямо под неё. Смотрим на реальный размер. */
const shown = el => !!el && !el.hidden && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0;
function activeFab() {
  const fin = document.querySelector('.fin-fab');
  if (shown(fin)) return fin;
  const ab = $('addBtn');
  return shown(ab) ? ab : null;
}
/* «Не вошли» и «не настроено» — осознанный выбор, а не сбой: такую
   плашку можно закрыть, и она не вернётся, пока состояние то же.
   Сеть и ошибки показываем всегда — они временные. */
const SYNC_DISMISSABLE = ['auth', 'off'];
const SA_KEY = 'rl_sync_alert_hidden';
function showSyncAlert(stateName) {
  const el = $('syncAlert');
  if (!el) return;
  let msg = SYNC_MSG[stateName];
  let hiddenFor = '';
  try { hiddenFor = localStorage.getItem(SA_KEY) || ''; } catch {}
  if (hiddenFor && !msg) { try { localStorage.removeItem(SA_KEY); } catch {} }   // всё наладилось — в следующий раз покажем снова
  if (msg && SYNC_DISMISSABLE.includes(stateName) && hiddenFor === stateName) msg = '';
  el.hidden = !msg;
  const x = el.querySelector('.sa-x');
  if (x) {
    x.hidden = !SYNC_DISMISSABLE.includes(stateName);
    x.onclick = e => {
      e.stopPropagation();
      try { localStorage.setItem(SA_KEY, stateName); } catch {}
      el.classList.remove('on');
      setTimeout(() => { el.hidden = true; }, 250);
    };
  }
  if (!msg) { el.classList.remove('on'); return; }
  const t = el.querySelector('.sa-text');
  if (t) t.textContent = msg;
  el.dataset.state = stateName;
  placeSyncAlert();
  requestAnimationFrame(() => el.classList.add('on'));
  el.onclick = () => openDrawerSync();
}
/* На ПК пилюля выезжает из кнопки «+»: якорь — её правый край,
   поэтому анимация читается как «выехала из кнопки». На телефоне
   она встаёт отдельной строкой над шапкой и сдвигает контент вниз
   (это делает CSS, здесь координаты не нужны). */
function placeSyncAlert() {
  const el = $('syncAlert');
  if (!el || el.hidden) return;
  if (mqMobile.matches) { el.style.left = el.style.top = el.style.right = ''; return; }
  const fab = activeFab();
  if (!fab) { el.style.right = '24px'; el.style.bottom = '24px'; el.style.top = 'auto'; el.style.left = 'auto'; return; }
  const r = fab.getBoundingClientRect();
  el.style.left = 'auto';
  el.style.top = 'auto';
  el.style.right = Math.max(12, innerWidth - r.left + 10) + 'px';
  el.style.bottom = Math.max(12, innerHeight - r.bottom) + 'px';
}
addEventListener('resize', placeSyncAlert);
function openDrawerSync() {
  const sb = $('syncBtn');
  if (sb) sb.click();
}
boot();
