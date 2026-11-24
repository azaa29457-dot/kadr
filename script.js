/* ==========================================================
   Кадр — фоторедактор, который работает прямо в браузере.
   Фото никуда не отправляется: вся обработка идёт на устройстве.

   Как устроено:
   1. state — описание всех правок (фильтр, ползунки, обрезка, текст).
      Само фото не меняется, поэтому любую правку можно отменить.
   2. Чтобы показать результат, программа берёт исходное фото
      и заново применяет к нему все правки из state.
   3. При сохранении то же самое делается с фото в полном размере.
   ========================================================== */
'use strict';

(() => {

  /* ---------- Настройки ---------- */

  const PREVIEW_MAX = 1600;          // максимальная сторона фото на экране (для скорости)
  const EXPORT_MAX_PIXELS = 16000000; // ограничение для iPhone: больше 16 Мп Safari не сохранит
  const THUMB_SIZE = 140;            // размер миниатюр фильтров
  const HISTORY_LIMIT = 60;          // сколько шагов можно отменить

  const ADJUSTMENTS = [
    { key: 'brightness', label: 'Яркость', min: -100, max: 100 },
    { key: 'contrast', label: 'Контраст', min: -100, max: 100 },
    { key: 'saturation', label: 'Насыщенность', min: -100, max: 100 },
    { key: 'warmth', label: 'Теплота', min: -100, max: 100 },
    { key: 'blur', label: 'Размытие', min: 0, max: 100 },
    { key: 'vignette', label: 'Виньетка', min: 0, max: 100 },
  ];

  // Каждый фильтр — это набор готовых значений ползунков
  const FILTERS = [
    { id: 'none', name: 'Оригинал', p: {} },
    { id: 'vivid', name: 'Яркий', p: { saturation: 45, contrast: 15 } },
    { id: 'warm', name: 'Тёплый', p: { warmth: 35, saturation: 10, brightness: 3 } },
    { id: 'cold', name: 'Холодный', p: { warmth: -35, contrast: 6 } },
    { id: 'film', name: 'Плёнка', p: { fade: 0.45, warmth: 10, contrast: 12, saturation: -12 } },
    { id: 'cinema', name: 'Кино', p: { contrast: 22, saturation: -10, warmth: 12, fade: 0.25, vignette: 28 } },
    { id: 'vintage', name: 'Винтаж', p: { sepia: 0.3, fade: 0.6, contrast: -6, saturation: -20, warmth: 15, vignette: 35 } },
    { id: 'pastel', name: 'Пастель', p: { fade: 0.7, saturation: -18, brightness: 10, contrast: -15 } },
    { id: 'drama', name: 'Драма', p: { contrast: 40, saturation: -25, brightness: -6, vignette: 45 } },
    { id: 'bw', name: 'Ч/б', p: { grayscale: 1, contrast: 12 } },
    { id: 'noir', name: 'Нуар', p: { grayscale: 1, contrast: 50, brightness: -10, vignette: 30 } },
    { id: 'sepia', name: 'Сепия', p: { sepia: 0.85, contrast: 5 } },
  ];

  const FONTS = [
    { id: 'montserrat', family: 'Montserrat', weight: 800, name: 'Жирный' },
    { id: 'russo', family: 'Russo One', weight: 400, name: 'Плакат' },
    { id: 'oswald', family: 'Oswald', weight: 600, name: 'Узкий' },
    { id: 'playfair', family: 'Playfair Display', weight: 700, name: 'Элегантный' },
    { id: 'caveat', family: 'Caveat', weight: 700, name: 'Рукописный' },
    { id: 'lobster', family: 'Lobster', weight: 400, name: 'Каллиграфия' },
    { id: 'comfortaa', family: 'Comfortaa', weight: 700, name: 'Округлый' },
    { id: 'onest', family: 'Onest', weight: 600, name: 'Простой' },
  ];

  const COLORS = [
    { value: '#ffffff', name: 'Белый' },
    { value: '#111111', name: 'Чёрный' },
    { value: '#ffc53d', name: 'Жёлтый' },
    { value: '#ff4d4d', name: 'Красный' },
    { value: '#ff7ac6', name: 'Розовый' },
    { value: '#4da3ff', name: 'Синий' },
    { value: '#3ddc84', name: 'Зелёный' },
    { value: '#9b6bff', name: 'Фиолетовый' },
  ];

  const RATIOS = { '1:1': 1, '4:5': 4 / 5, '9:16': 9 / 16, '16:9': 16 / 9 };

  // Повороты и отражения в виде матриц 2×2: [a, b, c, d]
  const OPS = {
    rotRight: [0, 1, -1, 0],
    rotLeft: [0, -1, 1, 0],
    flipH: [-1, 0, 0, 1],
    flipV: [1, 0, 0, -1],
  };

  /* ---------- Элементы страницы ---------- */

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const el = {
    app: $('#app'),
    stage: $('#stage'),
    empty: $('#empty'),
    wrap: $('#canvas-wrap'),
    canvas: $('#canvas'),
    fileInput: $('#file-input'),
    btnPick: $('#btn-pick'),
    btnOpen: $('#btn-open'),
    btnUndo: $('#btn-undo'),
    btnRedo: $('#btn-redo'),
    btnCompare: $('#btn-compare'),
    btnSave: $('#btn-save'),
    compareBadge: $('#compare-badge'),
    tabs: $$('.tab'),
    panes: $$('.pane'),
    filmstrip: $('#filmstrip'),
    strengthField: $('#strength-field'),
    strength: $('#strength'),
    strengthValue: $('#strength-value'),
    sliders: $('#sliders'),
    btnResetAdjust: $('#btn-reset-adjust'),
    cropUI: $('#crop-ui'),
    cropBox: $('#crop-box'),
    cropShade: $('#crop-shade'),
    ratios: $$('#ratios .chip'),
    btnRotLeft: $('#btn-rot-left'),
    btnRotRight: $('#btn-rot-right'),
    btnFlipH: $('#btn-flip-h'),
    btnFlipV: $('#btn-flip-v'),
    btnCropReset: $('#btn-crop-reset'),
    btnCropApply: $('#btn-crop-apply'),
    btnAddText: $('#btn-add-text'),
    textHint: $('#text-hint'),
    textEditor: $('#text-editor'),
    textInput: $('#text-input'),
    fontGrid: $('#font-grid'),
    textSize: $('#text-size'),
    textSizeValue: $('#text-size-value'),
    swatches: $('#swatches'),
    textStyle: $$('#text-style button'),
    btnDeleteText: $('#btn-delete-text'),
    saveDialog: $('#save-dialog'),
    btnSaveClose: $('#btn-save-close'),
    format: $$('#format button'),
    formatHint: $('#format-hint'),
    qualityField: $('#quality-field'),
    quality: $('#quality'),
    qualityValue: $('#quality-value'),
    saveInfo: $('#save-info'),
    btnShare: $('#btn-share'),
    btnDownload: $('#btn-download'),
    toast: $('#toast'),
  };
  const ctx = el.canvas.getContext('2d');

  /* ---------- Состояние ---------- */

  function defaultState() {
    return {
      m: [1, 0, 0, 1],                    // поворот и отражение
      crop: { x: 0, y: 0, w: 1, h: 1 },   // обрезка в долях от размера фото
      filter: 'none',
      strength: 100,
      adjust: { brightness: 0, contrast: 0, saturation: 0, warmth: 0, blur: 0, vignette: 0 },
      texts: [],
    };
  }

  let state = defaultState();
  let history = [];
  let historyIndex = -1;

  let source = null;       // исходное фото в полном размере
  let preview = null;      // уменьшенная копия для быстрого показа на экране
  let fileBaseName = 'photo';

  let mode = 'normal';     // 'normal' или 'crop'
  let activeTab = 'filters';
  let comparing = false;
  let selectedTextId = null;
  let pendingCrop = null;
  let cropRatio = 'free';

  // Промежуточные результаты, чтобы не пересчитывать всё при каждом движении
  let baseCanvas = null;   // фото после поворота и обрезки
  let baseData = null;
  let adjustedCanvas = null; // фото после фильтров и настроек
  let dirtyBase = true;
  let dirtyAdjust = true;
  let thumbsDirty = true;
  let textBoxes = new Map();

  const loadedFonts = new Set();
  const loadingFonts = new Set();

  /* ---------- Вспомогательные функции ---------- */

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const uid = () => Math.random().toString(36).slice(2, 10);

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function formatSigned(v) {
    if (v > 0) return '+' + v;
    if (v < 0) return '−' + Math.abs(v);
    return '0';
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' КБ';
    return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
  }

  let toastTimer = null;
  function toast(message, isError = false) {
    el.toast.textContent = message;
    el.toast.classList.toggle('is-error', isError);
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), isError ? 4500 : 2600);
  }

  function isTyping() {
    const a = document.activeElement;
    return a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'range'));
  }

  /* ---------- История: отмена и повтор ---------- */

  function commit() {
    const snap = JSON.stringify(state);
    if (history[historyIndex] === snap) return;
    history = history.slice(0, historyIndex + 1);
    history.push(snap);
    if (history.length > HISTORY_LIMIT) history.shift();
    historyIndex = history.length - 1;
    updateHistoryButtons();
  }

  function restore(snap) {
    const prev = state;
    state = JSON.parse(snap);
    if (JSON.stringify(prev.m) !== JSON.stringify(state.m) ||
        JSON.stringify(prev.crop) !== JSON.stringify(state.crop)) {
      dirtyBase = true;
      thumbsDirty = true;
    }
    dirtyAdjust = true;
    if (mode === 'crop') {
      pendingCrop = { ...state.crop };
      dirtyBase = true;
    }
    if (selectedTextId && !state.texts.some((t) => t.id === selectedTextId)) selectedTextId = null;
    syncUI();
    requestRender();
    updateHistoryButtons();
  }

  function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    restore(history[historyIndex]);
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    restore(history[historyIndex]);
  }

  function updateHistoryButtons() {
    el.btnUndo.disabled = historyIndex <= 0;
    el.btnRedo.disabled = historyIndex >= history.length - 1;
  }

  /* ---------- Открытие фото ---------- */

  function decodeImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  async function loadFile(file) {
    if (!file) return;
    const looksLikeImage = (file.type && file.type.startsWith('image/')) ||
      /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name || '');
    if (!looksLikeImage) {
      toast('Этот файл не похож на фото. Выберите изображение в формате JPG, PNG или WebP.', true);
      return;
    }

    let img;
    try {
      img = await decodeImage(file);
    } catch (e) {
      const isHeic = /heic|heif/i.test(file.type + ' ' + (file.name || ''));
      toast(isHeic
        ? 'Этот браузер не открывает фото в формате HEIC. Сохраните фото в JPG и попробуйте снова.'
        : 'Не получилось открыть это фото. Попробуйте другой файл.', true);
      return;
    }

    source = img;
    const sw = img.naturalWidth;
    const sh = img.naturalHeight;
    const scale = Math.min(1, PREVIEW_MAX / Math.max(sw, sh));
    preview = makeCanvas(sw * scale, sh * scale);
    const pctx = preview.getContext('2d');
    pctx.imageSmoothingQuality = 'high';
    pctx.drawImage(img, 0, 0, preview.width, preview.height);

    fileBaseName = ((file.name || '').replace(/\.[^.]+$/, '') || 'photo').slice(0, 60);

    state = defaultState();
    history = [];
    historyIndex = -1;
    commit();

    selectedTextId = null;
    mode = 'normal';
    pendingCrop = null;
    cropRatio = 'free';
    el.cropUI.hidden = true;
    dirtyBase = true;
    thumbsDirty = true;

    el.app.dataset.state = 'ready';
    el.empty.hidden = true;
    el.wrap.hidden = false;
    el.wrap.classList.remove('reveal');
    void el.wrap.offsetWidth;
    el.wrap.classList.add('reveal');

    setTab('filters');
    syncUI();
    renderNow();
  }

  /* ---------- Геометрия: поворот, отражение, обрезка ---------- */

  function orientedSize(w, h, m) {
    return m[0] !== 0 ? [w, h] : [h, w];
  }

  function multiply(op, m) {
    return [
      op[0] * m[0] + op[2] * m[1],
      op[1] * m[0] + op[3] * m[1],
      op[0] * m[2] + op[2] * m[3],
      op[1] * m[2] + op[3] * m[3],
    ];
  }

  // Как меняется рамка обрезки, когда фото поворачивают или отражают
  function transformRect(r, opName) {
    switch (opName) {
      case 'rotRight': return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
      case 'rotLeft': return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
      case 'flipH': return { x: 1 - r.x - r.w, y: r.y, w: r.w, h: r.h };
      case 'flipV': return { x: r.x, y: 1 - r.y - r.h, w: r.w, h: r.h };
      default: return { ...r };
    }
  }

  // Рисует фото с поворотом и отражением, сдвигом (обрезка) и масштабом
  function drawTransformed(context, img, iw, ih, m, offsetX, offsetY, scale) {
    const [W, H] = orientedSize(iw, ih, m);
    context.save();
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.translate(-offsetX, -offsetY);
    context.transform(m[0], m[1], m[2], m[3], W / 2, H / 2);
    context.imageSmoothingQuality = 'high';
    context.drawImage(img, -iw / 2, -ih / 2, iw, ih);
    context.restore();
  }

  /* ---------- Обработка пикселей ---------- */

  function paramsFor(filterId, strength, adjust) {
    const f = FILTERS.find((x) => x.id === filterId) || FILTERS[0];
    const k = strength / 100;
    const p = f.p;
    const a = adjust;
    return {
      brightness: (p.brightness || 0) * k + a.brightness,
      contrast: (p.contrast || 0) * k + a.contrast,
      saturation: (p.saturation || 0) * k + a.saturation,
      warmth: (p.warmth || 0) * k + a.warmth,
      fade: (p.fade || 0) * k,
      grayscale: (p.grayscale || 0) * k,
      sepia: (p.sepia || 0) * k,
      vignette: Math.min(100, (p.vignette || 0) * k + a.vignette),
      blur: a.blur,
    };
  }

  const ZERO_ADJUST = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, blur: 0, vignette: 0 };

  function needsPixelWork(p) {
    return p.brightness || p.contrast || p.saturation || p.warmth || p.fade || p.grayscale || p.sepia;
  }

  // Таблицы «было → стало» для каждого канала: так обработка идёт быстрее
  function buildTables(p) {
    const R = new Uint8ClampedArray(256);
    const G = new Uint8ClampedArray(256);
    const B = new Uint8ClampedArray(256);
    const bri = clamp(p.brightness, -100, 100) / 100;
    const con = clamp(p.contrast, -100, 100) / 100;
    const C = con >= 0 ? 1 + con * 1.2 : 1 + con * 0.75;
    const fade = clamp(p.fade, 0, 1);
    const warm = clamp(p.warmth, -100, 100);

    for (let v = 0; v < 256; v++) {
      let x = v;
      x = bri > 0 ? x + (255 - x) * bri * 0.6 : x * (1 + bri * 0.6);
      x = (x - 128) * C + 128;
      x = clamp(x, 0, 255);
      if (fade) x = x + fade * 60 * (1 - x / 255) - fade * 22 * (x / 255);
      R[v] = x + warm * 0.32;
      G[v] = x + warm * 0.06;
      B[v] = x - warm * 0.32;
    }
    return { R, G, B };
  }

  function processPixels(imageData, p) {
    const d = imageData.data;
    const { R, G, B } = buildTables(p);
    const S = clamp(1 + p.saturation / 100, 0, 3) * (1 - clamp(p.grayscale, 0, 1));
    const sep = clamp(p.sepia, 0, 1);
    const doSat = Math.abs(S - 1) > 0.001;
    const doSep = sep > 0.001;

    for (let i = 0; i < d.length; i += 4) {
      let r = R[d[i]];
      let g = G[d[i + 1]];
      let b = B[d[i + 2]];
      if (doSat) {
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        r = l + (r - l) * S;
        g = l + (g - l) * S;
        b = l + (b - l) * S;
      }
      if (doSep) {
        const sr = 0.393 * r + 0.769 * g + 0.189 * b;
        const sg = 0.349 * r + 0.686 * g + 0.168 * b;
        const sb = 0.272 * r + 0.534 * g + 0.131 * b;
        r += (sr - r) * sep;
        g += (sg - g) * sep;
        b += (sb - b) * sep;
      }
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
    }
  }

  // Размытие: три прохода «усредняющего» фильтра почти не отличаются от гауссова
  function boxSizes(sigma, n) {
    const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
    let wl = Math.floor(ideal);
    if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
    const m = Math.round(mIdeal);
    const sizes = [];
    for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
    return sizes;
  }

  function blurPass(src, dst, w, h, r, horizontal) {
    const inv = 1 / (r + r + 1);
    const outer = horizontal ? h : w;
    const inner = horizontal ? w : h;
    const step = horizontal ? 4 : w * 4;
    for (let o = 0; o < outer; o++) {
      const start = horizontal ? o * w * 4 : o * 4;
      const last = start + (inner - 1) * step;
      let sr = 0, sg = 0, sb = 0;
      for (let k = -r; k <= r; k++) {
        const idx = start + clamp(k, 0, inner - 1) * step;
        sr += src[idx]; sg += src[idx + 1]; sb += src[idx + 2];
      }
      for (let i = 0; i < inner; i++) {
        const idx = start + i * step;
        dst[idx] = sr * inv;
        dst[idx + 1] = sg * inv;
        dst[idx + 2] = sb * inv;
        dst[idx + 3] = src[idx + 3];
        const addIdx = i + r + 1 < inner ? start + (i + r + 1) * step : last;
        const subIdx = i - r > 0 ? start + (i - r) * step : start;
        sr += src[addIdx] - src[subIdx];
        sg += src[addIdx + 1] - src[subIdx + 1];
        sb += src[addIdx + 2] - src[subIdx + 2];
      }
    }
  }

  function blurPixels(imageData, sigma) {
    if (sigma < 0.5) return;
    const { width: w, height: h, data } = imageData;
    const tmp = new Uint8ClampedArray(data.length);
    for (const size of boxSizes(sigma, 3)) {
      const r = (size - 1) / 2;
      if (r < 1) continue;
      blurPass(data, tmp, w, h, r, true);
      blurPass(tmp, data, w, h, r, false);
    }
  }

  function drawVignette(context, w, h, amount) {
    if (amount <= 0) return;
    const radius = Math.hypot(w, h) / 2;
    const g = context.createRadialGradient(w / 2, h / 2, radius * 0.3, w / 2, h / 2, radius);
    const a = (amount / 100) * 0.85;
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.55, `rgba(0,0,0,${a * 0.35})`);
    g.addColorStop(1, `rgba(0,0,0,${a})`);
    context.save();
    context.fillStyle = g;
    context.fillRect(0, 0, w, h);
    context.restore();
  }

  // Сильное размытие считаем на уменьшенной копии: на вид так же, но в разы быстрее
  function blurCanvas(canvas, sigma) {
    if (sigma < 0.5) return;
    const c = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const k = Math.min(8, Math.max(1, sigma / 3));
    if (k < 1.5) {
      const data = c.getImageData(0, 0, w, h);
      blurPixels(data, sigma);
      c.putImageData(data, 0, 0);
      return;
    }
    const small = makeCanvas(w / k, h / k);
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(canvas, 0, 0, small.width, small.height);
    const data = sctx.getImageData(0, 0, small.width, small.height);
    blurPixels(data, sigma / k);
    sctx.putImageData(data, 0, 0);
    c.save();
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(small, 0, 0, w, h);
    c.restore();
  }

  // Применяет все цветовые правки к картинке на холсте
  function applyLook(canvas, p) {
    const c = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    if (needsPixelWork(p)) {
      const data = c.getImageData(0, 0, w, h);
      processPixels(data, p);
      c.putImageData(data, 0, 0);
    }
    if (p.blur > 0) blurCanvas(canvas, (p.blur / 100) * Math.min(w, h) * 0.025);
    drawVignette(c, w, h, p.vignette);
  }

  /* ---------- Текст на фото ---------- */

  function fontOf(t) {
    return FONTS.find((f) => f.id === t.font) || FONTS[0];
  }

  function fontString(font, px) {
    return `${font.weight} ${px}px "${font.family}"`;
  }

  function ensureFont(font, sample = 'АаAa') {
    if (loadedFonts.has(font.id) || loadingFonts.has(font.id)) return;
    loadingFonts.add(font.id);
    document.fonts.load(fontString(font, 40), sample + ' АаAa').then(() => {
      loadedFonts.add(font.id);
      loadingFonts.delete(font.id);
      requestRender();
    }).catch(() => loadingFonts.delete(font.id));
  }

  function contrastColor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#111111' : '#ffffff';
  }

  function roundRect(context, x, y, w, h, r) {
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + w, y, x + w, y + h, r);
    context.arcTo(x + w, y + h, x, y + h, r);
    context.arcTo(x, y + h, x, y, r);
    context.arcTo(x, y, x + w, y, r);
    context.closePath();
  }

  function drawTexts(context, w, h, texts, opts = {}) {
    const boxes = new Map();
    const short = Math.min(w, h);
    for (const t of texts) {
      const font = fontOf(t);
      if (!opts.export) ensureFont(font);
      const px = short * (0.025 + (t.size / 100) * 0.18);
      const lines = (t.text || '').split('\n');
      const lineH = px * 1.22;
      context.save();
      context.font = fontString(font, px);
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      const widths = lines.map((l) => context.measureText(l).width);
      const maxW = Math.max(px * 0.5, ...widths);
      const blockH = lines.length * lineH;
      const cx = t.x * w;
      const cy = t.y * h;
      const top = cy - blockH / 2;
      let padX = px * 0.18;
      let padY = px * 0.12;
      let fill = t.color;

      if (t.style === 'box') {
        padX = px * 0.45;
        padY = px * 0.22;
        context.fillStyle = t.color;
        roundRect(context, cx - maxW / 2 - padX, top - padY, maxW + padX * 2, blockH + padY * 2, px * 0.3);
        context.fill();
        fill = contrastColor(t.color);
      }
      if (t.style === 'shadow') {
        context.shadowColor = 'rgba(0, 0, 0, 0.6)';
        context.shadowBlur = px * 0.25;
        context.shadowOffsetY = px * 0.06;
      }

      lines.forEach((line, i) => {
        const y = top + lineH * (i + 0.5);
        if (t.style === 'outline') {
          context.lineWidth = px * 0.14;
          context.lineJoin = 'round';
          context.miterLimit = 2;
          context.strokeStyle = contrastColor(t.color);
          context.strokeText(line, cx, y);
        }
        context.fillStyle = fill;
        context.fillText(line, cx, y);
      });
      context.restore();

      const gap = px * 0.08;
      const box = {
        x: cx - maxW / 2 - padX - gap,
        y: top - padY - gap,
        w: maxW + (padX + gap) * 2,
        h: blockH + (padY + gap) * 2,
      };
      boxes.set(t.id, box);

      if (opts.selectedId === t.id) {
        const ui = opts.ui || 1;
        context.save();
        context.setLineDash([6 * ui, 4 * ui]);
        context.lineWidth = 1.5 * ui;
        context.strokeStyle = '#ffc53d';
        context.strokeRect(box.x, box.y, box.w, box.h);
        context.restore();
      }
    }
    return boxes;
  }

  /* ---------- Показ на экране ---------- */

  function ensureBase() {
    if (!dirtyBase) return;
    const m = state.m;
    const [W, H] = orientedSize(preview.width, preview.height, m);
    const r = mode === 'crop' ? { x: 0, y: 0, w: 1, h: 1 } : state.crop;
    const bw = Math.max(1, Math.round(r.w * W));
    const bh = Math.max(1, Math.round(r.h * H));
    baseCanvas = makeCanvas(bw, bh);
    const bctx = baseCanvas.getContext('2d', { willReadFrequently: true });
    drawTransformed(bctx, preview, preview.width, preview.height, m, r.x * W, r.y * H, 1);
    baseData = bctx.getImageData(0, 0, bw, bh);
    dirtyBase = false;
    dirtyAdjust = true;
    thumbsDirty = true;
  }

  function ensureAdjusted() {
    if (!dirtyAdjust) return;
    const p = paramsFor(state.filter, state.strength, state.adjust);
    if (!adjustedCanvas || adjustedCanvas.width !== baseCanvas.width || adjustedCanvas.height !== baseCanvas.height) {
      adjustedCanvas = makeCanvas(baseCanvas.width, baseCanvas.height);
    }
    const actx = adjustedCanvas.getContext('2d', { willReadFrequently: true });
    actx.putImageData(baseData, 0, 0);
    applyLook(adjustedCanvas, p);
    dirtyAdjust = false;
  }

  function displayScale() {
    const cssW = parseFloat(el.canvas.style.width) || el.canvas.width;
    return el.canvas.width / cssW;
  }

  function renderNow() {
    if (!source) return;
    ensureBase();
    if (!comparing) ensureAdjusted();

    const w = baseCanvas.width;
    const h = baseCanvas.height;
    if (el.canvas.width !== w || el.canvas.height !== h) {
      el.canvas.width = w;
      el.canvas.height = h;
      fitCanvas();
    }
    ctx.drawImage(comparing ? baseCanvas : adjustedCanvas, 0, 0);

    if (!comparing && mode !== 'crop') {
      textBoxes = drawTexts(ctx, w, h, state.texts, {
        selectedId: activeTab === 'text' ? selectedTextId : null,
        ui: displayScale(),
      });
    } else {
      textBoxes = new Map();
    }

    if (mode === 'crop') positionCropUI();
    if (thumbsDirty && activeTab === 'filters') updateThumbnails();
  }

  let frameRequested = false;
  function requestRender() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      renderNow();
    });
  }

  // Подгоняет размер фото под свободное место на экране
  function fitCanvas() {
    if (el.wrap.hidden) return;
    const cs = getComputedStyle(el.stage);
    const availW = el.stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = el.stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (availW <= 0 || availH <= 0) return;
    const ratio = el.canvas.width / el.canvas.height;
    let w = availW;
    let h = w / ratio;
    if (h > availH) {
      h = availH;
      w = h * ratio;
    }
    el.canvas.style.width = Math.floor(w) + 'px';
    el.canvas.style.height = Math.floor(h) + 'px';
  }

  /* ---------- Миниатюры фильтров ---------- */

  function buildFilmstrip() {
    el.filmstrip.innerHTML = '';
    for (const f of FILTERS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'frame';
      btn.setAttribute('role', 'option');
      btn.dataset.filter = f.id;
      btn.setAttribute('aria-selected', 'false');
      const c = document.createElement('canvas');
      c.width = THUMB_SIZE;
      c.height = THUMB_SIZE;
      const label = document.createElement('span');
      label.textContent = f.name;
      btn.append(c, label);
      btn.addEventListener('click', () => {
        if (state.filter === f.id) return;
        state.filter = f.id;
        state.strength = 100;
        dirtyAdjust = true;
        syncFilters();
        requestRender();
        commit();
      });
      el.filmstrip.append(btn);
    }
  }

  function updateThumbnails() {
    if (!baseCanvas) return;
    thumbsDirty = false;
    const small = makeCanvas(THUMB_SIZE, THUMB_SIZE);
    const sctx = small.getContext('2d', { willReadFrequently: true });
    const bw = baseCanvas.width;
    const bh = baseCanvas.height;
    const side = Math.min(bw, bh);
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(baseCanvas, (bw - side) / 2, (bh - side) / 2, side, side, 0, 0, THUMB_SIZE, THUMB_SIZE);
    const original = sctx.getImageData(0, 0, THUMB_SIZE, THUMB_SIZE);

    $$('.frame').forEach((btn) => {
      const c = btn.querySelector('canvas');
      const cctx = c.getContext('2d', { willReadFrequently: true });
      cctx.putImageData(original, 0, 0);
      applyLook(c, paramsFor(btn.dataset.filter, 100, ZERO_ADJUST));
    });
  }

  /* ---------- Ползунки настроек ---------- */

  function setFill(input) {
    const min = +input.min;
    const max = +input.max;
    const v = +input.value;
    const pos = ((v - min) / (max - min)) * 100;
    const zero = min < 0 ? ((0 - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fs', Math.min(zero, pos) + '%');
    input.style.setProperty('--fe', Math.max(zero, pos) + '%');
  }

  function buildSliders() {
    el.sliders.innerHTML = '';
    for (const a of ADJUSTMENTS) {
      const field = document.createElement('div');
      field.className = 'field';
      field.innerHTML = `
        <div class="field-head">
          <label for="adj-${a.key}">${a.label}</label>
          <output id="adj-${a.key}-value" for="adj-${a.key}">0</output>
        </div>
        <input type="range" id="adj-${a.key}" min="${a.min}" max="${a.max}" step="1" value="0">`;
      const input = field.querySelector('input');
      const output = field.querySelector('output');
      const show = () => {
        const v = +input.value;
        output.textContent = a.min < 0 ? formatSigned(v) : String(v);
        setFill(input);
      };
      input.addEventListener('input', () => {
        state.adjust[a.key] = +input.value;
        show();
        dirtyAdjust = true;
        requestRender();
      });
      input.addEventListener('change', commit);
      input.addEventListener('dblclick', () => {
        input.value = 0;
        state.adjust[a.key] = 0;
        show();
        dirtyAdjust = true;
        requestRender();
        commit();
      });
      input._show = show;
      el.sliders.append(field);
    }
  }

  /* ---------- Синхронизация интерфейса с состоянием ---------- */

  function syncFilters() {
    $$('.frame').forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.filter === state.filter));
    });
    el.strengthField.hidden = state.filter === 'none';
    el.strength.value = state.strength;
    el.strengthValue.textContent = state.strength;
    setFill(el.strength);
  }

  function syncSliders() {
    for (const a of ADJUSTMENTS) {
      const input = $(`#adj-${a.key}`);
      input.value = state.adjust[a.key];
      input._show();
    }
  }

  function syncRatios() {
    el.ratios.forEach((chip) => chip.setAttribute('aria-checked', String(chip.dataset.ratio === cropRatio)));
    el.cropUI.classList.toggle('is-locked', cropRatio !== 'free');
  }

  function syncUI() {
    syncFilters();
    syncSliders();
    syncRatios();
    syncTextEditor();
  }

  /* ---------- Вкладки ---------- */

  function setTab(name) {
    if (name === activeTab && !(name === 'crop' && mode !== 'crop')) return;
    const prev = activeTab;
    if (prev === 'crop' && name !== 'crop') applyCrop(false);
    if (prev === 'text' && name !== 'text') selectText(null);

    activeTab = name;
    el.tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    el.panes.forEach((p) => { p.hidden = p.dataset.pane !== name; });

    if (name === 'crop') enterCrop();
    if (name === 'filters' && thumbsDirty) requestRender();
    requestRender();
  }

  /* ---------- Обрезка ---------- */

  function orientedPreviewSize() {
    return orientedSize(preview.width, preview.height, state.m);
  }

  function enterCrop() {
    if (!source || mode === 'crop') return;
    mode = 'crop';
    pendingCrop = { ...state.crop };
    dirtyBase = true;
    el.cropUI.hidden = false;
    syncRatios();
    requestRender();
  }

  function cropChanged(a, b) {
    return ['x', 'y', 'w', 'h'].some((k) => Math.abs(a[k] - b[k]) > 0.0005);
  }

  function applyCrop(goToFilters) {
    if (mode !== 'crop') return;
    mode = 'normal';
    el.cropUI.hidden = true;
    const changed = cropChanged(pendingCrop, state.crop);
    if (changed) state.crop = { ...pendingCrop };
    dirtyBase = true;
    thumbsDirty = true;
    if (changed) commit();
    if (goToFilters) {
      if (changed) toast('Обрезка применена');
      setTab('filters');
    }
    requestRender();
  }

  function positionCropUI() {
    const r = pendingCrop;
    for (const node of [el.cropBox, el.cropShade]) {
      node.style.left = r.x * 100 + '%';
      node.style.top = r.y * 100 + '%';
      node.style.width = r.w * 100 + '%';
      node.style.height = r.h * 100 + '%';
    }
  }

  // Соотношение сторон в долях (с учётом того, что фото не квадратное)
  function normalizedRatio() {
    if (cropRatio === 'free') return null;
    const [W, H] = orientedPreviewSize();
    const px = cropRatio === 'original' ? W / H : RATIOS[cropRatio];
    return (px * H) / W;
  }

  function setRatio(name) {
    cropRatio = name;
    syncRatios();
    const a = normalizedRatio();
    if (a) {
      const cx = pendingCrop.x + pendingCrop.w / 2;
      const cy = pendingCrop.y + pendingCrop.h / 2;
      let w = Math.min(1, a);
      let h = w / a;
      if (h > 1) { h = 1; w = a; }
      pendingCrop = {
        x: clamp(cx - w / 2, 0, 1 - w),
        y: clamp(cy - h / 2, 0, 1 - h),
        w,
        h,
      };
    }
    positionCropUI();
  }

  let cropDrag = null;

  function onCropPointerDown(e) {
    if (mode !== 'crop') return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.target.closest('.crop-handle');
    const rect = el.canvas.getBoundingClientRect();
    cropDrag = {
      handle: handle ? handle.dataset.handle : 'move',
      startX: e.clientX,
      startY: e.clientY,
      start: { ...pendingCrop },
      dispW: rect.width,
      dispH: rect.height,
    };
    el.cropBox.setPointerCapture(e.pointerId);
  }

  function onCropPointerMove(e) {
    if (!cropDrag) return;
    const d = cropDrag;
    const dx = (e.clientX - d.startX) / d.dispW;
    const dy = (e.clientY - d.startY) / d.dispH;
    const s = d.start;
    const minW = Math.min(1, 40 / d.dispW);
    const minH = Math.min(1, 40 / d.dispH);

    if (d.handle === 'move') {
      pendingCrop = {
        x: clamp(s.x + dx, 0, 1 - s.w),
        y: clamp(s.y + dy, 0, 1 - s.h),
        w: s.w,
        h: s.h,
      };
      positionCropUI();
      return;
    }

    const hd = d.handle;
    let l = s.x;
    let t = s.y;
    let r = s.x + s.w;
    let b = s.y + s.h;
    if (hd.includes('w')) l = clamp(s.x + dx, 0, r - minW);
    if (hd.includes('e')) r = clamp(s.x + s.w + dx, l + minW, 1);
    if (hd.includes('n')) t = clamp(s.y + dy, 0, b - minH);
    if (hd.includes('s')) b = clamp(s.y + s.h + dy, t + minH, 1);

    const a = normalizedRatio();
    if (a && hd.length === 2) {
      // Угол двигается, противоположный угол стоит на месте
      const ax = hd.includes('w') ? s.x + s.w : s.x;
      const ay = hd.includes('n') ? s.y + s.h : s.y;
      let w = Math.max(r - l, (b - t) * a);
      const maxW = hd.includes('w') ? ax : 1 - ax;
      const maxH = hd.includes('n') ? ay : 1 - ay;
      w = Math.min(w, maxW, maxH * a);
      w = Math.max(w, Math.min(minW, maxW, maxH * a));
      const h = w / a;
      l = hd.includes('w') ? ax - w : ax;
      r = l + w;
      t = hd.includes('n') ? ay - h : ay;
      b = t + h;
    }
    pendingCrop = { x: l, y: t, w: r - l, h: b - t };
    positionCropUI();
  }

  function onCropPointerUp() {
    cropDrag = null;
  }

  /* ---------- Поворот и отражение ---------- */

  function applyOrientation(opName) {
    if (!source) return;
    state.m = multiply(OPS[opName], state.m);
    state.crop = transformRect(state.crop, opName);
    if (mode === 'crop') {
      pendingCrop = transformRect(pendingCrop, opName);
      if (cropRatio !== 'free') setRatio(cropRatio);
    }
    dirtyBase = true;
    thumbsDirty = true;
    commit();
    requestRender();
  }

  /* ---------- Работа с надписями ---------- */

  function selectedText() {
    return state.texts.find((t) => t.id === selectedTextId) || null;
  }

  function selectText(id) {
    if (selectedTextId && selectedTextId !== id) {
      // Пустые надписи удаляем, чтобы они не мешали
      const prev = selectedText();
      if (prev && !prev.text.trim()) {
        state.texts = state.texts.filter((t) => t.id !== prev.id);
        commit();
      }
    }
    selectedTextId = id;
    syncTextEditor();
    requestRender();
  }

  function buildTextControls() {
    el.fontGrid.innerHTML = '';
    for (const f of FONTS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'font-chip';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.dataset.font = f.id;
      b.textContent = f.name;
      b.style.fontFamily = `"${f.family}", sans-serif`;
      b.style.fontWeight = f.weight;
      b.addEventListener('click', () => updateText({ font: f.id }, true));
      el.fontGrid.append(b);
    }

    el.swatches.innerHTML = '';
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.setAttribute('aria-label', c.name);
      b.title = c.name;
      b.dataset.color = c.value;
      b.style.setProperty('--c', c.value);
      b.addEventListener('click', () => updateText({ color: c.value }, true));
      el.swatches.append(b);
    }
    const custom = document.createElement('label');
    custom.className = 'swatch swatch-custom';
    custom.title = 'Свой цвет';
    custom.setAttribute('role', 'radio');
    custom.setAttribute('aria-checked', 'false');
    custom.innerHTML = '<input type="color" aria-label="Выбрать свой цвет" value="#ffffff">';
    const picker = custom.querySelector('input');
    picker.addEventListener('input', () => updateText({ color: picker.value }, false));
    picker.addEventListener('change', commit);
    el.swatches.append(custom);
  }

  function updateText(changes, save) {
    const t = selectedText();
    if (!t) return;
    Object.assign(t, changes);
    if (changes.font) ensureFont(fontOf(t), t.text);
    syncTextEditor();
    requestRender();
    if (save) commit();
  }

  function syncTextEditor() {
    const t = selectedText();
    el.textEditor.hidden = !t;
    el.textHint.hidden = !!t;
    if (!t) return;
    if (document.activeElement !== el.textInput) el.textInput.value = t.text;
    $$('.font-chip').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.font === t.font)));
    el.textSize.value = t.size;
    el.textSizeValue.textContent = t.size;
    setFill(el.textSize);
    let matched = false;
    $$('#swatches .swatch[data-color]').forEach((b) => {
      const on = b.dataset.color.toLowerCase() === t.color.toLowerCase();
      if (on) matched = true;
      b.setAttribute('aria-checked', String(on));
    });
    const custom = $('.swatch-custom');
    custom.setAttribute('aria-checked', String(!matched));
    custom.querySelector('input').value = t.color;
    el.textStyle.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.style === t.style)));
  }

  function addText() {
    if (!source) return;
    let y = 0.5;
    while (state.texts.some((t) => Math.abs(t.x - 0.5) < 0.01 && Math.abs(t.y - y) < 0.01) && y < 0.9) y += 0.1;
    const t = {
      id: uid(),
      text: 'Ваш текст',
      x: 0.5,
      y,
      size: 40,
      font: 'montserrat',
      color: '#ffffff',
      style: 'outline',
    };
    state.texts.push(t);
    ensureFont(fontOf(t), t.text);
    selectText(t.id);
    commit();
    el.textInput.value = t.text;
    el.textInput.focus();
    el.textInput.select();
  }

  function deleteSelectedText() {
    if (!selectedTextId) return;
    state.texts = state.texts.filter((t) => t.id !== selectedTextId);
    selectedTextId = null;
    syncTextEditor();
    requestRender();
    commit();
  }

  function canvasPoint(e) {
    const rect = el.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * el.canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * el.canvas.height) / rect.height,
    };
  }

  function hitText(p) {
    for (let i = state.texts.length - 1; i >= 0; i--) {
      const t = state.texts[i];
      const b = textBoxes.get(t.id);
      if (b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return t;
    }
    return null;
  }

  let textDrag = null;

  function onCanvasPointerDown(e) {
    if (!source || mode === 'crop' || comparing) return;
    const p = canvasPoint(e);
    const t = hitText(p);
    if (t) {
      e.preventDefault();
      if (activeTab !== 'text') setTab('text');
      selectText(t.id);
      textDrag = { id: t.id, sx: p.x, sy: p.y, ox: t.x, oy: t.y, moved: false };
      el.canvas.setPointerCapture(e.pointerId);
      el.app.classList.add('is-dragging-text');
    } else if (selectedTextId) {
      selectText(null);
    }
  }

  function onCanvasPointerMove(e) {
    if (!source || mode === 'crop') return;
    const p = canvasPoint(e);
    if (textDrag) {
      const t = state.texts.find((x) => x.id === textDrag.id);
      if (!t) return;
      t.x = clamp(textDrag.ox + (p.x - textDrag.sx) / el.canvas.width, 0, 1);
      t.y = clamp(textDrag.oy + (p.y - textDrag.sy) / el.canvas.height, 0, 1);
      textDrag.moved = true;
      requestRender();
    } else if (e.pointerType === 'mouse') {
      el.app.classList.toggle('is-over-text', !!hitText(p));
    }
  }

  function onCanvasPointerUp() {
    if (textDrag && textDrag.moved) commit();
    textDrag = null;
    el.app.classList.remove('is-dragging-text');
  }

  /* ---------- Сохранение ---------- */

  let exportCanvas = null;
  let exportBlob = null;
  let exportFormat = 'jpeg';
  let blobTimer = null;
  let blobJob = 0;

  async function renderFullSize() {
    await Promise.all(state.texts.map((t) =>
      document.fonts.load(fontString(fontOf(t), 40), t.text || 'А').catch(() => {})));

    const sw = source.naturalWidth;
    const sh = source.naturalHeight;
    const [W, H] = orientedSize(sw, sh, state.m);
    const cw = state.crop.w * W;
    const ch = state.crop.h * H;
    const scale = Math.min(1, Math.sqrt(EXPORT_MAX_PIXELS / (cw * ch)));
    const out = makeCanvas(cw * scale, ch * scale);
    const octx = out.getContext('2d', { willReadFrequently: true });
    drawTransformed(octx, source, sw, sh, state.m, state.crop.x * W, state.crop.y * H, scale);
    applyLook(out, paramsFor(state.filter, state.strength, state.adjust));
    drawTexts(octx, out.width, out.height, state.texts, { export: true });
    return out;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('blob'))), type, quality);
    });
  }

  function fileName() {
    return `${fileBaseName}-kadr.${exportFormat === 'png' ? 'png' : 'jpg'}`;
  }

  async function prepareBlob() {
    if (!exportCanvas) return;
    const job = ++blobJob;
    el.btnDownload.disabled = true;
    el.btnShare.disabled = true;
    el.saveInfo.textContent = 'Готовим файл…';
    try {
      const type = exportFormat === 'png' ? 'image/png' : 'image/jpeg';
      const blob = await canvasToBlob(exportCanvas, type, +el.quality.value / 100);
      if (job !== blobJob) return;
      exportBlob = blob;
      el.saveInfo.innerHTML =
        `Размер в пикселях: <strong>${exportCanvas.width} × ${exportCanvas.height}</strong><br>` +
        `Вес файла: <strong>около ${formatBytes(blob.size)}</strong>`;
      el.btnDownload.disabled = false;
      el.btnShare.disabled = false;
    } catch (e) {
      if (job !== blobJob) return;
      el.saveInfo.textContent = 'Не получилось подготовить файл. Попробуйте формат JPG или уменьшите качество.';
    }
  }

  function schedulePrepareBlob() {
    clearTimeout(blobTimer);
    blobTimer = setTimeout(prepareBlob, 200);
  }

  async function openSaveDialog() {
    if (!source) return;
    if (mode === 'crop') applyCrop(false);
    exportCanvas = null;
    exportBlob = null;
    el.btnDownload.disabled = true;
    el.btnShare.disabled = true;
    el.saveInfo.textContent = 'Готовим фото…';
    el.btnShare.hidden = !canShareFiles();
    if (typeof el.saveDialog.showModal === 'function') el.saveDialog.showModal();
    else el.saveDialog.setAttribute('open', '');
    await new Promise((r) => setTimeout(r, 30)); // даём окну появиться
    try {
      exportCanvas = await renderFullSize();
      await prepareBlob();
    } catch (e) {
      el.saveInfo.textContent = 'Не получилось подготовить фото. Попробуйте ещё раз.';
    }
  }

  function closeSaveDialog() {
    if (el.saveDialog.open) el.saveDialog.close();
  }

  function canShareFiles() {
    try {
      const test = new File([new Blob(['x'], { type: 'image/jpeg' })], 'test.jpg', { type: 'image/jpeg' });
      return !!(navigator.canShare && navigator.canShare({ files: [test] }));
    } catch (e) {
      return false;
    }
  }

  function setFormat(format) {
    exportFormat = format;
    el.format.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.format === format)));
    el.qualityField.hidden = format === 'png';
    el.formatHint.textContent = format === 'png'
      ? 'PNG сохраняет фото без потери качества, но файл весит больше.'
      : 'JPG весит меньше и подходит для соцсетей и мессенджеров.';
    schedulePrepareBlob();
  }

  function download() {
    if (!exportBlob) return;
    const url = URL.createObjectURL(exportBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName();
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    closeSaveDialog();
    toast('Фото скачано');
  }

  async function share() {
    if (!exportBlob) return;
    const file = new File([exportBlob], fileName(), { type: exportBlob.type });
    try {
      await navigator.share({ files: [file] });
      closeSaveDialog();
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('Не получилось поделиться. Попробуйте скачать фото.', true);
    }
  }

  /* ---------- Подключаем события ---------- */

  function bindEvents() {
    // Открытие фото
    el.btnPick.addEventListener('click', () => el.fileInput.click());
    el.btnOpen.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', () => {
      const f = el.fileInput.files && el.fileInput.files[0];
      el.fileInput.value = '';
      loadFile(f);
    });

    // Перетаскивание файла на страницу
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      el.stage.classList.add('is-dragover');
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) el.stage.classList.remove('is-dragover');
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      el.stage.classList.remove('is-dragover');
      loadFile(e.dataTransfer.files[0]);
    });

    // Вставка из буфера обмена
    window.addEventListener('paste', (e) => {
      const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
      const item = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
      if (!item) return;
      e.preventDefault();
      const blob = item.getAsFile();
      if (blob) loadFile(new File([blob], 'photo.png', { type: blob.type }));
    });

    // Отмена и повтор
    el.btnUndo.addEventListener('click', undo);
    el.btnRedo.addEventListener('click', redo);

    // До и после: показываем оригинал, пока кнопка зажата
    const startCompare = () => {
      if (!source || comparing) return;
      comparing = true;
      el.compareBadge.hidden = false;
      el.btnCompare.classList.add('is-active');
      requestRender();
    };
    const stopCompare = () => {
      if (!comparing) return;
      comparing = false;
      el.compareBadge.hidden = true;
      el.btnCompare.classList.remove('is-active');
      requestRender();
    };
    el.btnCompare.addEventListener('pointerdown', (e) => { e.preventDefault(); startCompare(); });
    el.btnCompare.addEventListener('pointerup', stopCompare);
    el.btnCompare.addEventListener('pointerleave', stopCompare);
    el.btnCompare.addEventListener('pointercancel', stopCompare);
    el.btnCompare.addEventListener('contextmenu', (e) => e.preventDefault());
    el.btnCompare.addEventListener('keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startCompare(); }
    });
    el.btnCompare.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') stopCompare();
    });
    el.btnCompare.addEventListener('blur', stopCompare);

    // Вкладки
    el.tabs.forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

    // Сила фильтра
    el.strength.addEventListener('input', () => {
      state.strength = +el.strength.value;
      el.strengthValue.textContent = state.strength;
      setFill(el.strength);
      dirtyAdjust = true;
      requestRender();
    });
    el.strength.addEventListener('change', commit);

    // Сброс настроек
    el.btnResetAdjust.addEventListener('click', () => {
      state.adjust = { ...ZERO_ADJUST };
      syncSliders();
      dirtyAdjust = true;
      requestRender();
      commit();
    });

    // Обрезка и поворот
    el.btnRotLeft.addEventListener('click', () => applyOrientation('rotLeft'));
    el.btnRotRight.addEventListener('click', () => applyOrientation('rotRight'));
    el.btnFlipH.addEventListener('click', () => applyOrientation('flipH'));
    el.btnFlipV.addEventListener('click', () => applyOrientation('flipV'));
    el.ratios.forEach((chip) => chip.addEventListener('click', () => setRatio(chip.dataset.ratio)));
    el.btnCropReset.addEventListener('click', () => {
      pendingCrop = { x: 0, y: 0, w: 1, h: 1 };
      cropRatio = 'free';
      syncRatios();
      positionCropUI();
    });
    el.btnCropApply.addEventListener('click', () => applyCrop(true));
    el.cropBox.addEventListener('pointerdown', onCropPointerDown);
    el.cropBox.addEventListener('pointermove', onCropPointerMove);
    el.cropBox.addEventListener('pointerup', onCropPointerUp);
    el.cropBox.addEventListener('pointercancel', onCropPointerUp);

    // Надписи
    el.btnAddText.addEventListener('click', addText);
    el.btnDeleteText.addEventListener('click', deleteSelectedText);
    el.textInput.addEventListener('input', () => {
      const t = selectedText();
      if (!t) return;
      t.text = el.textInput.value;
      ensureFont(fontOf(t), t.text);
      requestRender();
    });
    el.textInput.addEventListener('change', commit);
    el.textSize.addEventListener('input', () => updateText({ size: +el.textSize.value }, false));
    el.textSize.addEventListener('change', commit);
    el.textStyle.forEach((b) => b.addEventListener('click', () => updateText({ style: b.dataset.style }, true)));

    el.canvas.addEventListener('pointerdown', onCanvasPointerDown);
    el.canvas.addEventListener('pointermove', onCanvasPointerMove);
    el.canvas.addEventListener('pointerup', onCanvasPointerUp);
    el.canvas.addEventListener('pointercancel', onCanvasPointerUp);
    el.canvas.addEventListener('pointerleave', () => el.app.classList.remove('is-over-text'));
    el.canvas.addEventListener('dblclick', (e) => {
      const t = hitText(canvasPoint(e));
      if (!t) return;
      el.textInput.focus();
      el.textInput.select();
    });

    // Сохранение
    el.btnSave.addEventListener('click', openSaveDialog);
    el.btnSaveClose.addEventListener('click', closeSaveDialog);
    el.saveDialog.addEventListener('close', () => {
      exportCanvas = null;
      exportBlob = null;
      blobJob++;
    });
    el.saveDialog.addEventListener('click', (e) => {
      if (e.target === el.saveDialog) closeSaveDialog(); // клик по затемнению вокруг окна
    });
    el.format.forEach((b) => b.addEventListener('click', () => setFormat(b.dataset.format)));
    el.quality.addEventListener('input', () => {
      el.qualityValue.textContent = el.quality.value + '\u00a0%';
      setFill(el.quality);
      schedulePrepareBlob();
    });
    el.btnDownload.addEventListener('click', download);
    el.btnShare.addEventListener('click', share);

    // Горячие клавиши
    window.addEventListener('keydown', (e) => {
      if (!source || el.saveDialog.open) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && (key === 'z' || key === 'я') && !isTyping()) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if (mod && (key === 'y' || key === 'н') && !isTyping()) {
        e.preventDefault();
        redo();
      } else if (mod && (key === 's' || key === 'ы')) {
        e.preventDefault();
        openSaveDialog();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTextId && !isTyping()) {
        e.preventDefault();
        deleteSelectedText();
      } else if (e.key === 'Escape' && selectedTextId && !isTyping()) {
        selectText(null);
      }
    });

    // Предупреждение, если закрыть вкладку с несохранёнными правками
    window.addEventListener('beforeunload', (e) => {
      if (source && historyIndex > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Подстраиваем размер фото, когда меняется размер окна
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => fitCanvas()).observe(el.stage);
    } else {
      window.addEventListener('resize', fitCanvas);
    }
  }

  /* ---------- Запуск ---------- */

  buildFilmstrip();
  buildSliders();
  buildTextControls();
  bindEvents();
  setFill(el.strength);
  setFill(el.textSize);
  setFill(el.quality);
  syncFilters();

  // Для проверки и отладки из консоли браузера
  window.kadr = { loadFile, getState: () => state };
})();
