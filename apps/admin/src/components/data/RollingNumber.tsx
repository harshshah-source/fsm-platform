import { useEffect, useRef, useState } from 'react';

/** True only when the environment reports a reduced-motion preference (guarded for jsdom). */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

export interface RollingNumberOptions {
  /** Bump this on run-completion to (re)play the roll — the trigger is the token change, not a value diff. */
  runToken?: unknown;
  durationMs?: number;
  /** Test seam / forced snap: resolve straight to the target with no animation. */
  instant?: boolean;
}

/**
 * Odometer count-up for a single integer KPI. The roll fires when `runToken` changes — so a completed
 * ingestion run always animates, even if the number is unchanged (it rolls up from a zeroed transient).
 * A value change that arrives WITHOUT a token change (initial data load, unrelated re-render) snaps, so
 * the card reads its real value at rest. Reduced-motion, `instant`, or a non-positive duration all snap.
 */
export function useRollingNumber(target: number, opts: RollingNumberOptions = {}): number {
  const { runToken, durationMs = 700, instant = false } = opts;
  // Non-null only WHILE a roll is in flight; otherwise the display is derived from `target` during
  // render, so a value change that arrives without a run (data load) shows instantly — no effect hop.
  const [animated, setAnimated] = useState<number | null>(null);
  const prevToken = useRef<unknown>(runToken);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    // The roll is keyed on run-completion (the token), NOT on a value diff.
    if (prevToken.current === runToken) return;
    prevToken.current = runToken;

    const canAnimate =
      !instant &&
      durationMs > 0 &&
      !prefersReducedMotion() &&
      typeof requestAnimationFrame === 'function';
    if (!canAnimate) {
      setAnimated(null); // snap — render shows the exact target
      return;
    }

    const from = 0; // zeroed transient so the roll plays even when target === previous value
    let startTs: number | null = null;
    setAnimated(from);
    const step = (now: number): void => {
      if (startTs === null) startTs = now;
      const t = Math.min(1, (now - startTs) / durationMs);
      if (t < 1) {
        setAnimated(Math.round(from + (target - from) * easeOutCubic(t)));
        frame.current = requestAnimationFrame(step);
      } else {
        setAnimated(null); // settle → render shows the exact real value
      }
    };
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runToken]);

  return animated ?? target;
}

/** Renders a single KPI integer as animated text. See `useRollingNumber`. */
export function RollingNumber({
  value,
  runToken,
  durationMs,
  instant,
}: { value: number } & RollingNumberOptions) {
  const display = useRollingNumber(value, { runToken, durationMs, instant });
  return <>{display}</>;
}
