import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RollingNumber } from '../src/components/data/RollingNumber';

/**
 * The odometer refresh on the OH dashboard KPI cards (Run-Ingestion feature). The roll is keyed on a
 * run-completion token, NOT on a value diff — so a completed run always gives the operator a visible
 * confirmation of fresh data, even when the underlying number did not move. Motion is opt-out
 * (prefers-reduced-motion) and a zero-duration/instant mode lets assertions read the exact final value.
 */

// A controllable requestAnimationFrame so the count-up advances deterministically frame-by-frame.
let rafQueue: Array<(t: number) => void> = [];
function flush(ts: number) {
  const q = rafQueue;
  rafQueue = [];
  act(() => q.forEach((cb) => cb(ts)));
}

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const read = () => screen.getByTestId('rn').textContent;

describe('RollingNumber odometer', () => {
  it('renders the exact value at rest and does not roll on mount', () => {
    render(
      <div data-testid="rn">
        <RollingNumber value={91} runToken={null} durationMs={100} />
      </div>,
    );
    // No run has completed yet — the number is shown verbatim, no animation frames queued.
    expect(read()).toBe('91');
    expect(rafQueue).toHaveLength(0);
  });

  it('replays the roll when the run token changes even though the value is unchanged', () => {
    const { rerender } = render(
      <div data-testid="rn">
        <RollingNumber value={50} runToken={1} durationMs={100} />
      </div>,
    );
    expect(read()).toBe('50');

    // A run completes: same value, new token → the odometer must roll from a zeroed transient up to 50.
    rerender(
      <div data-testid="rn">
        <RollingNumber value={50} runToken={2} durationMs={100} />
      </div>,
    );
    flush(0);
    expect(Number(read())).toBeLessThan(50); // rolling has started from below the target

    flush(50);
    const mid = Number(read());
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(50);

    flush(100);
    expect(read()).toBe('50'); // settles on the exact real value
  });

  it('snaps instantly (no animation frames) when prefers-reduced-motion is set', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));

    const { rerender } = render(
      <div data-testid="rn">
        <RollingNumber value={30} runToken={1} durationMs={100} />
      </div>,
    );
    rerender(
      <div data-testid="rn">
        <RollingNumber value={30} runToken={2} durationMs={100} />
      </div>,
    );
    expect(read()).toBe('30');
    expect(rafQueue).toHaveLength(0);
  });

  it('snaps to the exact final value in instant mode (test seam)', () => {
    const { rerender } = render(
      <div data-testid="rn">
        <RollingNumber value={42} runToken={1} instant />
      </div>,
    );
    rerender(
      <div data-testid="rn">
        <RollingNumber value={7} runToken={2} instant />
      </div>,
    );
    expect(read()).toBe('7');
    expect(rafQueue).toHaveLength(0);
  });

  it('reflects a value change that arrives without a run (data load) by snapping', () => {
    const { rerender } = render(
      <div data-testid="rn">
        <RollingNumber value={0} runToken={null} durationMs={100} />
      </div>,
    );
    expect(read()).toBe('0');
    // Initial data resolves later; token unchanged → snap to the loaded value, no roll.
    rerender(
      <div data-testid="rn">
        <RollingNumber value={166} runToken={null} durationMs={100} />
      </div>,
    );
    expect(read()).toBe('166');
    expect(rafQueue).toHaveLength(0);
  });
});
