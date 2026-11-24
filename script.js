/* ==========================================================
   Кадр — фоторедактор, который работает прямо в браузере.
   Фото никуда не отправляется: вся обработка идёт на устройстве.

   Как устроено:
   1. state — описание всех правок (фильтр, ползунки, обрезка, текст…).
      Исходное фото не меняется, поэтому любую правку можно отменить.
   2. Чтобы показать результат, программа берёт исходное фото
      и заново применяет к нему все правки из state.
   3. При сохранении то же самое делается с фото в полном размере.
   4. ИИ-инструменты (ластик и удаление фона) работают через
      библиотеку ONNX Runtime прямо в браузере. Модели скачиваются
      один раз при первом запуске, само фото никуда не уходит.
   ========================================================== */
'use strict';

(() => {

  /* ---------- Настройки ---------- */

  const PREVIEW_MAX = 1600;           // максимальная сторона фото на экране (для скорости)
  const EXPORT_MAX_PIXELS = 16000000; // ограничение для iPhone: больше 16 Мп Safari не сохранит
  const MASK_MAX = 2048;              // размер маски фона
  const THUMB_SIZE = 140;             // размер миниатюр фильтров
  const HISTORY_LIMIT = 60;           // сколько шагов можно отменить

  const ORT_VERSION = '1.31.1';
  const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
  const MODELS = {
    eraser: {
      // MI-GAN, Picsart AI Research, лицензия MIT
      url: 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
      sizeMb: 28,
    },
    background: {
      // ORMBG, лицензия Apache 2.0
      url: 'https://huggingface.co/onnx-community/ormbg-ONNX/resolve/main/onnx/model_quantized.onnx',
      sizeMb: 44,
    },
  };

  const ADJUST_GROUPS = [
    {
      title: 'Свет',
      items: [
        { key: 'exposure', label: 'Экспозиция', min: -100, max: 100 },
        { key: 'brightness', label: 'Яркость', min: -100, max: 100 },
        { key: 'contrast', label: 'Контраст', min: -100, max: 100 },
        { key: 'highlights', label: 'Светлые участки', min: -100, max: 100 },
        { key: 'shadows', label: 'Тени', min: -100, max: 100 },
      ],
    },
    {
      title: 'Цвет',
      items: [
        { key: 'saturation', label: 'Насыщенность', min: -100, max: 100 },
        { key: 'warmth', label: 'Теплота', min: -100, max: 100 },
        { key: 'tint', label: 'Оттенок', min: -100, max: 100 },
        { key: 'fade', label: 'Выцветание', min: 0, max: 100 },
      ],
    },
    {
      title: 'Эффекты',
      items: [
        { key: 'sharpness', label: 'Резкость', min: 0, max: 100 },
        { key: 'grain', label: 'Зерно', min: 0, max: 100 },
        { key: 'blur', label: 'Размытие', min: 0, max: 100 },
        { key: 'vignette', label: 'Виньетка', min: 0, max: 100 },
      ],
    },
  ];
  const ADJUSTMENTS = ADJUST_GROUPS.flatMap((g) => g.items);

  // Каждый фильтр — это набор готовых значений ползунков
  const FILTERS = [
    { id: 'none', name: 'Оригинал', p: {} },
    { id: 'vivid', name: 'Яркий', p: { saturation: 45, contrast: 15 } },
    { id: 'warm', name: 'Тёплый', p: { warmth: 35, saturation: 10, brightness: 3 } },
    { id: 'cold', name: 'Холодный', p: { warmth: -35, contrast: 6 } },
    { id: 'film', name: 'Плёнка', p: { fade: 45, warmth: 10, contrast: 12, saturation: -12 } },
    { id: 'cinema', name: 'Кино', p: { contrast: 22, saturation: -10, warmth: 12, fade: 25, vignette: 28 } },
    { id: 'vintage', name: 'Винтаж', p: { sepia: 0.3, fade: 60, contrast: -6, saturation: -20, warmth: 15, vignette: 35 } },
    { id: 'pastel', name: 'Пастель', p: { fade: 70, saturation: -18, brightness: 10, contrast: -15 } },
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
  const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

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
  const FRAME_COLORS = [
    { value: '#ffffff', name: 'Белый' },
    { value: '#111111', name: 'Чёрный' },
    { value: '#f3ead8', name: 'Кремовый' },
    { value: '#ffc53d', name: 'Жёлтый' },
    { value: '#ff7ac6', name: 'Розовый' },
    { value: '#4da3ff', name: 'Синий' },
    { value: '#3ddc84', name: 'Зелёный' },
    { value: '#9b6bff', name: 'Фиолетовый' },
  ];

  const STICKERS = [
    '😀', '😂', '😍', '🥰', '😎', '🤩', '😜', '🥳', '😇', '🤔', '😱', '😭',
    '👍', '👏', '🙌', '💪', '✌️', '🤘', '❤️', '🧡', '💛', '💚', '💙', '💜',
    '💖', '🔥', '✨', '⭐', '🌟', '⚡', '🌈', '☀️', '🌙', '☁️', '🌸', '🌹',
    '🌴', '🍀', '🍕', '🍔', '🍩', '☕', '🎉', '🎈', '🎁', '🎵', '📸', '🚀',
    '👑', '💎', '🐶', '🐱', '🦋', '👀', '💯', '✅',
  ];

  const RATIOS = { '1:1': 1, '4:5': 4 / 5, '9:16': 9 / 16, '16:9': 16 / 9 };
  const FULL = { x: 0, y: 0, w: 1, h: 1 };

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
    badge: $('#stage-badge'),
    tabs: $$('.tab'),
    panes: $$('.pane'),
    filmstrip: $('#filmstrip'),
    strengthField: $('#strength-field'),
    strength: $('#strength'),
    strengthValue: $('#strength-value'),
    sliders: $('#sliders'),
    btnAuto: $('#btn-auto'),
    btnResetAdjust: $('#btn-reset-adjust'),
    cropUI: $('#crop-ui'),
    cropBox: $('#crop-box'),
    cropShade: $('#crop-shade'),
    ratios: $$('#ratios .chip'),
    angle: $('#angle'),
    angleValue: $('#angle-value'),
    btnRotLeft: $('#btn-rot-left'),
    btnRotRight: $('#btn-rot-right'),
    btnFlipH: $('#btn-flip-h'),
    btnFlipV: $('#btn-flip-v'),
    btnCropReset: $('#btn-crop-reset'),
    btnCropApply: $('#btn-crop-apply'),
    aiMode: $$('#ai-mode button'),
    aiErase: $('#ai-erase'),
    aiBg: $('#ai-bg'),
    eraseSize: $('#erase-size'),
    eraseSizeValue: $('#erase-size-value'),
    btnEraseClear: $('#btn-erase-clear'),
    btnEraseRun: $('#btn-erase-run'),
    btnBgRun: $('#btn-bg-run'),
    bgHint: $('#bg-hint'),
    bgOptions: $('#bg-options'),
    bgMode: $$('#bg-mode button'),
    bgColorField: $('#bg-color-field'),
    bgSwatches: $('#bg-swatches'),
    bgBlurField: $('#bg-blur-field'),
    bgBlur: $('#bg-blur'),
    bgBlurValue: $('#bg-blur-value'),
    aiStatus: $('#ai-status'),
    aiStatusText: $('#ai-status-text'),
    aiProgress: $('#ai-progress'),
    btnAddText: $('#btn-add-text'),
    textHint: $('#text-hint'),
    textEditor: $('#text-editor'),
    textInput: $('#text-input'),
    fontGrid: $('#font-grid'),
    textSize: $('#text-size'),
    textSizeValue: $('#text-size-value'),
    textRotation: $('#text-rotation'),
    textRotationValue: $('#text-rotation-value'),
    swatches: $('#swatches'),
    textStyle: $$('#text-style button'),
    btnDeleteText: $('#btn-delete-text'),
    stickerGrid: $('#sticker-grid'),
    stickerHint: $('#sticker-hint'),
    stickerEditor: $('#sticker-editor'),
    stickerSize: $('#sticker-size'),
    stickerSizeValue: $('#sticker-size-value'),
    stickerRotation: $('#sticker-rotation'),
    stickerRotationValue: $('#sticker-rotation-value'),
    btnDeleteSticker: $('#btn-delete-sticker'),
    drawSwatches: $('#draw-swatches'),
    drawSize: $('#draw-size'),
    drawSizeValue: $('#draw-size-value'),
    btnDrawClear: $('#btn-draw-clear'),
    frameStyle: $$('#frame-style button'),
    frameWidth: $('#frame-width'),
    frameWidthValue: $('#frame-width-value'),
    frameSwatches: $('#frame-swatches'),
    frameRadius: $('#frame-radius'),
    frameRadiusValue: $('#frame-radius-value'),
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

  function zeroAdjust() {
    const a = {};
    for (const item of ADJUSTMENTS) a[item.key] = 0;
    return a;
  }

  function defaultState() {
    return {
      m: [1, 0, 0, 1],                    // поворот и отражение
      angle: 0,                           // наклон в градусах
      crop: { ...FULL },                  // обрезка в долях от размера фото
      filter: 'none',
      strength: 100,
      adjust: zeroAdjust(),
      patches: 0,                         // сколько раз сработал ИИ-ластик
      bg: { mask: -1, mode: 'none', color: '#ffffff', blur: 60 },
      items: [],                          // надписи и стикеры
      strokes: [],                        // рисунок кистью
      frame: { style: 'even', width: 0, color: '#ffffff', radius: 0 },
    };
  }

  let state = defaultState();
  let history = [];
  let historyIndex = -1;

  let original = null;        // исходное фото
  let srcW = 0;
  let srcH = 0;
  let workSource = null;      // фото с правками ИИ-ластика (полный размер)
  let appliedPatches = 0;
  let patchList = [];         // куски фото, исправленные ластиком
  let maskList = [];          // маски фона от ИИ
  let preview = null;         // уменьшенная копия для быстрого показа на экране
  let originalPreview = null; // уменьшенная копия исходника (для «До и после»)
  let fileBaseName = 'photo';

  let mode = 'normal';        // 'normal' или 'crop'
  let activeTab = 'filters';
  let aiTool = 'erase';
  let comparing = false;
  let aiBusy = false;
  let selectedId = null;
  let pendingCrop = null;
  let cropRatio = 'free';

  let eraseStrokes = [];      // то, что закрашено для ИИ-ластика
  let liveStroke = null;      // линия, которую сейчас рисуют
  let brushHover = null;
  let drawColor = '#ff4d4d';

  // Промежуточные результаты, чтобы не пересчитывать всё при каждом движении
  let baseCanvas = null;      // фото после поворота и обрезки
  let baseData = null;
  let maskBase = null;        // маска фона в тех же координатах
  let adjustedCanvas = null;  // фото после фильтров и настроек
  let dirtyBase = true;
  let dirtyAdjust = true;
  let thumbsDirty = true;
  let layout = { ox: 0, oy: 0, w: 1, h: 1 };
  let itemBoxes = new Map();

  const loadedFonts = new Set();
  const loadingFonts = new Set();

  /* ---------- Вспомогательные функции ---------- */

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

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

  function formatDegrees(v) {
    const n = Math.round(v * 10) / 10;
    const text = String(Math.abs(n)).replace('.', ',');
    if (n > 0) return '+' + text + '°';
    if (n < 0) return '−' + text + '°';
    return '0°';
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' КБ';
    return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
  }

  let toastTimer = null;
  function toast(message, isError = false) {
    el.toast.textContent = message;
    el.toast.classList.toggle('is-error', isError);
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), isError ? 5000 : 2800);
  }

  function isTyping() {
    const a = document.activeElement;
    return a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'range'));
  }

  function setRadio(buttons, attr, value) {
    buttons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset[attr] === value)));
  }

  function setFill(input) {
    const min = +input.min;
    const max = +input.max;
    const v = +input.value;
    const pos = ((v - min) / (max - min)) * 100;
    const zero = min < 0 ? ((0 - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fs', Math.min(zero, pos) + '%');
    input.style.setProperty('--fe', Math.max(zero, pos) + '%');
  }

  /* ---------- Матрицы преобразований ---------- */
  // Матрица [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f

  const mT = (x, y) => [1, 0, 0, 1, x, y];
  const mS = (s) => [s, 0, 0, s, 0, 0];
  const mR = (deg) => {
    const r = (deg * Math.PI) / 180;
    return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
  };

  function mMul(A, B) {
    return [
      A[0] * B[0] + A[2] * B[1],
      A[1] * B[0] + A[3] * B[1],
      A[0] * B[2] + A[2] * B[3],
      A[1] * B[2] + A[3] * B[3],
      A[0] * B[4] + A[2] * B[5] + A[4],
      A[1] * B[4] + A[3] * B[5] + A[5],
    ];
  }

  function mChain(...ms) {
    return ms.reduce((acc, m) => mMul(acc, m));
  }

  function mInv(A) {
    const det = A[0] * A[3] - A[1] * A[2];
    return [
      A[3] / det, -A[1] / det, -A[2] / det, A[0] / det,
      (A[2] * A[5] - A[3] * A[4]) / det,
      (A[1] * A[4] - A[0] * A[5]) / det,
    ];
  }

  const mApply = (A, x, y) => [A[0] * x + A[2] * y + A[4], A[1] * x + A[3] * y + A[5]];

  function orientedSize(w, h, m) {
    return m[0] !== 0 ? [w, h] : [h, w];
  }

  // Во сколько раз увеличить фото при наклоне, чтобы не было пустых углов
  function coverScale(W, H, deg) {
    if (!deg) return 1;
    const t = (Math.abs(deg) * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    return Math.max((W * c + H * s) / W, (W * s + H * c) / H);
  }

  // Матрица: пиксели картинки iw×ih → пиксели результата (с поворотом, наклоном, обрезкой)
  function frameMatrix(st, iw, ih, scale, useCrop) {
    const [W, H] = orientedSize(iw, ih, st.m);
    const crop = useCrop ? st.crop : FULL;
    return mChain(
      mS(scale),
      mT(-crop.x * W, -crop.y * H),
      mT(W / 2, H / 2),
      mR(st.angle),
      mS(coverScale(W, H, st.angle)),
      [st.m[0], st.m[1], st.m[2], st.m[3], 0, 0],
      mT(-iw / 2, -ih / 2),
    );
  }

  function frameSize(st, iw, ih, scale, useCrop) {
    const [W, H] = orientedSize(iw, ih, st.m);
    const crop = useCrop ? st.crop : FULL;
    return [Math.max(1, Math.round(crop.w * W * scale)), Math.max(1, Math.round(crop.h * H * scale))];
  }

  function drawWithMatrix(context, img, M) {
    context.save();
    context.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(img, 0, 0);
    context.restore();
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
    state = JSON.parse(snap);
    if (state.patches !== appliedPatches) rebuildSource();
    dirtyBase = true;
    thumbsDirty = true;
    if (mode === 'crop') pendingCrop = { ...state.crop };
    if (selectedId && !state.items.some((t) => t.id === selectedId)) selectedId = null;
    syncUI();
    requestRender();
    updateHistoryButtons();
  }

  function undo() {
    if (historyIndex <= 0 || aiBusy) return;
    historyIndex--;
    restore(history[historyIndex]);
  }

  function redo() {
    if (historyIndex >= history.length - 1 || aiBusy) return;
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

  function makePreview(img) {
    const scale = Math.min(1, PREVIEW_MAX / Math.max(srcW, srcH));
    const c = makeCanvas(srcW * scale, srcH * scale);
    const cctx = c.getContext('2d');
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  function currentSource() {
    return workSource || original;
  }

  // Собирает фото с правками ластика (нужно после отмены и повтора)
  function rebuildSource() {
    const n = state.patches;
    if (n === 0) {
      workSource = null;
    } else {
      workSource = makeCanvas(srcW, srcH);
      const wctx = workSource.getContext('2d');
      wctx.drawImage(original, 0, 0);
      for (let i = 0; i < n && i < patchList.length; i++) {
        wctx.drawImage(patchList[i].canvas, patchList[i].x, patchList[i].y);
      }
    }
    appliedPatches = n;
    preview = makePreview(currentSource());
  }

  async function loadFile(file) {
    if (!file || aiBusy) return;
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

    original = img;
    srcW = img.naturalWidth;
    srcH = img.naturalHeight;
    workSource = null;
    appliedPatches = 0;
    patchList = [];
    maskList = [];
    preview = makePreview(img);
    originalPreview = preview;
    fileBaseName = ((file.name || '').replace(/\.[^.]+$/, '') || 'photo').slice(0, 60);

    state = defaultState();
    history = [];
    historyIndex = -1;
    commit();

    selectedId = null;
    mode = 'normal';
    pendingCrop = null;
    cropRatio = 'free';
    eraseStrokes = [];
    liveStroke = null;
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

  /* ---------- Обработка пикселей ---------- */

  function paramsFor(filterId, strength, adjust) {
    const f = FILTERS.find((x) => x.id === filterId) || FILTERS[0];
    const k = strength / 100;
    const p = f.p;
    const a = adjust;
    const add = (key) => (p[key] || 0) * k + (a[key] || 0);
    return {
      exposure: add('exposure'),
      brightness: add('brightness'),
      contrast: add('contrast'),
      highlights: add('highlights'),
      shadows: add('shadows'),
      saturation: add('saturation'),
      warmth: add('warmth'),
      tint: add('tint'),
      fade: Math.min(100, add('fade')),
      grayscale: (p.grayscale || 0) * k,
      sepia: (p.sepia || 0) * k,
      sharpness: a.sharpness || 0,
      grain: a.grain || 0,
      blur: a.blur || 0,
      vignette: Math.min(100, add('vignette')),
    };
  }

  function needsColorWork(p) {
    return p.exposure || p.brightness || p.contrast || p.highlights || p.shadows ||
      p.saturation || p.warmth || p.tint || p.fade || p.grayscale || p.sepia;
  }

  // Таблицы «было → стало» для каждого канала: так обработка идёт быстрее
  function buildTables(p) {
    const R = new Uint8ClampedArray(256);
    const G = new Uint8ClampedArray(256);
    const B = new Uint8ClampedArray(256);
    const ev = Math.pow(2, (clamp(p.exposure, -100, 100) / 100) * 1.5);
    const bri = clamp(p.brightness, -100, 100) / 100;
    const con = clamp(p.contrast, -100, 100) / 100;
    const C = con >= 0 ? 1 + con * 1.2 : 1 + con * 0.75;
    const hi = clamp(p.highlights, -100, 100) / 100;
    const sh = clamp(p.shadows, -100, 100) / 100;
    const fade = clamp(p.fade, 0, 100) / 100;
    const warm = clamp(p.warmth, -100, 100);
    const tint = clamp(p.tint, -100, 100);

    for (let v = 0; v < 256; v++) {
      let x = v * ev;
      x = bri > 0 ? x + (255 - x) * bri * 0.6 : x * (1 + bri * 0.6);
      x = (x - 128) * C + 128;
      x = clamp(x, 0, 255);
      const t = x / 255;
      if (sh) x += sh * 90 * (1 - t) * (1 - t) * t * 2.2;
      if (hi) x += hi * 90 * t * t * (1 - t) * 2.2 + (hi < 0 ? hi * 18 * t * t * t : 0);
      x = clamp(x, 0, 255);
      if (fade) x = x + fade * 60 * (1 - x / 255) - fade * 22 * (x / 255);
      R[v] = x + warm * 0.32 + tint * 0.12;
      G[v] = x + warm * 0.06 - tint * 0.22;
      B[v] = x - warm * 0.32 + tint * 0.12;
    }
    return { R, G, B };
  }

  function processColors(d, p) {
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
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let k = -r; k <= r; k++) {
        const idx = start + clamp(k, 0, inner - 1) * step;
        sr += src[idx]; sg += src[idx + 1]; sb += src[idx + 2]; sa += src[idx + 3];
      }
      for (let i = 0; i < inner; i++) {
        const idx = start + i * step;
        dst[idx] = sr * inv;
        dst[idx + 1] = sg * inv;
        dst[idx + 2] = sb * inv;
        dst[idx + 3] = sa * inv;
        const addIdx = i + r + 1 < inner ? start + (i + r + 1) * step : last;
        const subIdx = i - r > 0 ? start + (i - r) * step : start;
        sr += src[addIdx] - src[subIdx];
        sg += src[addIdx + 1] - src[subIdx + 1];
        sb += src[addIdx + 2] - src[subIdx + 2];
        sa += src[addIdx + 3] - src[subIdx + 3];
      }
    }
  }

  function blurArray(data, w, h, sigma) {
    if (sigma < 0.5) return;
    const tmp = new Uint8ClampedArray(data.length);
    for (const size of boxSizes(sigma, 3)) {
      const r = (size - 1) / 2;
      if (r < 1) continue;
      blurPass(data, tmp, w, h, r, true);
      blurPass(tmp, data, w, h, r, false);
    }
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
      blurArray(data.data, w, h, sigma);
      c.putImageData(data, 0, 0);
      return;
    }
    const small = makeCanvas(w / k, h / k);
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(canvas, 0, 0, small.width, small.height);
    const data = sctx.getImageData(0, 0, small.width, small.height);
    blurArray(data.data, small.width, small.height, sigma / k);
    sctx.putImageData(data, 0, 0);
    c.save();
    c.globalCompositeOperation = 'copy';
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(small, 0, 0, w, h);
    c.restore();
  }

  function sharpen(d, w, h, amount) {
    const sigma = Math.max(0.7, Math.min(w, h) * 0.0012);
    const blurred = new Uint8ClampedArray(d);
    blurArray(blurred, w, h, sigma);
    const k = (amount / 100) * 1.6;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i] + k * (d[i] - blurred[i]);
      d[i + 1] = d[i + 1] + k * (d[i + 1] - blurred[i + 1]);
      d[i + 2] = d[i + 2] + k * (d[i + 2] - blurred[i + 2]);
    }
  }

  // Плёночное зерно: случайный шум, который всегда одинаков для одного фото
  function addGrain(d, w, h, amount) {
    const amp = (amount / 100) * 46;
    const cell = Math.max(1, Math.round(Math.min(w, h) / 900));
    for (let y = 0; y < h; y++) {
      const cy = (y / cell) | 0;
      for (let x = 0; x < w; x++) {
        let n = Math.imul(((x / cell) | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(cy + 0x632be5ab, 0xc2b2ae35);
        n ^= n >>> 15;
        n = Math.imul(n, 0x2c1b3c6d);
        n ^= n >>> 12;
        const v = (((n & 0xffff) / 65535) * 2 - 1) * amp;
        const i = (y * w + x) * 4;
        d[i] += v;
        d[i + 1] += v;
        d[i + 2] += v;
      }
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
    context.globalCompositeOperation = 'source-atop';
    context.fillStyle = g;
    context.fillRect(0, 0, w, h);
    context.restore();
  }

  // Замена фона: mask — холст той же величины, где непрозрачно то, что оставляем
  function applyBackground(canvas, mask, bg) {
    const w = canvas.width;
    const h = canvas.height;
    const c = canvas.getContext('2d');
    const subject = makeCanvas(w, h);
    const sctx = subject.getContext('2d');
    sctx.drawImage(canvas, 0, 0);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(mask, 0, 0, w, h);

    if (bg.mode === 'blur') {
      blurCanvas(canvas, (bg.blur / 100) * Math.min(w, h) * 0.035 + 2);
      c.drawImage(subject, 0, 0);
      return;
    }
    c.save();
    c.globalCompositeOperation = 'copy';
    if (bg.mode === 'color') {
      c.fillStyle = bg.color;
      c.fillRect(0, 0, w, h);
      c.globalCompositeOperation = 'source-over';
    }
    c.drawImage(subject, 0, 0);
    c.restore();
  }

  function bgActive(st) {
    return st.bg.mask >= 0 && st.bg.mode !== 'none' && !!maskList[st.bg.mask];
  }

  // Применяет все правки цвета и эффекты к холсту
  function applyLook(canvas, p, mask, bg) {
    const c = canvas.getContext('2d', { willReadFrequently: true });
    const w = canvas.width;
    const h = canvas.height;

    if (needsColorWork(p) || p.sharpness > 0) {
      const data = c.getImageData(0, 0, w, h);
      if (needsColorWork(p)) processColors(data.data, p);
      if (p.sharpness > 0) sharpen(data.data, w, h, p.sharpness);
      c.putImageData(data, 0, 0);
    }
    if (p.blur > 0) blurCanvas(canvas, (p.blur / 100) * Math.min(w, h) * 0.025);
    if (mask) applyBackground(canvas, mask, bg);
    if (p.grain > 0) {
      const data = c.getImageData(0, 0, w, h);
      addGrain(data.data, w, h, p.grain);
      c.putImageData(data, 0, 0);
    }
    if (!(mask && bg.mode === 'transparent')) drawVignette(c, w, h, p.vignette);
  }

  /* ---------- Надписи, стикеры и рисунок ---------- */

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

  function roundRectPath(context, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + w, y, x + w, y + h, r);
    context.arcTo(x + w, y + h, x, y + h, r);
    context.arcTo(x, y + h, x, y, r);
    context.arcTo(x, y, x + w, y, r);
    context.closePath();
  }

  function drawItems(context, w, h, items, opts = {}) {
    const boxes = new Map();
    const short = Math.min(w, h);
    for (const t of items) {
      const isSticker = t.kind === 'sticker';
      const font = isSticker ? null : fontOf(t);
      if (font && !opts.export) ensureFont(font, t.text);
      const px = isSticker
        ? short * (0.04 + (t.size / 100) * 0.32)
        : short * (0.025 + (t.size / 100) * 0.18);
      const lines = (t.text || '').split('\n');
      const lineH = px * (isSticker ? 1.1 : 1.22);
      const cx = t.x * w;
      const cy = t.y * h;
      const rot = ((t.rotation || 0) * Math.PI) / 180;

      context.save();
      context.translate(cx, cy);
      context.rotate(rot);
      context.font = isSticker ? `${px}px ${EMOJI_FONT}` : fontString(font, px);
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      const widths = lines.map((l) => context.measureText(l).width);
      const maxW = Math.max(px * 0.5, ...widths);
      const blockH = lines.length * lineH;
      const top = -blockH / 2;
      let padX = px * 0.18;
      let padY = px * 0.12;
      let fill = t.color || '#ffffff';

      if (!isSticker && t.style === 'box') {
        padX = px * 0.45;
        padY = px * 0.22;
        context.fillStyle = t.color;
        roundRectPath(context, -maxW / 2 - padX, top - padY, maxW + padX * 2, blockH + padY * 2, px * 0.3);
        context.fill();
        fill = contrastColor(t.color);
      }
      if (!isSticker && t.style === 'shadow') {
        context.shadowColor = 'rgba(0, 0, 0, 0.6)';
        context.shadowBlur = px * 0.25;
        context.shadowOffsetY = px * 0.06;
      }

      lines.forEach((line, i) => {
        const y = top + lineH * (i + 0.5);
        if (!isSticker && t.style === 'outline') {
          context.lineWidth = px * 0.14;
          context.lineJoin = 'round';
          context.miterLimit = 2;
          context.strokeStyle = contrastColor(t.color);
          context.strokeText(line, 0, y);
        }
        context.fillStyle = fill;
        context.fillText(line, 0, y);
      });

      const gap = px * 0.08;
      const hw = maxW / 2 + padX + gap;
      const hh = blockH / 2 + padY + gap;
      boxes.set(t.id, { cx, cy, rot, hw, hh });

      if (opts.selectedId === t.id) {
        const ui = opts.ui || 1;
        context.shadowColor = 'transparent';
        context.setLineDash([6 * ui, 4 * ui]);
        context.lineWidth = 1.5 * ui;
        context.strokeStyle = '#ffc53d';
        context.strokeRect(-hw, -hh, hw * 2, hh * 2);
      }
      context.restore();
    }
    return boxes;
  }

  function strokeWidth(s, short) {
    return short * (0.004 + (s.size / 100) * 0.05);
  }

  function drawStroke(context, s, w, h) {
    const pts = s.points;
    if (!pts.length) return;
    const lw = strokeWidth(s, Math.min(w, h));
    context.save();
    context.strokeStyle = s.color;
    context.fillStyle = s.color;
    context.lineWidth = lw;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (pts.length === 1) {
      context.beginPath();
      context.arc(pts[0][0] * w, pts[0][1] * h, lw / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.beginPath();
      context.moveTo(pts[0][0] * w, pts[0][1] * h);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = ((pts[i][0] + pts[i + 1][0]) / 2) * w;
        const my = ((pts[i][1] + pts[i + 1][1]) / 2) * h;
        context.quadraticCurveTo(pts[i][0] * w, pts[i][1] * h, mx, my);
      }
      const last = pts[pts.length - 1];
      context.lineTo(last[0] * w, last[1] * h);
      context.stroke();
    }
    context.restore();
  }

  /* ---------- Рамка и итоговая картинка ---------- */

  function frameLayout(w, h, frame) {
    const short = Math.min(w, h);
    let side = (frame.width / 100) * short * 0.12;
    let bottom = side;
    if (frame.style === 'polaroid') {
      side = Math.max(side, short * 0.035);
      bottom = side * 3.4;
    }
    side = Math.round(side);
    bottom = Math.round(bottom);
    return {
      ox: side,
      oy: side,
      w,
      h,
      W: w + side * 2,
      H: h + side + bottom,
      radius: (frame.radius / 100) * short * 0.2,
      hasFrame: side > 0,
    };
  }

  function hasTransparency(st) {
    const lay = frameLayout(100, 100, st.frame);
    return (bgActive(st) && st.bg.mode === 'transparent') || (!lay.hasFrame && st.frame.radius > 0);
  }

  function composeFinal(target, photo, st, opts = {}) {
    const w = photo.width;
    const h = photo.height;
    const lay = frameLayout(w, h, st.frame);
    if (target.width !== lay.W || target.height !== lay.H) {
      target.width = lay.W;
      target.height = lay.H;
    }
    const c = target.getContext('2d');
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, lay.W, lay.H);
    if (lay.hasFrame) {
      c.fillStyle = st.frame.color;
      c.fillRect(0, 0, lay.W, lay.H);
    }
    c.translate(lay.ox, lay.oy);
    if (lay.radius > 0) {
      roundRectPath(c, 0, 0, w, h, lay.radius);
      c.clip();
    }
    if (lay.hasFrame && hasTransparency(st)) {
      // Под прозрачным фоном внутри рамки — цвет рамки
      c.fillStyle = st.frame.color;
      c.fillRect(0, 0, w, h);
    }
    c.drawImage(photo, 0, 0);
    for (const s of st.strokes) drawStroke(c, s, w, h);
    if (opts.liveStroke) drawStroke(c, opts.liveStroke, w, h);
    c.restore();

    c.save();
    c.translate(lay.ox, lay.oy);
    const boxes = drawItems(c, w, h, st.items, opts);
    c.restore();
    return { lay, boxes };
  }

  /* ---------- Показ на экране ---------- */

  function isErasing() {
    return activeTab === 'ai' && aiTool === 'erase';
  }

  function plainView() {
    return mode === 'crop' || isErasing();
  }

  function ensureBase() {
    if (!dirtyBase) return;
    const useCrop = mode !== 'crop';
    const pw = preview.width;
    const ph = preview.height;
    const [bw, bh] = frameSize(state, pw, ph, 1, useCrop);
    baseCanvas = makeCanvas(bw, bh);
    const bctx = baseCanvas.getContext('2d', { willReadFrequently: true });
    drawWithMatrix(bctx, preview, frameMatrix(state, pw, ph, 1, useCrop));
    baseData = bctx.getImageData(0, 0, bw, bh);

    maskBase = null;
    if (bgActive(state)) {
      const mk = maskList[state.bg.mask];
      maskBase = makeCanvas(bw, bh);
      drawWithMatrix(maskBase.getContext('2d'), mk, frameMatrix(state, mk.width, mk.height, pw / mk.width, useCrop));
    }
    dirtyBase = false;
    dirtyAdjust = true;
    thumbsDirty = true;
  }

  function ensureAdjusted() {
    if (!dirtyAdjust) return;
    if (!adjustedCanvas || adjustedCanvas.width !== baseCanvas.width || adjustedCanvas.height !== baseCanvas.height) {
      adjustedCanvas = makeCanvas(baseCanvas.width, baseCanvas.height);
    }
    const actx = adjustedCanvas.getContext('2d', { willReadFrequently: true });
    actx.putImageData(baseData, 0, 0);
    applyLook(adjustedCanvas, paramsFor(state.filter, state.strength, state.adjust), maskBase, state.bg);
    dirtyAdjust = false;
  }

  function displayScale() {
    const cssW = parseFloat(el.canvas.style.width) || el.canvas.width;
    return el.canvas.width / cssW;
  }

  function setCanvasSize(w, h) {
    if (el.canvas.width !== w || el.canvas.height !== h) {
      el.canvas.width = w;
      el.canvas.height = h;
      fitCanvas();
    }
  }

  function renderCompare() {
    // Исходное фото без единой правки, но с той же обрезкой
    const pw = originalPreview.width;
    const ph = originalPreview.height;
    const [bw, bh] = frameSize(state, pw, ph, 1, mode !== 'crop');
    setCanvasSize(bw, bh);
    ctx.clearRect(0, 0, bw, bh);
    drawWithMatrix(ctx, originalPreview, frameMatrix(state, pw, ph, 1, mode !== 'crop'));
    layout = { ox: 0, oy: 0, w: bw, h: bh };
    itemBoxes = new Map();
  }

  function renderNow() {
    if (!original) return;
    if (comparing) {
      renderCompare();
      return;
    }
    ensureBase();
    ensureAdjusted();

    if (plainView()) {
      const w = adjustedCanvas.width;
      const h = adjustedCanvas.height;
      setCanvasSize(w, h);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(adjustedCanvas, 0, 0);
      layout = { ox: 0, oy: 0, w, h };
      itemBoxes = new Map();
      if (isErasing()) drawEraseOverlay();
    } else {
      const lay = frameLayout(adjustedCanvas.width, adjustedCanvas.height, state.frame);
      setCanvasSize(lay.W, lay.H);
      const res = composeFinal(el.canvas, adjustedCanvas, state, {
        selectedId: (activeTab === 'text' || activeTab === 'stickers') ? selectedId : null,
        ui: displayScale(),
        liveStroke: activeTab === 'draw' ? liveStroke : null,
      });
      layout = res.lay;
      itemBoxes = res.boxes;
      if (activeTab === 'draw' && brushHover) {
        const lw = strokeWidth({ size: +el.drawSize.value }, Math.min(layout.w, layout.h));
        drawBrushCursor(brushHover.x, brushHover.y, lw / 2);
      }
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

  function drawBrushCursor(x, y, r) {
    const ui = displayScale();
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, Math.max(r, 2 * ui), 0, Math.PI * 2);
    ctx.lineWidth = 1.5 * ui;
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.stroke();
    ctx.lineWidth = 1 * ui;
    ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.beginPath();
    ctx.arc(x, y, Math.max(r, 2 * ui) + 1.5 * ui, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
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
    const thumbData = sctx.getImageData(0, 0, THUMB_SIZE, THUMB_SIZE);

    $$('.frame').forEach((btn) => {
      const c = btn.querySelector('canvas');
      const cctx = c.getContext('2d', { willReadFrequently: true });
      cctx.putImageData(thumbData, 0, 0);
      applyLook(c, paramsFor(btn.dataset.filter, 100, zeroAdjust()), null, state.bg);
    });
  }

  /* ---------- Ползунки настроек ---------- */

  function buildSliders() {
    el.sliders.innerHTML = '';
    for (const group of ADJUST_GROUPS) {
      const box = document.createElement('div');
      box.className = 'slider-group';
      const title = document.createElement('h3');
      title.className = 'group-title';
      title.textContent = group.title;
      box.append(title);
      for (const a of group.items) {
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
        box.append(field);
      }
      el.sliders.append(box);
    }
  }

  // Автоулучшение: смотрим на гистограмму яркости и подбираем ползунки
  function autoEnhance() {
    if (!original) return;
    ensureBase();
    const d = baseData.data;
    const hist = new Uint32Array(256);
    let count = 0;
    let sum = 0;
    for (let i = 0; i < d.length; i += 16) {
      const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
      hist[l]++;
      sum += l;
      count++;
    }
    const mean = sum / count;
    const pct = (q) => {
      let acc = 0;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= q * count) return v;
      }
      return 255;
    };
    const lo = pct(0.005);
    const hi = pct(0.995);
    const spread = Math.max(40, hi - lo);
    const a = state.adjust;
    a.contrast = Math.round(clamp(((255 / spread - 1) / 1.2) * 100 * 0.7, 0, 35));
    a.exposure = Math.round(clamp((120 - mean) / 2.4, -25, 35));
    a.shadows = Math.round(clamp((115 - mean) * 0.35 + (lo > 30 ? 0 : 8), 0, 35));
    a.highlights = hi > 245 ? -15 : 0;
    a.saturation = 12;
    a.sharpness = 20;
    syncSliders();
    dirtyAdjust = true;
    requestRender();
    commit();
    toast('Готово. Результат можно подправить ползунками.');
  }

  /* ---------- Синхронизация интерфейса с состоянием ---------- */

  function syncFilters() {
    $$('.frame').forEach((btn) => btn.setAttribute('aria-selected', String(btn.dataset.filter === state.filter)));
    el.strengthField.hidden = state.filter === 'none';
    el.strength.value = state.strength;
    el.strengthValue.textContent = state.strength;
    setFill(el.strength);
  }

  function syncSliders() {
    for (const a of ADJUSTMENTS) {
      const input = $(`#adj-${a.key}`);
      input.value = state.adjust[a.key] || 0;
      input._show();
    }
  }

  function syncCrop() {
    setRadio(el.ratios, 'ratio', cropRatio);
    el.cropUI.classList.toggle('is-locked', cropRatio !== 'free');
    el.angle.value = state.angle;
    el.angleValue.textContent = formatDegrees(state.angle);
    setFill(el.angle);
  }

  function syncAI() {
    setRadio(el.aiMode, 'ai', aiTool);
    el.aiErase.hidden = aiTool !== 'erase';
    el.aiBg.hidden = aiTool !== 'bg';
    const hasMask = state.bg.mask >= 0 && !!maskList[state.bg.mask];
    el.btnBgRun.hidden = hasMask;
    el.bgHint.hidden = hasMask;
    el.bgOptions.hidden = !hasMask;
    setRadio(el.bgMode, 'bg', state.bg.mode);
    el.bgColorField.hidden = state.bg.mode !== 'color';
    el.bgBlurField.hidden = state.bg.mode !== 'blur';
    el.bgBlur.value = state.bg.blur;
    el.bgBlurValue.textContent = state.bg.blur;
    setFill(el.bgBlur);
    if (el.bgSwatches._sync) el.bgSwatches._sync(state.bg.color);
    el.btnEraseRun.disabled = aiBusy;
    el.btnBgRun.disabled = aiBusy;
    el.eraseSizeValue.textContent = el.eraseSize.value;
    setFill(el.eraseSize);
  }

  function syncFrame() {
    setRadio(el.frameStyle, 'frame', state.frame.style);
    el.frameWidth.value = state.frame.width;
    el.frameWidthValue.textContent = state.frame.width;
    setFill(el.frameWidth);
    el.frameRadius.value = state.frame.radius;
    el.frameRadiusValue.textContent = state.frame.radius;
    setFill(el.frameRadius);
    if (el.frameSwatches._sync) el.frameSwatches._sync(state.frame.color);
  }

  function syncUI() {
    syncFilters();
    syncSliders();
    syncCrop();
    syncAI();
    syncItemEditors();
    syncFrame();
  }

  /* ---------- Вкладки ---------- */

  function setTab(name) {
    if (name === activeTab && !(name === 'crop' && mode !== 'crop')) return;
    const prev = activeTab;
    if (prev === 'crop' && name !== 'crop') applyCrop(false);
    if ((prev === 'text' || prev === 'stickers') && name !== 'text' && name !== 'stickers') selectItem(null);
    const sel = selectedItem();
    if (sel && ((name === 'text' && sel.kind !== 'text') || (name === 'stickers' && sel.kind !== 'sticker'))) selectItem(null);

    activeTab = name;
    el.tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    el.panes.forEach((p) => { p.hidden = p.dataset.pane !== name; });
    const tab = el.tabs.find((t) => t.dataset.tab === name);
    if (tab && tab.scrollIntoView) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    brushHover = null;
    updatePaintingCursor();
    if (name === 'crop') enterCrop();
    syncItemEditors();
    requestRender();
  }

  function updatePaintingCursor() {
    el.app.classList.toggle('is-painting', activeTab === 'draw' || isErasing());
  }

  /* ---------- Обрезка ---------- */

  function orientedPreviewSize() {
    return orientedSize(preview.width, preview.height, state.m);
  }

  function enterCrop() {
    if (!original || mode === 'crop') return;
    mode = 'crop';
    pendingCrop = { ...state.crop };
    dirtyBase = true;
    el.cropUI.hidden = false;
    syncCrop();
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
    syncCrop();
    const a = normalizedRatio();
    if (a) {
      const cx = pendingCrop.x + pendingCrop.w / 2;
      const cy = pendingCrop.y + pendingCrop.h / 2;
      let w = Math.min(1, a);
      let h = w / a;
      if (h > 1) { h = 1; w = a; }
      pendingCrop = { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
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
      pendingCrop = { x: clamp(s.x + dx, 0, 1 - s.w), y: clamp(s.y + dy, 0, 1 - s.h), w: s.w, h: s.h };
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

  /* ---------- Поворот, отражение и наклон ---------- */

  function applyOrientation(opName) {
    if (!original) return;
    state.m = multiply(OPS[opName], state.m);
    state.crop = transformRect(state.crop, opName);
    if (opName === 'flipH' || opName === 'flipV') state.angle = -state.angle;
    if (mode === 'crop') {
      pendingCrop = transformRect(pendingCrop, opName);
      if (cropRatio !== 'free') setRatio(cropRatio);
    }
    syncCrop();
    dirtyBase = true;
    commit();
    requestRender();
  }

  /* ---------- Надписи и стикеры ---------- */

  function selectedItem() {
    return state.items.find((t) => t.id === selectedId) || null;
  }

  function selectItem(id) {
    if (selectedId && selectedId !== id) {
      // Пустые надписи удаляем, чтобы они не мешали
      const prev = selectedItem();
      if (prev && prev.kind === 'text' && !prev.text.trim()) {
        state.items = state.items.filter((t) => t.id !== prev.id);
        commit();
      }
    }
    selectedId = id;
    syncItemEditors();
    requestRender();
  }

  function buildSwatches(container, colors, onPick, onCustomInput) {
    container.innerHTML = '';
    for (const c of colors) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.setAttribute('aria-label', c.name);
      b.title = c.name;
      b.dataset.color = c.value;
      b.style.setProperty('--c', c.value);
      b.addEventListener('click', () => onPick(c.value));
      container.append(b);
    }
    const custom = document.createElement('label');
    custom.className = 'swatch swatch-custom';
    custom.title = 'Свой цвет';
    custom.setAttribute('role', 'radio');
    custom.setAttribute('aria-checked', 'false');
    custom.innerHTML = '<input type="color" aria-label="Выбрать свой цвет" value="#ffffff">';
    const picker = custom.querySelector('input');
    picker.addEventListener('input', () => onCustomInput(picker.value));
    picker.addEventListener('change', () => onPick(picker.value));
    container.append(custom);

    container._sync = (value) => {
      let matched = false;
      container.querySelectorAll('.swatch[data-color]').forEach((b) => {
        const on = b.dataset.color.toLowerCase() === String(value).toLowerCase();
        if (on) matched = true;
        b.setAttribute('aria-checked', String(on));
      });
      custom.setAttribute('aria-checked', String(!matched));
      if (/^#[0-9a-f]{6}$/i.test(value)) picker.value = value;
    };
  }

  function buildItemControls() {
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
      b.addEventListener('click', () => updateItem({ font: f.id }, true));
      el.fontGrid.append(b);
    }

    buildSwatches(el.swatches, COLORS,
      (v) => updateItem({ color: v }, true),
      (v) => updateItem({ color: v }, false));

    el.stickerGrid.innerHTML = '';
    for (const s of STICKERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sticker-btn';
      b.textContent = s;
      b.setAttribute('aria-label', 'Добавить стикер ' + s);
      b.addEventListener('click', () => addSticker(s));
      el.stickerGrid.append(b);
    }

    buildSwatches(el.drawSwatches, COLORS, (v) => {
      drawColor = v;
      el.drawSwatches._sync(v);
    }, (v) => { drawColor = v; });
    el.drawSwatches._sync(drawColor);

    buildSwatches(el.bgSwatches, COLORS, (v) => {
      state.bg.color = v;
      dirtyAdjust = true;
      syncAI();
      requestRender();
      commit();
    }, (v) => {
      state.bg.color = v;
      dirtyAdjust = true;
      requestRender();
    });

    buildSwatches(el.frameSwatches, FRAME_COLORS, (v) => {
      state.frame.color = v;
      syncFrame();
      requestRender();
      commit();
    }, (v) => {
      state.frame.color = v;
      requestRender();
    });
  }

  function updateItem(changes, save) {
    const t = selectedItem();
    if (!t) return;
    Object.assign(t, changes);
    if (changes.font) ensureFont(fontOf(t), t.text);
    syncItemEditors();
    requestRender();
    if (save) commit();
  }

  function syncItemEditors() {
    const t = selectedItem();
    const isText = t && t.kind === 'text';
    const isSticker = t && t.kind === 'sticker';
    el.textEditor.hidden = !isText;
    el.textHint.hidden = !!isText;
    el.stickerEditor.hidden = !isSticker;
    el.stickerHint.hidden = !!isSticker;

    if (isText) {
      if (document.activeElement !== el.textInput) el.textInput.value = t.text;
      $$('.font-chip').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.font === t.font)));
      el.textSize.value = t.size;
      el.textSizeValue.textContent = t.size;
      setFill(el.textSize);
      el.textRotation.value = t.rotation || 0;
      el.textRotationValue.textContent = formatDegrees(t.rotation || 0);
      setFill(el.textRotation);
      el.swatches._sync(t.color);
      setRadio(el.textStyle, 'style', t.style);
    }
    if (isSticker) {
      el.stickerSize.value = t.size;
      el.stickerSizeValue.textContent = t.size;
      setFill(el.stickerSize);
      el.stickerRotation.value = t.rotation || 0;
      el.stickerRotationValue.textContent = formatDegrees(t.rotation || 0);
      setFill(el.stickerRotation);
    }
  }

  function freeSpot() {
    let y = 0.5;
    while (state.items.some((t) => Math.abs(t.x - 0.5) < 0.01 && Math.abs(t.y - y) < 0.01) && y < 0.9) y += 0.1;
    return y;
  }

  function addText() {
    if (!original) return;
    const t = {
      id: uid(),
      kind: 'text',
      text: 'Ваш текст',
      x: 0.5,
      y: freeSpot(),
      size: 40,
      rotation: 0,
      font: 'montserrat',
      color: '#ffffff',
      style: 'outline',
    };
    state.items.push(t);
    ensureFont(fontOf(t), t.text);
    selectItem(t.id);
    commit();
    el.textInput.value = t.text;
    el.textInput.focus();
    el.textInput.select();
  }

  function addSticker(emoji) {
    if (!original) return;
    const t = { id: uid(), kind: 'sticker', text: emoji, x: 0.5, y: freeSpot(), size: 40, rotation: 0 };
    state.items.push(t);
    selectItem(t.id);
    commit();
  }

  function deleteSelectedItem() {
    if (!selectedId) return;
    state.items = state.items.filter((t) => t.id !== selectedId);
    selectedId = null;
    syncItemEditors();
    requestRender();
    commit();
  }

  /* ---------- Указатель на фото: перетаскивание, рисование, ластик ---------- */

  function canvasPoint(e) {
    const rect = el.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * el.canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * el.canvas.height) / rect.height,
    };
  }

  function hitItem(p) {
    const lx0 = p.x - layout.ox;
    const ly0 = p.y - layout.oy;
    for (let i = state.items.length - 1; i >= 0; i--) {
      const t = state.items[i];
      const b = itemBoxes.get(t.id);
      if (!b) continue;
      const dx = lx0 - b.cx;
      const dy = ly0 - b.cy;
      const lx = dx * Math.cos(-b.rot) - dy * Math.sin(-b.rot);
      const ly = dx * Math.sin(-b.rot) + dy * Math.cos(-b.rot);
      if (Math.abs(lx) <= b.hw && Math.abs(ly) <= b.hh) return t;
    }
    return null;
  }

  let pointer = null;

  function eraseRadius() {
    const w = layout.w;
    const h = layout.h;
    return Math.min(w, h) * (0.008 + (+el.eraseSize.value / 100) * 0.08);
  }

  function onCanvasPointerDown(e) {
    if (!original || mode === 'crop' || comparing || aiBusy) return;
    const p = canvasPoint(e);

    if (isErasing()) {
      e.preventDefault();
      const s = { r: eraseRadius(), points: [[p.x, p.y]] };
      eraseStrokes.push(s);
      pointer = { type: 'erase', stroke: s };
      el.canvas.setPointerCapture(e.pointerId);
      requestRender();
      return;
    }

    if (activeTab === 'draw') {
      e.preventDefault();
      const nx = (p.x - layout.ox) / layout.w;
      const ny = (p.y - layout.oy) / layout.h;
      liveStroke = { color: drawColor, size: +el.drawSize.value, points: [[nx, ny]] };
      pointer = { type: 'draw' };
      el.canvas.setPointerCapture(e.pointerId);
      requestRender();
      return;
    }

    const t = hitItem(p);
    if (t) {
      e.preventDefault();
      const tab = t.kind === 'sticker' ? 'stickers' : 'text';
      if (activeTab !== tab) setTab(tab);
      selectItem(t.id);
      pointer = { type: 'item', id: t.id, sx: p.x, sy: p.y, ox: t.x, oy: t.y, moved: false };
      el.canvas.setPointerCapture(e.pointerId);
      el.app.classList.add('is-dragging-text');
    } else if (selectedId) {
      selectItem(null);
    }
  }

  function onCanvasPointerMove(e) {
    if (!original || mode === 'crop') return;
    const p = canvasPoint(e);

    if (pointer && pointer.type === 'erase') {
      const pts = pointer.stroke.points;
      const last = pts[pts.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) > 2) pts.push([p.x, p.y]);
      brushHover = p;
      requestRender();
      return;
    }
    if (pointer && pointer.type === 'draw') {
      const nx = (p.x - layout.ox) / layout.w;
      const ny = (p.y - layout.oy) / layout.h;
      const pts = liveStroke.points;
      const last = pts[pts.length - 1];
      if (Math.hypot((nx - last[0]) * layout.w, (ny - last[1]) * layout.h) > 1.5) pts.push([nx, ny]);
      brushHover = p;
      requestRender();
      return;
    }
    if (pointer && pointer.type === 'item') {
      const t = state.items.find((x) => x.id === pointer.id);
      if (!t) return;
      t.x = clamp(pointer.ox + (p.x - pointer.sx) / layout.w, 0, 1);
      t.y = clamp(pointer.oy + (p.y - pointer.sy) / layout.h, 0, 1);
      pointer.moved = true;
      requestRender();
      return;
    }

    if (e.pointerType === 'mouse' && (activeTab === 'draw' || isErasing())) {
      brushHover = p;
      requestRender();
    } else if (e.pointerType === 'mouse') {
      el.app.classList.toggle('is-over-text', !!hitItem(p));
    }
  }

  function onCanvasPointerUp(e) {
    if (e && e.pointerType !== 'mouse' && brushHover) {
      brushHover = null;
      requestRender();
    }
    if (pointer && pointer.type === 'item' && pointer.moved) commit();
    if (pointer && pointer.type === 'draw' && liveStroke) {
      state.strokes.push(liveStroke);
      liveStroke = null;
      commit();
      requestRender();
    }
    pointer = null;
    el.app.classList.remove('is-dragging-text');
  }

  function drawEraseOverlay() {
    if (!eraseStrokes.length && !brushHover) return;
    const w = el.canvas.width;
    const h = el.canvas.height;
    if (eraseStrokes.length) {
      const layer = makeCanvas(w, h);
      const lctx = layer.getContext('2d');
      paintEraseStrokes(lctx, '#ff3b3b');
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
    }
    if (brushHover) drawBrushCursor(brushHover.x, brushHover.y, eraseRadius());
  }

  function paintEraseStrokes(context, color) {
    context.save();
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    for (const s of eraseStrokes) {
      if (s.points.length === 1) {
        context.beginPath();
        context.arc(s.points[0][0], s.points[0][1], s.r, 0, Math.PI * 2);
        context.fill();
      } else {
        context.lineWidth = s.r * 2;
        context.beginPath();
        context.moveTo(s.points[0][0], s.points[0][1]);
        for (const pt of s.points.slice(1)) context.lineTo(pt[0], pt[1]);
        context.stroke();
      }
    }
    context.restore();
  }

  /* ---------- ИИ: загрузка модели ---------- */

  let ortPromise = null;
  const sessions = {};

  function loadOrt() {
    if (ortPromise) return ortPromise;
    ortPromise = new Promise((resolve, reject) => {
      if (window.ort) { resolve(window.ort); return; }
      const s = document.createElement('script');
      s.src = ORT_BASE + 'ort.wasm.min.js';
      s.crossOrigin = 'anonymous';
      s.onload = () => {
        const ort = window.ort;
        ort.env.wasm.wasmPaths = ORT_BASE;
        ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
        ort.env.wasm.proxy = true; // считаем в фоне, чтобы страница не зависала
        resolve(ort);
      };
      s.onerror = () => { ortPromise = null; reject(new Error('ort')); };
      document.head.append(s);
    });
    return ortPromise;
  }

  async function fetchModel(url, sizeMb, onProgress) {
    let cache = null;
    try {
      if ('caches' in window) {
        cache = await caches.open('kadr-models-v1');
        const hit = await cache.match(url);
        if (hit) return await hit.arrayBuffer();
      }
    } catch (e) { cache = null; }

    const resp = await fetch(url);
    if (!resp.ok) throw new Error('model ' + resp.status);
    const total = +resp.headers.get('content-length') || sizeMb * 1e6;
    let buf;
    if (resp.body && resp.body.getReader) {
      const reader = resp.body.getReader();
      const chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onProgress(Math.min(1, loaded / total));
      }
      const all = new Uint8Array(loaded);
      let pos = 0;
      for (const ch of chunks) { all.set(ch, pos); pos += ch.length; }
      buf = all.buffer;
    } else {
      buf = await resp.arrayBuffer();
    }
    if (cache) {
      try { await cache.put(url, new Response(buf.slice(0))); } catch (e) { /* место закончилось — не страшно */ }
    }
    return buf;
  }

  async function getSession(key) {
    if (sessions[key]) return sessions[key];
    const info = MODELS[key];
    setAIStatus('Загружаем ИИ…', null);
    const ort = await loadOrt();
    const buf = await fetchModel(info.url, info.sizeMb, (f) => {
      setAIStatus(`Загружаем ИИ-модель: ${Math.round(f * 100)} %`, f);
    });
    setAIStatus('Готовим ИИ к работе…', null);
    try {
      sessions[key] = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
    } catch (e) {
      // Если фоновый режим не сработал, пробуем обычный
      if (ort.env.wasm.proxy) {
        ort.env.wasm.proxy = false;
        sessions[key] = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
      } else {
        throw e;
      }
    }
    return sessions[key];
  }

  function setAIStatus(text, fraction) {
    el.aiStatus.hidden = !text;
    if (!text) return;
    el.aiStatusText.textContent = text;
    const bar = el.aiProgress.parentElement;
    bar.classList.toggle('is-indeterminate', fraction == null);
    el.aiProgress.style.width = fraction == null ? '' : Math.round(fraction * 100) + '%';
  }

  function setBusy(busy, label) {
    aiBusy = busy;
    el.badge.hidden = !busy;
    el.badge.classList.toggle('is-busy', busy);
    el.badge.textContent = busy ? label : '';
    el.btnSave.disabled = busy;
    syncAI();
    if (!busy) setAIStatus(null);
  }

  function aiError(e) {
    console.error(e);
    const msg = String(e && e.message || e);
    if (/ort|fetch|model|network|Failed/i.test(msg)) {
      toast('Не получилось загрузить ИИ-модель. Проверьте интернет и попробуйте ещё раз.', true);
    } else if (/memory|allocation|RangeError/i.test(msg)) {
      toast('Не хватило памяти устройства. Попробуйте фото поменьше.', true);
    } else {
      toast('ИИ не справился с этим фото. Попробуйте ещё раз.', true);
    }
  }

  /* ---------- ИИ-ластик ---------- */

  async function runEraser() {
    if (aiBusy || !original) return;
    if (!eraseStrokes.length) {
      toast('Сначала закрасьте то, что нужно убрать.');
      return;
    }
    setBusy(true, 'ИИ стирает…');
    try {
      const session = await getSession('eraser');
      setAIStatus('ИИ дорисовывает фон…', null);
      await nextFrame();

      const src = currentSource();
      // Из координат экрана в координаты исходного фото
      const toBase = mMul(frameMatrix(state, preview.width, preview.height, 1, true), mS(preview.width / srcW));
      const toSrc = mInv(toBase);
      const k = Math.sqrt(Math.abs(toSrc[0] * toSrc[3] - toSrc[1] * toSrc[2]));

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of eraseStrokes) {
        const r = s.r * k;
        for (const pt of s.points) {
          const [x, y] = mApply(toSrc, pt[0], pt[1]);
          minX = Math.min(minX, x - r); minY = Math.min(minY, y - r);
          maxX = Math.max(maxX, x + r); maxY = Math.max(maxY, y + r);
        }
      }
      const margin = Math.max(maxX - minX, maxY - minY) * 0.6 + 32;
      const R = {
        x: Math.max(0, Math.floor(minX - margin)),
        y: Math.max(0, Math.floor(minY - margin)),
      };
      R.w = Math.min(srcW, Math.ceil(maxX + margin)) - R.x;
      R.h = Math.min(srcH, Math.ceil(maxY + margin)) - R.y;
      if (R.w < 8 || R.h < 8) throw new Error('empty');

      const f = Math.min(1, 1024 / Math.max(R.w, R.h));
      const iw = Math.max(8, Math.round(R.w * f));
      const ih = Math.max(8, Math.round(R.h * f));

      const imgC = makeCanvas(iw, ih);
      const ictx = imgC.getContext('2d', { willReadFrequently: true });
      ictx.imageSmoothingQuality = 'high';
      ictx.drawImage(src, R.x, R.y, R.w, R.h, 0, 0, iw, ih);

      const maskC = makeCanvas(iw, ih);
      const mctx = maskC.getContext('2d', { willReadFrequently: true });
      const M = mChain(mS(f), mT(-R.x, -R.y), toSrc);
      mctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      paintEraseStrokes(mctx, '#000');
      mctx.setTransform(1, 0, 0, 1, 0, 0);

      const id = ictx.getImageData(0, 0, iw, ih).data;
      const md = mctx.getImageData(0, 0, iw, ih).data;
      const n = iw * ih;
      const imgT = new Uint8Array(n * 3);
      const maskT = new Uint8Array(n);
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        imgT[i] = id[p];
        imgT[i + n] = id[p + 1];
        imgT[i + 2 * n] = id[p + 2];
        maskT[i] = md[p + 3] > 20 ? 0 : 255; // 0 — стереть, 255 — оставить
      }

      const ort = window.ort;
      const out = await session.run({
        image: new ort.Tensor('uint8', imgT, [1, 3, ih, iw]),
        mask: new ort.Tensor('uint8', maskT, [1, 1, ih, iw]),
      });
      const res = out[session.outputNames[0]];
      const rd = res.data;
      const [, , oh, ow] = res.dims;
      const outImg = new ImageData(ow, oh);
      const on = ow * oh;
      for (let i = 0, p = 0; i < on; i++, p += 4) {
        outImg.data[p] = rd[i];
        outImg.data[p + 1] = rd[i + on];
        outImg.data[p + 2] = rd[i + 2 * on];
        outImg.data[p + 3] = 255;
      }
      const outC = makeCanvas(ow, oh);
      outC.getContext('2d').putImageData(outImg, 0, 0);

      // Кладём результат только туда, где закрашено, с мягким краем
      const layer = makeCanvas(R.w, R.h);
      const lctx = layer.getContext('2d');
      lctx.imageSmoothingQuality = 'high';
      lctx.drawImage(outC, 0, 0, R.w, R.h);
      lctx.globalCompositeOperation = 'destination-in';
      lctx.drawImage(maskC, 0, 0, R.w, R.h);

      const patch = makeCanvas(R.w, R.h);
      const pctx = patch.getContext('2d');
      pctx.drawImage(src, R.x, R.y, R.w, R.h, 0, 0, R.w, R.h);
      pctx.drawImage(layer, 0, 0);

      patchList = patchList.slice(0, state.patches);
      patchList.push({ x: R.x, y: R.y, canvas: patch });
      if (!workSource) {
        workSource = makeCanvas(srcW, srcH);
        workSource.getContext('2d').drawImage(original, 0, 0);
      }
      workSource.getContext('2d').drawImage(patch, R.x, R.y);
      state.patches++;
      appliedPatches = state.patches;
      preview = makePreview(workSource);
      eraseStrokes = [];
      dirtyBase = true;
      commit();
      requestRender();
      toast('Готово! Если что-то осталось, закрасьте это ещё раз.');
    } catch (e) {
      if (String(e.message) === 'empty') toast('Закрашенная область слишком маленькая.', true);
      else aiError(e);
    } finally {
      setBusy(false);
    }
  }

  /* ---------- ИИ: удаление фона ---------- */

  async function runBackground() {
    if (aiBusy || !original) return;
    setBusy(true, 'ИИ ищет главное на фото…');
    try {
      const session = await getSession('background');
      setAIStatus('ИИ отделяет фон… Это может занять до 30 секунд.', null);
      await nextFrame();

      const S = 1024;
      const inC = makeCanvas(S, S);
      const ictx = inC.getContext('2d', { willReadFrequently: true });
      ictx.imageSmoothingQuality = 'high';
      ictx.drawImage(currentSource(), 0, 0, S, S);
      const d = ictx.getImageData(0, 0, S, S).data;
      const n = S * S;
      const input = new Float32Array(n * 3);
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        input[i] = d[p] / 255;
        input[i + n] = d[p + 1] / 255;
        input[i + 2 * n] = d[p + 2] / 255;
      }
      const ort = window.ort;
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, S, S]) });
      const alpha = out[session.outputNames[0]].data;

      const small = new ImageData(S, S);
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        small.data[p] = 255;
        small.data[p + 1] = 255;
        small.data[p + 2] = 255;
        small.data[p + 3] = clamp(alpha[i], 0, 1) * 255;
      }
      const sc = makeCanvas(S, S);
      sc.getContext('2d').putImageData(small, 0, 0);
      const ms = Math.min(1, MASK_MAX / Math.max(srcW, srcH));
      const mask = makeCanvas(srcW * ms, srcH * ms);
      const mkctx = mask.getContext('2d');
      mkctx.imageSmoothingQuality = 'high';
      mkctx.drawImage(sc, 0, 0, mask.width, mask.height);

      maskList.push(mask);
      state.bg = { ...state.bg, mask: maskList.length - 1, mode: 'transparent' };
      dirtyBase = true;
      commit();
      syncAI();
      requestRender();
      toast('Фон удалён. Можно выбрать новый цвет или размытие.');
    } catch (e) {
      aiError(e);
    } finally {
      setBusy(false);
    }
  }

  /* ---------- Сохранение ---------- */

  let exportCanvas = null;
  let exportBlob = null;
  let exportFormat = 'jpeg';
  let blobTimer = null;
  let blobJob = 0;

  async function renderFullSize() {
    await Promise.all(state.items.filter((t) => t.kind === 'text').map((t) =>
      document.fonts.load(fontString(fontOf(t), 40), t.text || 'А').catch(() => {})));

    const src = currentSource();
    const [W, H] = orientedSize(srcW, srcH, state.m);
    const cw = state.crop.w * W;
    const ch = state.crop.h * H;
    const scale = Math.min(1, Math.sqrt(EXPORT_MAX_PIXELS / (cw * ch)));
    const [pw, ph] = frameSize(state, srcW, srcH, scale, true);
    const photo = makeCanvas(pw, ph);
    const pctx = photo.getContext('2d', { willReadFrequently: true });
    drawWithMatrix(pctx, src, frameMatrix(state, srcW, srcH, scale, true));

    let mask = null;
    if (bgActive(state)) {
      const mk = maskList[state.bg.mask];
      mask = makeCanvas(pw, ph);
      drawWithMatrix(mask.getContext('2d'), mk, frameMatrix(state, mk.width, mk.height, (scale * srcW) / mk.width, true));
    }
    applyLook(photo, paramsFor(state.filter, state.strength, state.adjust), mask, state.bg);

    const out = makeCanvas(1, 1);
    composeFinal(out, photo, state, { export: true });
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
      let source = exportCanvas;
      if (exportFormat === 'jpeg' && hasTransparency(state)) {
        // В JPG нет прозрачности: подкладываем белый фон
        source = makeCanvas(exportCanvas.width, exportCanvas.height);
        const sctx = source.getContext('2d');
        sctx.fillStyle = '#ffffff';
        sctx.fillRect(0, 0, source.width, source.height);
        sctx.drawImage(exportCanvas, 0, 0);
      }
      const type = exportFormat === 'png' ? 'image/png' : 'image/jpeg';
      const blob = await canvasToBlob(source, type, +el.quality.value / 100);
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
    if (!original || aiBusy) return;
    if (mode === 'crop') applyCrop(false);
    exportCanvas = null;
    exportBlob = null;
    el.btnDownload.disabled = true;
    el.btnShare.disabled = true;
    el.saveInfo.textContent = 'Готовим фото…';
    el.btnShare.hidden = !canShareFiles();
    setFormat(hasTransparency(state) ? 'png' : exportFormat, true);
    if (typeof el.saveDialog.showModal === 'function') el.saveDialog.showModal();
    else el.saveDialog.setAttribute('open', '');
    await new Promise((r) => setTimeout(r, 30));
    try {
      exportCanvas = await renderFullSize();
      await prepareBlob();
    } catch (e) {
      console.error(e);
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

  function setFormat(format, silent) {
    exportFormat = format;
    setRadio(el.format, 'format', format);
    el.qualityField.hidden = format === 'png';
    if (hasTransparency(state)) {
      el.formatHint.textContent = format === 'png'
        ? 'PNG сохранит прозрачный фон.'
        : 'В JPG нет прозрачности: прозрачные места станут белыми.';
    } else {
      el.formatHint.textContent = format === 'png'
        ? 'PNG сохраняет фото без потери качества, но файл весит больше.'
        : 'JPG весит меньше и подходит для соцсетей и мессенджеров.';
    }
    if (!silent) schedulePrepareBlob();
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

  function bindRange(input, output, format, onInput, onChange) {
    const show = () => {
      output.textContent = format(+input.value);
      setFill(input);
    };
    input.addEventListener('input', () => { show(); onInput(+input.value); });
    if (onChange) input.addEventListener('change', onChange);
    show();
  }

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
      if (!original || comparing || aiBusy) return;
      comparing = true;
      el.badge.hidden = false;
      el.badge.classList.remove('is-busy');
      el.badge.textContent = 'Исходное фото';
      el.btnCompare.classList.add('is-active');
      requestRender();
    };
    const stopCompare = () => {
      if (!comparing) return;
      comparing = false;
      el.badge.hidden = true;
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

    // Фильтры
    el.strength.addEventListener('input', () => {
      state.strength = +el.strength.value;
      el.strengthValue.textContent = state.strength;
      setFill(el.strength);
      dirtyAdjust = true;
      requestRender();
    });
    el.strength.addEventListener('change', commit);

    // Настройки
    el.btnAuto.addEventListener('click', autoEnhance);
    el.btnResetAdjust.addEventListener('click', () => {
      state.adjust = zeroAdjust();
      syncSliders();
      dirtyAdjust = true;
      requestRender();
      commit();
    });

    // Обрезка, поворот и наклон
    el.btnRotLeft.addEventListener('click', () => applyOrientation('rotLeft'));
    el.btnRotRight.addEventListener('click', () => applyOrientation('rotRight'));
    el.btnFlipH.addEventListener('click', () => applyOrientation('flipH'));
    el.btnFlipV.addEventListener('click', () => applyOrientation('flipV'));
    bindRange(el.angle, el.angleValue, formatDegrees, (v) => {
      state.angle = v;
      dirtyBase = true;
      requestRender();
    }, commit);
    el.angle.addEventListener('dblclick', () => {
      state.angle = 0;
      syncCrop();
      dirtyBase = true;
      requestRender();
      commit();
    });
    el.ratios.forEach((chip) => chip.addEventListener('click', () => setRatio(chip.dataset.ratio)));
    el.btnCropReset.addEventListener('click', () => {
      pendingCrop = { ...FULL };
      cropRatio = 'free';
      if (state.angle) {
        state.angle = 0;
        dirtyBase = true;
        commit();
        requestRender();
      }
      syncCrop();
      positionCropUI();
    });
    el.btnCropApply.addEventListener('click', () => applyCrop(true));
    el.cropBox.addEventListener('pointerdown', onCropPointerDown);
    el.cropBox.addEventListener('pointermove', onCropPointerMove);
    el.cropBox.addEventListener('pointerup', onCropPointerUp);
    el.cropBox.addEventListener('pointercancel', onCropPointerUp);

    // ИИ
    el.aiMode.forEach((b) => b.addEventListener('click', () => {
      aiTool = b.dataset.ai;
      brushHover = null;
      syncAI();
      updatePaintingCursor();
      requestRender();
    }));
    bindRange(el.eraseSize, el.eraseSizeValue, String, () => requestRender());
    el.btnEraseClear.addEventListener('click', () => {
      eraseStrokes = [];
      requestRender();
    });
    el.btnEraseRun.addEventListener('click', runEraser);
    el.btnBgRun.addEventListener('click', runBackground);
    el.bgMode.forEach((b) => b.addEventListener('click', () => {
      state.bg.mode = b.dataset.bg;
      dirtyBase = true;
      syncAI();
      requestRender();
      commit();
    }));
    bindRange(el.bgBlur, el.bgBlurValue, String, (v) => {
      state.bg.blur = v;
      dirtyAdjust = true;
      requestRender();
    }, commit);

    // Надписи
    el.btnAddText.addEventListener('click', addText);
    el.btnDeleteText.addEventListener('click', deleteSelectedItem);
    el.textInput.addEventListener('input', () => {
      const t = selectedItem();
      if (!t || t.kind !== 'text') return;
      t.text = el.textInput.value;
      ensureFont(fontOf(t), t.text);
      requestRender();
    });
    el.textInput.addEventListener('change', commit);
    el.textSize.addEventListener('input', () => updateItem({ size: +el.textSize.value }, false));
    el.textSize.addEventListener('change', commit);
    el.textRotation.addEventListener('input', () => updateItem({ rotation: +el.textRotation.value }, false));
    el.textRotation.addEventListener('change', commit);
    el.textRotation.addEventListener('dblclick', () => updateItem({ rotation: 0 }, true));
    el.textStyle.forEach((b) => b.addEventListener('click', () => updateItem({ style: b.dataset.style }, true)));

    // Стикеры
    el.stickerSize.addEventListener('input', () => updateItem({ size: +el.stickerSize.value }, false));
    el.stickerSize.addEventListener('change', commit);
    el.stickerRotation.addEventListener('input', () => updateItem({ rotation: +el.stickerRotation.value }, false));
    el.stickerRotation.addEventListener('change', commit);
    el.stickerRotation.addEventListener('dblclick', () => updateItem({ rotation: 0 }, true));
    el.btnDeleteSticker.addEventListener('click', deleteSelectedItem);

    // Рисунок
    bindRange(el.drawSize, el.drawSizeValue, String, () => requestRender());
    el.btnDrawClear.addEventListener('click', () => {
      if (!state.strokes.length) return;
      state.strokes = [];
      requestRender();
      commit();
    });

    // Рамка
    el.frameStyle.forEach((b) => b.addEventListener('click', () => {
      state.frame.style = b.dataset.frame;
      if (b.dataset.frame === 'polaroid' && state.frame.width < 20) state.frame.width = 30;
      syncFrame();
      requestRender();
      commit();
    }));
    bindRange(el.frameWidth, el.frameWidthValue, String, (v) => {
      state.frame.width = v;
      requestRender();
    }, commit);
    bindRange(el.frameRadius, el.frameRadiusValue, String, (v) => {
      state.frame.radius = v;
      requestRender();
    }, commit);

    // Указатель на фото
    el.canvas.addEventListener('pointerdown', onCanvasPointerDown);
    el.canvas.addEventListener('pointermove', onCanvasPointerMove);
    el.canvas.addEventListener('pointerup', onCanvasPointerUp);
    el.canvas.addEventListener('pointercancel', onCanvasPointerUp);
    el.canvas.addEventListener('pointerleave', () => {
      el.app.classList.remove('is-over-text');
      if (brushHover && !pointer) {
        brushHover = null;
        requestRender();
      }
    });
    el.canvas.addEventListener('dblclick', (e) => {
      const t = hitItem(canvasPoint(e));
      if (!t || t.kind !== 'text') return;
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
      el.qualityValue.textContent = el.quality.value + ' %';
      setFill(el.quality);
      schedulePrepareBlob();
    });
    el.btnDownload.addEventListener('click', download);
    el.btnShare.addEventListener('click', share);

    // Горячие клавиши
    window.addEventListener('keydown', (e) => {
      if (!original || el.saveDialog.open) return;
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
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !isTyping()) {
        e.preventDefault();
        deleteSelectedItem();
      } else if (e.key === 'Escape' && selectedId && !isTyping()) {
        selectItem(null);
      }
    });

    // Предупреждение, если закрыть вкладку с несохранёнными правками
    window.addEventListener('beforeunload', (e) => {
      if (original && historyIndex > 0) {
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
  buildItemControls();
  bindEvents();
  [el.strength, el.textSize, el.textRotation, el.stickerSize, el.stickerRotation, el.quality].forEach(setFill);
  syncUI();

  // Для проверки и отладки из консоли браузера
  window.kadr = {
    loadFile,
    getState: () => state,
    setTab,
    runEraser,
    runBackground,
    get busy() { return aiBusy; },
  };
})();
