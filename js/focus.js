import { state, today, fmtMin, createTask, getTask } from './store.js';
import * as tm from './timer.js';

const $ = id => document.getElementById(id);

/* ── Кольцо: 65% окружности, разрыв внизу ── */
const R = 94;
const C = 2 * Math.PI * R;
const ARC = 0.65 * C;
const ARC_START = 153;   // угол начала дуги (разрыв внизу)
const ARC_SPAN = 234;    // 65% от 360°
const CYCLE_MS = 30 * 60 * 1000;

let choosing = false;
let _lastPoms = -1;
/* Панель фокусировки живёт в двух местах: в доке экрана задач
   (#focusPanel) и карточкой на «Главной» (.hm-fp). Таймер и выбор
   задачи у них общие; молния (один канвас и одно видео) переезжает
   в ту панель, что сейчас на экране. */
const hosts = () => [$('focusPanel'), ...document.querySelectorAll('#homeView .hm-fp')].filter(Boolean);
const shownHost = () => hosts().find(p => p.clientWidth > 0) || null;

const ICON_PLAY_S = '<svg viewBox="0 0 24 24"><path d="M8 5l12 7-12 7z"/></svg>';
const ICON_PAUSE_S = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const ICON_STOP_S = '<svg viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>';
const HANDLE_PATH = 'M2 22 A20 20 0 0 1 22 2';
const handleSVG = dock => `<svg class="dock-handle" data-dock="${dock}" viewBox="0 0 32 32" aria-hidden="true"><path d="${HANDLE_PATH}" pathLength="100" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`;

/* ── Риски по дуге (каждая минута, крупные каждые 5) ── */
function tickMarks() {
  let s = '<g>';
  for (let m = 0; m <= 30; m++) {
    const a = (ARC_START + ARC_SPAN * (m / 30)) * Math.PI / 180;
    const major = m % 5 === 0;
    const r1 = major ? 75 : 79, r2 = 85;
    s += '<line class="fp-tick' + (major ? ' major' : '') + '" x1="' + (100 + r1 * Math.cos(a)).toFixed(2) +
      '" y1="' + (100 + r1 * Math.sin(a)).toFixed(2) +
      '" x2="' + (100 + r2 * Math.cos(a)).toFixed(2) +
      '" y2="' + (100 + r2 * Math.sin(a)).toFixed(2) + '"/>';
  }
  return s + '</g>';
}

/* ── Подписи шкалы ПОД концами полукольца: «0 мин» слева, «⚡ 30 мин» справа ── */
function scaleLabels() {
  return '<text class="fp-scale" x="2" y="172" text-anchor="start">0 мин</text>' +
    '<text class="fp-scale" x="198" y="172" text-anchor="end">⚡ 30 мин</text>';
}

/* ── Шаровая молния: хромокей + перекраска в цвет режима + радиальный блюр ── */
/* 480×360, 24 к/с, кадр 4:3 из центра исходника. H.264 (~260 КБ) — для
   Safari и Chrome; WebM/VP9 — запасной для браузеров без H.264 */
const FX_SRC = document.createElement('video').canPlayType('video/mp4; codecs="avc1.4D401E"')
  ? 'videos/lightning-v2.mp4' : 'videos/lightning-v2.webm';
const FX_BLUR_PX = 3;    // максимум блюра в центре панели (7 размазывал ореол)
const FX_DIM = 0.75;     // приглушение яркости молнии
let _fxVideo = null, _fxCanvas = null, _fxOn = false, _fxRaf = 0, _fxVfc = 0;
let _fxUrl = null, _fxFetch = null, _fxW = 0, _fxH = 0;
let _gl = null, _glTex = null;
let _uRes = null, _uVid = null, _uAccent = null;
let _accentRGB = [0.86, 0.15, 0.15];

