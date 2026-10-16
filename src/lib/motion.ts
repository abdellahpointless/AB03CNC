import type { Transition } from 'motion/react';

/**
 * Shared motion vocabulary (mirrors the --ease-* / --dur-* tokens in index.css).
 * UI motion stays under 300 ms, uses ease-out curves (never ease-in) and only
 * animates transform + opacity. Springs are critically damped (bounce 0) unless the
 * element itself is "thrown" (toasts).
 */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;

/** Modals and sheets: settle without overshoot. */
export const SPRING_MODAL: Transition = { type: 'spring', duration: 0.3, bounce: 0 };
/** Toasts: a hint of bounce, they "arrive" from the edge. */
export const SPRING_TOAST: Transition = { type: 'spring', duration: 0.45, bounce: 0.15 };
/** Sliding indicators (tab underline). */
export const SPRING_INDICATOR: Transition = { type: 'spring', duration: 0.3, bounce: 0 };
/** Exits are quicker than entrances. */
export const EXIT_FAST: Transition = { duration: 0.15, ease: EASE_OUT };
export const FADE: Transition = { duration: 0.2, ease: EASE_OUT };

/** iOS-style "pop": a quick spring with a little life in it, used for menus, popovers, sheets. */
export const SPRING_POP: Transition = { type: 'spring', duration: 0.42, bounce: 0.22 };
/** Liquid tab pill: slides between tabs and settles with a soft wobble. */
export const SPRING_PILL: Transition = { type: 'spring', duration: 0.45, bounce: 0.25 };

/**
 * Surfaces "materialise" like on iOS: they grow from slightly smaller, de-blur and fade in
 * together, then dissolve the same way (quicker) when closing. The blur filter is removed when
 * the animation ends so it never interferes with backdrop-filter or text sharpness.
 */
export const iosSurface = {
  initial: { opacity: 0, scale: 0.9, y: 10, filter: 'blur(8px)' },
  animate: { opacity: 1, scale: 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none' } },
  exit: { opacity: 0, scale: 0.94, y: 6, filter: 'blur(6px)', transition: { duration: 0.18, ease: EASE_OUT } },
  transition: SPRING_POP,
} as const;

/** Small menus/popovers: grow out of their trigger (set transformOrigin on the element). */
export const iosMenu = {
  initial: { opacity: 0, scale: 0.6, filter: 'blur(6px)' },
  animate: { opacity: 1, scale: 1, filter: 'blur(0px)', transitionEnd: { filter: 'none' } },
  exit: { opacity: 0, scale: 0.75, filter: 'blur(4px)', transition: { duration: 0.16, ease: EASE_OUT } },
  transition: SPRING_POP,
} as const;

/** Dimmed backdrop behind sheets. */
export const iosBackdrop = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: EXIT_FAST },
  transition: FADE,
} as const;

/** Lists inside menus/sheets ripple in one after another (a "wave"). */
export const waveItem = (i: number) => ({
  initial: { opacity: 0, y: 10, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: { type: 'spring' as const, duration: 0.4, bounce: 0.18, delay: Math.min(i, 10) * 0.035 },
});
