import { state, visibleTasks, isDone, fmtD, esc, getTagColor, getTask } from './store.js';
import { openSheet } from './sheet.js';
import { openDay, closeCellMenu } from './week.js';

const $ = id => document.getElementById(id);

let lastQuery = '';

export function searchOpen() {
  const panel = $('searchPanel');
  return panel && panel.classList.contains('open');
}

export function openSearch() {
  const panel = $('searchPanel');
  if (!panel) return;
  panel.classList.add('open');
  const backdrop = $('backdrop');
  if (backdrop) backdrop.classList.add('open');
  const input = $('searchInput');
  if (input) {
    input.value = '';
    lastQuery = '';
    renderSearchResults();
    requestAnimationFrame(() => input.focus());
  }
}

export function closeSearch() {
  const panel = $('searchPanel');
  if (panel) panel.classList.remove('open');
  const backdrop = $('backdrop');
  if (backdrop && !document.querySelector('.sheet.open') && !document.querySelector('.drawer.open') && !document.querySelector('.editor.open') && !document.querySelector('.daypanel.open')) {
    backdrop.classList.remove('open');
  }
}

function renderSearchResults() {
  const list = $('searchList');
  const tagsWrap = $('searchTags');
  if (!list) return;

  const q = lastQuery.trim().toLowerCase();
  const allTasks = visibleTasks();

  // Собираем уникальные теги из результатов
  const matchedTasks = q
    ? allTasks.filter(t => {
        if ((t.title || '').toLowerCase().includes(q)) return true;
        if ((t.notes || '').toLowerCase().includes(q)) return true;
        if ((t.tags || []).some(tg => tg.toLowerCase().includes(q))) return true;
        return false;
      })
    : allTasks;

  // Теги
  if (tagsWrap) {
    const tagMap = new Map();
    for (const t of matchedTasks) {
      for (const tg of (t.tags || [])) {
        tagMap.set(tg, (tagMap.get(tg) || 0) + 1);
      }
    }
    const tags = [...tagMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    tagsWrap.innerHTML = tags.map(([tg, count]) => {
      const c = getTagColor(tg);
      return `<span class="tag-pill search-tag" data-tag="${esc(tg)}"${c ? ` style="--tc:${c}"` : ''}>${esc(tg)} · ${count}</span>`;
    }).join('');
    tagsWrap.querySelectorAll('.search-tag').forEach(el => {
      el.style.cursor = 'pointer';
      el.onclick = () => {
        const input = $('searchInput');
        if (!input) return;
        input.value = el.dataset.tag;
        lastQuery = input.value.toLowerCase();
        renderSearchResults();
      };
    });
  }

  // Результаты
  if (!matchedTasks.length) {
    list.innerHTML = `<p class="empty">${q ? 'Ничего не найдено' : 'Пока нет задач'}</p>`;
    return;
  }

  list.innerHTML = matchedTasks.slice(0, 50).map(t => {
    const days = Object.keys(t.days || {}).sort();
    const firstDay = days[0] ? fmtD(days[0]) : '';
    const done = isDone(t);
    return `
      <div class="s-row search-result${done ? ' st-done' : ''}" data-id="${esc(t.id)}">
        <div class="s-body">
          <div class="s-title">${esc(t.title)}</div>
          <div class="s-meta">
            ${firstDay ? `<span>📅 ${firstDay}</span>` : ''}
            ${(t.tags || []).slice(0, 3).map(tg => {
              const c = getTagColor(tg);
              return `<span class="tag-pill"${c ? ` style="--tc:${c}"` : ''}>${esc(tg)}</span>`;
            }).join('')}
          </div>
        </div>
        <span class="chev">›</span>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.search-result').forEach(el => {
    el.onclick = () => {
      const t = getTask(el.dataset.id);
      if (!t) return;
      closeSearch();
      closeCellMenu();
      const days = Object.keys(t.days || {}).sort();
      if (days.length) openDay(days[0]);
      setTimeout(() => openSheet(t), 100);
    };
  });
}

export function searchInit() {
  const input = $('searchInput');
  if (input) {
    input.addEventListener('input', e => {
      lastQuery = e.target.value.toLowerCase();
      renderSearchResults();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeSearch();
    });
  }
  const closeBtn = $('searchClose');
  if (closeBtn) closeBtn.onclick = closeSearch;
}