function hexToRgb01(hex) {
  const n = (hex || '').trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(n)) return [0.86, 0.15, 0.15];
  return [parseInt(n.slice(0, 2), 16) / 255, parseInt(n.slice(2, 4), 16) / 255, parseInt(n.slice(4, 6), 16) / 255];
}
let _accentMode = '';
function refreshAccent() {
  if (_accentMode === state.mode) return;   // getComputedStyle — только при смене режима
  _accentMode = state.mode;
  const cs = getComputedStyle(document.documentElement);
  _accentRGB = hexToRgb01(cs.getPropertyValue('--mode-' + (state.mode || 'work')));
}
document.addEventListener('mode-colors-changed', () => { _accentMode = ''; });

/* ── Ролик молнии: заранее и целиком ──
   Раньше видео начинало качаться в момент нажатия «Старт», и первые
   секунды браузер одновременно тянул сеть, декодировал и перерисовывал
   экран. Теперь ролик (он маленький) забирается целиком в фоне вскоре
   после запуска приложения — из кэша service worker, офлайн тоже —
   и отдаётся видео как blob: без Range-запросов и подгрузки по ходу. */
function fetchFx() {
  if (_fxUrl) return Promise.resolve(_fxUrl);
  if (!_fxFetch) {
    _fxFetch = fetch(FX_SRC)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(b => (_fxUrl = URL.createObjectURL(b)))
      .catch(e => { _fxFetch = null; console.warn('[focus] видео молнии не загрузилось:', e); return null; });
  }
  return _fxFetch;
}
function ensureFx() {
  if (_fxCanvas) return _fxCanvas;
  _fxCanvas = document.createElement('canvas');
  _fxCanvas.className = 'fp-video';
  placeFx();
  /* Размер канваса — от наблюдателя, а не чтением clientWidth в каждом кадре */
  new ResizeObserver(([e]) => {
    _fxW = Math.round(e.contentRect.width);
    _fxH = Math.round(e.contentRect.height);
  }).observe(_fxCanvas);
  return _fxCanvas;
}
/* Канвас молнии — под содержимое видимой панели */
function placeFx() {
  const p = shownHost() || $('focusPanel');
  if (_fxCanvas && p && _fxCanvas.parentNode !== p) p.insertBefore(_fxCanvas, p.firstChild);
}
/* Видео-элемент готовим заранее (первый кадр уже декодирован) */
async function prepareVideo() {
  if (_fxVideo) return _fxVideo;
  const url = await fetchFx();
  if (!url || _fxVideo) return _fxVideo;
  const v = document.createElement('video');
  v.muted = true;
  v.loop = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.preload = 'auto';
  v.src = url;
  _fxVideo = v;
  v.addEventListener('loadeddata', () => { if (_fxOn) startFxLoop(); }, { once: true });
  v.load();
  return v;
}
function initGL() {
  if (_gl) return true;
  if (!_fxCanvas) return false;
  const gl = _fxCanvas.getContext('webgl', { premultipliedAlpha: false, alpha: true });
  if (!gl) { console.warn('[focus] WebGL недоступен — молния отключена'); return false; }
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, 'attribute vec2 p;varying vec2 uv;void main(){uv=p*0.5+0.5;gl_Position=vec4(p,0.0,1.0);}');
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs,
    'precision mediump float;varying vec2 uv;' +
    'uniform sampler2D t;uniform vec2 uRes;uniform vec2 uVid;uniform vec3 uAccent;' +
    `const float uBlur=${FX_BLUR_PX.toFixed(1)};const float uDim=${FX_DIM.toFixed(2)};` +
    'void main(){' +
    /* Кадрирование «cover»: видео 16:9 раньше растягивалось на почти
       квадратную панель, и молнии, идущие во всю ширину кадра, упирались
       в оба края. Берём центральную часть кадра без искажения. */
    'float ca=uRes.x/uRes.y,va=uVid.x/max(uVid.y,1.0);' +
    'vec2 st=uv-0.5;if(va>ca)st.x*=ca/va;else st.y*=va/ca;st*=0.82;' +
    'vec2 tuv=st+0.5;' +
    /* радиальный блюр: максимум в центре, к краям — 0 */
    'float d=length(uv-0.5)*2.0;float w=clamp(1.0-d,0.0,1.0);w=w*w;float r=uBlur*w;' +
    'vec4 acc=texture2D(t,tuv);' +
    'for(int i=0;i<8;i++){float a=6.2831853*float(i)/8.0;vec2 off=vec2(cos(a),sin(a))*(r/uRes);acc+=texture2D(t,tuv+off);}' +
    'acc/=9.0;' +
    /* Ключ по «незелёной» яркости. Старый ключ смотрел на избыток
       зелёного и промахивался дважды: тёмная зелёная виньетка по краям
       кадра не вырезалась (грязная растушёвка), а бирюзовый ореол вокруг
       молний не считался фоном и растекался широкой полосой. У фона
       красный и синий почти нулевые при любой яркости зелёного — по ним
       и режем. */
    'float fg=max(acc.r,acc.b);' +
    'float al=smoothstep(0.30,0.80,fg);' +
    /* Мягкая эллиптическая маска: хвосты гаснут, не доходя до краёв */
    'float edge=1.0-smoothstep(0.38,0.95,length((uv-0.5)*vec2(2.25,2.0)));' +
    /* перекраска: свечение — цветом режима, ядро — белым */
    'float lum=dot(acc.rgb,vec3(0.299,0.587,0.114));' +
    'vec3 col=mix(uAccent,vec3(1.0),smoothstep(0.55,0.95,lum));' +
    'gl_FragColor=vec4(col,al*edge*uDim);}');
  gl.compileShader(fs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS) || !gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    console.warn('[focus] ошибка компиляции шейдера:', gl.getShaderInfoLog(fs));
    return false;
  }
  const pr = gl.createProgram();
  gl.attachShader(pr, vs);
  gl.attachShader(pr, fs);
  gl.linkProgram(pr);
  gl.useProgram(pr);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  _glTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, _glTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  _uRes = gl.getUniformLocation(pr, 'uRes');
  _uVid = gl.getUniformLocation(pr, 'uVid');
  _uAccent = gl.getUniformLocation(pr, 'uAccent');
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.clearColor(0, 0, 0, 0);
  _gl = gl;
  return true;
}
/* Кадр рисуется, только когда у видео появился новый кадр (24 в
   секунду), а не на каждом обновлении экрана — на 120-герцовом
   iPhone это в пять раз меньше работы. Где requestVideoFrameCallback
   нет, рисуем в rAF, пропуская кадры, если видео не сдвинулось. */
