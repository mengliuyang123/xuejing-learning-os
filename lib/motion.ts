import type { Transition } from "motion/react";

/**
 * Shared Motion tokens for 「学径」 desktop workbench:
 * Calm, zero-overshoot physics focused strictly on showing state transitions.
 */
export const EASE_OUT_EXPO = [0.22, 1, 0.36, 1] as const;

export const SPRING_CRISP: Transition = {
  type: "spring",
  visualDuration: 0.22,
  bounce: 0,
};

export const SPRING_PANEL: Transition = {
  type: "spring",
  visualDuration: 0.24,
  bounce: 0,
};

export const TRANSITION_STATE: Transition = {
  duration: 0.18,
  ease: EASE_OUT_EXPO,
};

export const TRANSITION_FAST: Transition = {
  duration: 0.14,
  ease: EASE_OUT_EXPO,
};
