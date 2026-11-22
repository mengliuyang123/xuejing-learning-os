/**
 * Personality-driven spring physics engine (zero external runtime dependencies).
 *
 * - SPRING_SNAP (stiffness: 1200, damping: 80): crisp, zero-overshoot magnetic lock for drag release & panel resize.
 * - SPRING_POP  (stiffness: 380, damping: 16): playful, bouncy micro-feedback for completions, ratings, and likes.
 */

export type SpringConfig = {
  stiffness: number;
  damping: number;
  mass?: number;
  precision?: number;
};

export const SPRING_SNAP: SpringConfig = {
  stiffness: 1200,
  damping: 80,
  mass: 1,
  precision: 0.25,
};

export const SPRING_POP: SpringConfig = {
  stiffness: 380,
  damping: 16,
  mass: 1,
  precision: 0.002,
};

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function animateSpring(opts: {
  from: number;
  to: number;
  velocity?: number;
  config: SpringConfig;
  onUpdate: (value: number) => void;
  onComplete?: () => void;
}): () => void {
  const { from, to, config, onUpdate, onComplete } = opts;
  if (prefersReducedMotion() || Math.abs(to - from) < (config.precision ?? 0.01)) {
    onUpdate(to);
    onComplete?.();
    return () => {};
  }

  let position = from;
  let velocity = opts.velocity ?? 0;
  const mass = config.mass ?? 1;
  const precision = config.precision ?? 0.01;
  let lastTime = performance.now();
  let rafId = 0;
  let cancelled = false;

  const step = (now: number) => {
    if (cancelled) return;
    // Cap dt to 32ms to stay numerically stable across frame drops
    const dt = Math.min(0.032, Math.max(0.001, (now - lastTime) / 1000));
    lastTime = now;

    // Sub-step integration for high stiffness (e.g. stiffness=1200)
    const subSteps = config.stiffness >= 800 ? 4 : 2;
    const subDt = dt / subSteps;
    for (let i = 0; i < subSteps; i++) {
      const displacement = position - to;
      const springForce = -config.stiffness * displacement;
      const dampingForce = -config.damping * velocity;
      const accel = (springForce + dampingForce) / mass;
      velocity += accel * subDt;
      position += velocity * subDt;
    }

    onUpdate(position);

    if (
      Math.abs(position - to) <= precision &&
      Math.abs(velocity) <= precision * 10
    ) {
      onUpdate(to);
      onComplete?.();
      return;
    }
    rafId = requestAnimationFrame(step);
  };

  rafId = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    if (rafId) cancelAnimationFrame(rafId);
  };
}

/**
 * Triggers a playful bouncy scale feedback (stiffness: 380, damping: 16) directly on a DOM element.
 */
export function triggerSpringPop(el: HTMLElement | null) {
  if (!el || prefersReducedMotion()) return;
  animateSpring({
    from: 0.86,
    to: 1,
    velocity: 4.5,
    config: SPRING_POP,
    onUpdate: (scale) => {
      el.style.transform = `scale(${scale.toFixed(4)})`;
    },
    onComplete: () => {
      el.style.transform = "";
    },
  });
}

/**
 * Snaps a dragged panel width to the nearest detent if close, using SPRING_SNAP (1200 / 80).
 */
export function snapWidthWithSpring(opts: {
  current: number;
  min: number;
  max: number;
  detents?: number[];
  onUpdate: (w: number) => void;
}): () => void {
  const clamped = Math.max(opts.min, Math.min(opts.max, opts.current));
  const detents = opts.detents ?? [340, 390, 440, 520];
  let target = clamped;
  for (const d of detents) {
    if (Math.abs(clamped - d) <= 18 && d >= opts.min && d <= opts.max) {
      target = d;
      break;
    }
  }
  return animateSpring({
    from: opts.current,
    to: target,
    config: SPRING_SNAP,
    onUpdate: (v) => opts.onUpdate(Math.round(v)),
  });
}