let _lastT = -1;
function drawFx() {
  const v = _fxVideo, gl = _gl;
  if (!v || !gl || v.readyState < 2) return;
  const w = _fxW, h = _fxH;
  if (!w || !h) return;
  if (_fxCanvas.width !== w || _fxCanvas.height !== h) {
    _fxCanvas.width = w;
    _fxCanvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(_uRes, w, h);
    gl.uniform2f(_uVid, v.videoWidth || 4, v.videoHeight || 3);
  }
  gl.uniform3f(_uAccent, _accentRGB[0], _accentRGB[1], _accentRGB[2]);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
function fxFrame() {
  if (!_fxOn) return;
  drawFx();
  _fxVfc = _fxVideo.requestVideoFrameCallback(fxFrame);
}
function fxTick() {
  if (!_fxOn) return;
  const v = _fxVideo;
  if (v && !v.paused && v.currentTime !== _lastT) { _lastT = v.currentTime; drawFx(); }
  _fxRaf = requestAnimationFrame(fxTick);
}
function startFxLoop() {
  if (!_fxOn || !_fxVideo || _fxVideo.readyState < 2 || !initGL()) return;
  stopFxLoop();
  _fxCanvas.width = 0;   // заставит drawFx выставить размер и uniform-ы
  const v = _fxVideo;
  v.play().catch(() => {});
  if (v.requestVideoFrameCallback) _fxVfc = v.requestVideoFrameCallback(fxFrame);
  else _fxRaf = requestAnimationFrame(fxTick);
  _fxCanvas.classList.add('on');
}
function stopFxLoop() {
  cancelAnimationFrame(_fxRaf);
  if (_fxVfc && _fxVideo && _fxVideo.cancelVideoFrameCallback) _fxVideo.cancelVideoFrameCallback(_fxVfc);
  _fxRaf = _fxVfc = 0;
}
function setFx(on) {
  if (on && !shownHost()) on = false; // ни одной панели на экране — не крутим
  if (on && _fxCanvas) placeFx();
  if (on === _fxOn) return;
  _fxOn = on;
  if (on) {
    if (!ensureFx()) return;
    if (_fxVideo && _fxVideo.readyState >= 2) startFxLoop();
    else prepareVideo();   // запустится по loadeddata
  } else {
    stopFxLoop();
    if (_fxVideo) { _fxVideo.pause(); _fxVideo.currentTime = 0; }
    if (_gl) _gl.clear(_gl.COLOR_BUFFER_BIT);
    if (_fxCanvas) _fxCanvas.classList.remove('on');
  }
}

/* ── Данные фокусировки ── */
function todayFocusMs() {
  const t0 = today();
  let ms = 0;
  for (const t of state.tasks) {
    for (const s of (t.sessions || [])) {
      if (s.date === t0) ms += (s.min || 0) * 60000;
    }
  }
  const act = tm.getActive();
  if (act) ms += act.elapsed;
  return ms;
}
export function tryChoose(taskId) {
  if (!choosing) return false;
  const task = getTask(taskId);
  const elig = task && Object.values(task.days || {}).some(s => s === 'todo' || s === 'started');
  if (elig) {
    exitChoosing();
    tm.start(taskId);
  }
  return true;
}
function cancelOnOutside(e) {
  if (e.target.closest('.r-row, .task, .focus-panel, .hm-row, .hm-ev, .hm-chip')) return;
  exitChoosing();
}
/* Выбор задачи: в неделе мигают строки сетки, на «Главной» — строки «Сегодня» */
const choosers = () => [$('grid'), $('homeView')].filter(Boolean);
export const isChoosing = () => choosing;
export function enterChoosing() {
  if (choosing || tm.getActive()) return;
  choosing = true;
  choosers().forEach(el => el.classList.add('focus-choosing'));
  updateFocusUI();
  setTimeout(() => document.addEventListener('pointerdown', cancelOnOutside), 0);
}
function exitChoosing() {
  choosing = false;
  choosers().forEach(el => el.classList.remove('focus-choosing'));
  document.removeEventListener('pointerdown', cancelOnOutside);
  updateFocusUI();
}
async function startWithoutTask() {
  exitChoosing();
  const t = await createTask({ title: 'Фокусировка', days: { [today()]: 'todo' } });
  tm.start(t.id);
}

/* ── Рендер панели ── */
function buildPanel(panel, dock) {
  if (!panel || panel._fpBuilt) return;
  panel._fpBuilt = true;
  panel._mode = '';
  panel.innerHTML = `${dock ? handleSVG('focus') : ''}
<div class="fp-poms"></div>
<div class="fp-ring-wrap">
<svg class="fp-ring" viewBox="0 0 200 200">
${tickMarks()}
${scaleLabels()}
<circle class="fp-track" cx="100" cy="100" r="${R}" transform="rotate(${ARC_START} 100 100)"/>
<circle class="fp-fill" cx="100" cy="100" r="${R}" transform="rotate(${ARC_START} 100 100)"/>
</svg>
<div class="fp-center"></div>
<div class="fp-controls">
<button type="button" class="fp-pause icon-btn" title="Пауза"></button>
<button type="button" class="fp-stop icon-btn" title="Стоп">${ICON_STOP_S}</button>
</div>
</div>
<div class="fp-total"></div>`;
  panel.querySelector('.fp-track').style.strokeDasharray = `${ARC} ${C}`;
  panel.querySelector('.fp-stop').onclick = () => tm.stop();
  panel.querySelector('.fp-pause').onclick = () => (tm.isPaused() ? tm.resume() : tm.pause());
}
function renderCenter(panel) {
  const center = panel.querySelector('.fp-center');
  if (!center) return;
  const act = tm.getActive();
  panel._mode = choosing ? 'choose' : act ? 'run' : 'idle';
  if (panel._mode === 'idle') {
    center.innerHTML = `<div class="fp-caption">Фокусировка</div><button type="button" class="fp-play" title="Запустить фокус"><svg viewBox="0 0 24 24"><path d="M8 5l12 7-12 7z"/></svg></button>`;
    center.querySelector('.fp-play').onclick = enterChoosing;
  } else if (panel._mode === 'choose') {
    center.innerHTML = `<div class="fp-choose">Фокусировка на:<br><span class="blink">Выберите задачу</span></div>
<button type="button" class="fp-notask chip">Без задачи</button>`;
    center.querySelector('.fp-notask').onclick = startWithoutTask;
  } else {
    center.innerHTML = `<div class="fp-time">00:00</div>`;
  }
}
/* Карточка «Главной» пересобирается вместе с экраном — панель в ней
   строится заново и сразу получает текущее состояние */
export function mountFocus(el) {
  buildPanel(el, false);
  updateFocusUI();
}
function updateFocusUI() {
  const list = hosts();
  if (!list.length) return;
  const act = tm.getActive();
  const needMode = choosing ? 'choose' : act ? 'run' : 'idle';
  /* цвет молнии = цвет текущего режима (обновляем при смене режима) */
  refreshAccent();
  setFx(!!act);
  /* Видео синхронно с паузой таймера */
  if (_fxVideo && _fxOn) {
    if (act && !act.paused) {
      if (_fxVideo.paused) _fxVideo.play().catch(() => {});
    } else if (!_fxVideo.paused) {
      _fxVideo.pause();
    }
  }
  const total = todayFocusMs();
  const poms = Math.floor(total / CYCLE_MS);
  if (poms > _lastPoms && _lastPoms >= 0) {
    try { if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 100]); } catch (e) {}
  }
  _lastPoms = poms;
  const p = (total % CYCLE_MS) / CYCLE_MS;
  for (const panel of list) {
    if (!panel._fpBuilt) continue;
    if (needMode !== panel._mode) renderCenter(panel);
    const pomsEl = panel.querySelector('.fp-poms');
    /* Молнии вместо помидоров */
    if (pomsEl) pomsEl.textContent = poms > 0 ? (poms <= 8 ? '⚡'.repeat(poms) : `⚡ ×${poms}`) : '';
    const fill = panel.querySelector('.fp-fill');
    if (fill) {
      fill.style.strokeDasharray = `${ARC * p} ${C}`;
      fill.style.opacity = p > 0.005 ? 1 : 0;
    }
    if (act) {
      const tEl = panel.querySelector('.fp-time');
      if (tEl) {
        tEl.textContent = fmtMMSS(act.elapsed);
        tEl.classList.toggle('shrink', Math.floor(act.elapsed / 60000) >= 100);
      }
    }
    const totEl = panel.querySelector('.fp-total');
    if (totEl) totEl.innerHTML = `Общее время фокусировки за сегодня: <span class="fp-total-time">${fmtMin(Math.floor(total / 60000))}</span>`;
    const stopBtn = panel.querySelector('.fp-stop');
    if (stopBtn) stopBtn.style.display = act ? '' : 'none';
    const pauseBtn = panel.querySelector('.fp-pause');
    if (pauseBtn) {
      pauseBtn.style.display = act ? '' : 'none';
      pauseBtn.innerHTML = act ? (act.paused ? ICON_PLAY_S : ICON_PAUSE_S) : '';
      pauseBtn.title = act && act.paused ? 'Продолжить' : 'Пауза';
    }
  }
}
const fmtMMSS = ms => {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
export function focusInit() {
  buildPanel($('focusPanel'), true);
  updateFocusUI();
  /* Ролик и шейдер — заранее, когда браузер свободен: к нажатию «Старт»
     всё уже готово и первый кадр декодирован */
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 1500));
  idle(() => { prepareVideo(); if (ensureFx()) initGL(); }, { timeout: 4000 });
  document.addEventListener('timer-changed', updateFocusUI);
  /* смена экрана: молния переезжает в панель, которая теперь видна */
  document.addEventListener('screen-entered', updateFocusUI);
  document.addEventListener('sync-done', updateFocusUI);
  document.addEventListener('user-change', updateFocusUI);
}
