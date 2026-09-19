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
let _built = false;
let _centerMode = '';
let _lastPoms = -1;
export const isChoosing = () => choosing;

const ICON_PLAY_S = '<svg viewBox="0 0 24 24"><path d="M8 5l12 7-12 7z"/></svg>';
const ICON_PAUSE_S = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const ICON_STOP_S = '<svg viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>';
const HANDLE_PATH = 'M2 22 A20 20 0 0 1 12 4.68';
const handleSVG = dock => `<svg class="dock-handle" data-dock="${dock}" viewBox="0 0 32 32" aria-hidden="true"><path d="${HANDLE_PATH}" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`;

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
const FX_SOURCES = ['videos/lightning.mp4', 'videos/lightning.webm', 'videos/lightning.mov'];
const FX_BLUR_PX = 7;    // максимум блюра в центре панели
const FX_DIM = 0.75;     // приглушение яркости молнии
let _fxVideo = null, _fxCanvas = null, _fxOn = false, _fxRaf = 0, _fxLogged = false;
let _gl = null, _glTex = null;
let _uRes = null, _uBlur = null, _uAccent = null, _uDim = null;
let _accentRGB = [0.86, 0.15, 0.15];

function hexToRgb01(hex) {
  const n = (hex || '').trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(n)) return [0.86, 0.15, 0.15];
  return [parseInt(n.slice(0, 2), 16) / 255, parseInt(n.slice(2, 4), 16) / 255, parseInt(n.slice(4, 6), 16) / 255];
}
function refreshAccent() {
  const cs = getComputedStyle(document.documentElement);
  _accentRGB = hexToRgb01(cs.getPropertyValue('--mode-' + (state.mode || 'work')));
}
function ensureFx() {
  const panel = $('focusPanel');
  if (!panel) return null;
  if (_fxCanvas) return _fxCanvas;
  _fxCanvas = document.createElement('canvas');
  _fxCanvas.className = 'fp-video';
  panel.insertBefore(_fxCanvas, panel.firstChild);
  _fxVideo = document.createElement('video');
  _fxVideo.muted = true;
  _fxVideo.loop = true;
  _fxVideo.playsInline = true;
  _fxVideo.setAttribute('playsinline', '');
  _fxVideo.preload = 'auto';
  let srcIdx = 0;
  const tryNext = () => {
    if (!_fxVideo) return;
    if (srcIdx >= FX_SOURCES.length) {
      console.warn('[focus] Видео молнии НЕ НАЙДЕНО. Положи файл в репозиторий по пути videos/lightning.mp4 (или .webm / .mov) и обнови страницу.');
      _fxVideo = null;
      return;
    }
    const s = FX_SOURCES[srcIdx++];
    _fxVideo.src = s;
    _fxVideo.load();
  };
  _fxVideo.addEventListener('error', tryNext);
  _fxVideo.addEventListener('canplay', () => {
    if (!_fxLogged) {
      _fxLogged = true;
      console.info('[focus] видео загружено:', _fxVideo.currentSrc);
    }
    if (_fxOn && initGL()) startFxLoop();
  });
  tryNext();
  return _fxCanvas;
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
    'uniform sampler2D t;uniform vec2 uRes;uniform float uBlur;uniform vec3 uAccent;uniform float uDim;' +
    'void main(){' +
    /* радиальный блюр: максимум в центре, к краям — 0 */
    'float d=distance(uv,vec2(0.5))*2.0;' +
    'float w=clamp(1.0-d,0.0,1.0);w=w*w;' +
    'float r=uBlur*w;' +
    'vec4 acc=texture2D(t,uv);' +
    'for(int i=0;i<8;i++){float a=6.2831853*float(i)/8.0;vec2 off=vec2(cos(a),sin(a))*(r/uRes);acc+=texture2D(t,uv+off);}' +
    'acc/=9.0;' +
    /* хромокей: зелёный -> прозрачный */
    'float g=max(0.0,acc.g-max(acc.r,acc.b));' +
    'float al=1.0-smoothstep(0.08,0.35,g);' +
    /* перекраска: свечение — цветом режима, ядро — белым */
    'float lum=dot(acc.rgb,vec3(0.299,0.587,0.114));' +
    'vec3 col=mix(uAccent,vec3(1.0),smoothstep(0.55,0.95,lum));' +
    'gl_FragColor=vec4(col,al*uDim);}');
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
  _uBlur = gl.getUniformLocation(pr, 'uBlur');
  _uAccent = gl.getUniformLocation(pr, 'uAccent');
  _uDim = gl.getUniformLocation(pr, 'uDim');
  gl.clearColor(0, 0, 0, 0);
  _gl = gl;
  return true;
}
function fxTick() {
  const v = _fxVideo, gl = _gl;
  if (v && gl && v.readyState >= 2 && !v.paused) {
    const w = _fxCanvas.clientWidth | 0, h = _fxCanvas.clientHeight | 0;
    if (w > 0 && h > 0) {
      if (_fxCanvas.width !== w || _fxCanvas.height !== h) {
        _fxCanvas.width = w;
        _fxCanvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(_uRes, w, h);
      gl.uniform1f(_uBlur, FX_BLUR_PX);
      gl.uniform1f(_uDim, FX_DIM);
      gl.uniform3f(_uAccent, _accentRGB[0], _accentRGB[1], _accentRGB[2]);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, _glTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }
  _fxRaf = requestAnimationFrame(fxTick);
}
function startFxLoop() {
  cancelAnimationFrame(_fxRaf);
  _fxRaf = requestAnimationFrame(fxTick);
  if (_fxVideo) _fxVideo.play().catch(() => {});
  if (_fxCanvas) _fxCanvas.classList.add('on');
}
function setFx(on) {
  const panel = $('focusPanel');
  if (on && panel && panel.clientWidth === 0) on = false; // панель не видна — не крутим
  if (on === _fxOn) return;
  _fxOn = on;
  if (on) {
    refreshAccent();
    if (!ensureFx() || !_fxVideo || !initGL()) return;
    startFxLoop();
  } else {
    cancelAnimationFrame(_fxRaf);
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
  if (e.target.closest('.r-row, .task, .focus-panel')) return;
  exitChoosing();
}
function enterChoosing() {
  choosing = true;
  const grid = $('grid');
  if (grid) grid.classList.add('focus-choosing');
  renderCenter();
  setTimeout(() => document.addEventListener('pointerdown', cancelOnOutside), 0);
}
function exitChoosing() {
  choosing = false;
  const grid = $('grid');
  if (grid) grid.classList.remove('focus-choosing');
  document.removeEventListener('pointerdown', cancelOnOutside);
  renderCenter();
}
async function startWithoutTask() {
  exitChoosing();
  const t = await createTask({ title: 'Фокусировка', days: { [today()]: 'todo' } });
  tm.start(t.id);
}

/* ── Рендер панели ── */
function renderFocusPanel() {
  const panel = $('focusPanel');
  if (!panel || _built) return;
  _built = true;
  panel.innerHTML = `${handleSVG('focus')}
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
  ensureFx(); // канвас с молнией под контентом
  renderCenter();
  updateFocusUI();
}
function renderCenter() {
  const panel = $('focusPanel');
  if (!panel) return;
  const center = panel.querySelector('.fp-center');
  if (!center) return;
  const act = tm.getActive();
  _centerMode = choosing ? 'choose' : act ? 'run' : 'idle';
  if (_centerMode === 'idle') {
    center.innerHTML = `<div class="fp-caption">Фокусировка</div><button type="button" class="fp-play" title="Запустить фокус"><svg viewBox="0 0 24 24"><path d="M8 5l12 7-12 7z"/></svg></button>`;
    center.querySelector('.fp-play').onclick = enterChoosing;
  } else if (_centerMode === 'choose') {
    center.innerHTML = `<div class="fp-choose">Фокусировка на:<br><span class="blink">Выберите задачу</span></div>
<button type="button" class="fp-notask chip">Без задачи</button>`;
    center.querySelector('.fp-notask').onclick = startWithoutTask;
  } else {
    center.innerHTML = `<div class="fp-time">00:00</div>`;
  }
}
function updateFocusUI() {
  const panel = $('focusPanel');
  if (!panel || !_built) return;
  const act = tm.getActive();
  const needMode = choosing ? 'choose' : act ? 'run' : 'idle';
  if (needMode !== _centerMode) renderCenter();
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
  const pomsEl = panel.querySelector('.fp-poms');
  /* Молнии вместо помидоров */
  if (pomsEl) pomsEl.textContent = poms > 0 ? (poms <= 8 ? '⚡'.repeat(poms) : `⚡ ×${poms}`) : '';
  if (poms > _lastPoms && _lastPoms >= 0) {
    try { if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 100]); } catch (e) {}
  }
  _lastPoms = poms;
  const fill = panel.querySelector('.fp-fill');
  if (fill) {
    const p = (total % CYCLE_MS) / CYCLE_MS;
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
const fmtMMSS = ms => {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
export function focusInit() {
  renderFocusPanel();
  document.addEventListener('timer-changed', updateFocusUI);
  document.addEventListener('sync-done', updateFocusUI);
  document.addEventListener('user-change', updateFocusUI);
}
