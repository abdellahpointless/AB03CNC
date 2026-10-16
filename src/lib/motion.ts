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
