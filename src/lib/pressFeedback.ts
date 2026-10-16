/**
 * iOS-style touch feedback for every button in the app, without touching each component:
 * on pointer-down we note where the finger/mouse landed (CSS vars --press-x/--press-y) and
 * restart the "bloom" animation defined in index.css (button.is-pressed::after).
 */
export function installPressFeedback(): void {
  if (typeof window === 'undefined') return;
  const timers = new WeakMap<HTMLElement, number>();

  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return;
      const btn = (e.target as Element | null)?.closest?.('button');
      if (!btn || btn.disabled || btn.classList.contains('no-glass')) return;
      const r = btn.getBoundingClientRect();
      const size = Math.max(r.width, r.height) * 1.6;
      btn.style.setProperty('--press-x', `${e.clientX - r.left}px`);
      btn.style.setProperty('--press-y', `${e.clientY - r.top}px`);
      btn.style.setProperty('--press-size', `${Math.round(size)}px`);
      // Restart the animation even on rapid repeated taps.
      btn.classList.remove('is-pressed');
      void btn.offsetWidth;
      btn.classList.add('is-pressed');
      const prev = timers.get(btn);
      if (prev) clearTimeout(prev);
      timers.set(btn, window.setTimeout(() => btn.classList.remove('is-pressed'), 700));
    },
    { passive: true, capture: true },
  );
}
