/* ==========================================================
   Кадр — главная страница.
   Ползунки сравнения «до и после» на примерах.
   ========================================================== */
'use strict';

(() => {
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.querySelectorAll('[data-ba]').forEach((box) => {
    const handle = box.querySelector('.ba-handle');
    let pos = 50;

    const set = (value) => {
      pos = clamp(value, 0, 100);
      box.style.setProperty('--pos', pos + '%');
      handle.setAttribute('aria-valuenow', String(Math.round(pos)));
    };

    const fromEvent = (e) => {
      const rect = box.getBoundingClientRect();
      set(((e.clientX - rect.left) / rect.width) * 100);
    };

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let decided = false;

    box.addEventListener('pointerdown', (e) => {
      dragging = true;
      decided = e.pointerType === 'mouse';
      startX = e.clientX;
      startY = e.clientY;
      if (decided) {
        box.setPointerCapture(e.pointerId);
        box.classList.add('is-dragging');
        fromEvent(e);
      }
    });

    box.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      if (!decided) {
        // На телефоне: горизонтальное движение двигает ползунок, вертикальное листает страницу
        const dx = Math.abs(e.clientX - startX);
        const dy = Math.abs(e.clientY - startY);
        if (dx < 6 && dy < 6) return;
        if (dy > dx) { dragging = false; return; }
        decided = true;
        box.setPointerCapture(e.pointerId);
        box.classList.add('is-dragging');
      }
      fromEvent(e);
    });

    const stop = (e) => {
      if (dragging && !decided && e && e.type === 'pointerup') fromEvent(e); // простое касание
      dragging = false;
      box.classList.remove('is-dragging');
    };
    box.addEventListener('pointerup', stop);
    box.addEventListener('pointercancel', stop);

    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 20 : 5;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { set(pos - step); e.preventDefault(); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { set(pos + step); e.preventDefault(); }
      if (e.key === 'Home') { set(0); e.preventDefault(); }
      if (e.key === 'End') { set(100); e.preventDefault(); }
    });

    set(50);

    // Первый экран: ползунок один раз проезжает, чтобы было видно, что его можно двигать
    if (box.hasAttribute('data-intro') && !reduceMotion) {
      const run = () => {
        const start = performance.now();
        const duration = 1600;
        const frame = (now) => {
          if (dragging) return;
          const t = Math.min(1, (now - start) / duration);
          const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
          set(85 - 35 * ease);
          if (t < 1) requestAnimationFrame(frame);
        };
        set(85);
        requestAnimationFrame(frame);
      };
      const img = box.querySelector('.ba-after');
      if (img.complete) setTimeout(run, 400);
      else img.addEventListener('load', () => setTimeout(run, 400), { once: true });
    }
  });
})();
