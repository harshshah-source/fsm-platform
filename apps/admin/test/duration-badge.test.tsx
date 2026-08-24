import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurationBadge } from '../src/components/domain/badges';

/**
 * Issue 3 — per-device surfaces show the actual inactive duration instead of the severity label. The
 * bucket still drives colour + the `bucket-<B>` severity hook, but the visible text is the elapsed time
 * since the device's last GPS ping.
 */
const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');
const ago = (ms: number) => new Date(FIXED_NOW.getTime() - ms).toISOString();

afterEach(() => vi.useRealTimers());

describe('Issue 3 — DurationBadge', () => {
  it('renders the compact inactive duration, not the bucket word', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    render(<DurationBadge bucket="CRITICAL" latestGpsDatetime={ago(4 * 86_400_000 + 6 * 3_600_000)} />);
    const badge = screen.getByTestId('bucket-CRITICAL');
    expect(badge).toHaveTextContent('4d 6h');
    expect(badge).not.toHaveTextContent(/critical/i);
  });

  it('falls back to the bucket label (its inactivity range) when no timestamp is available', () => {
    render(<DurationBadge bucket="SEVERE" latestGpsDatetime={null} />);
    expect(screen.getByTestId('bucket-SEVERE')).toHaveTextContent('3–5d');
  });

  it('renders nothing for an ACTIVE (null) bucket', () => {
    const { container } = render(<DurationBadge bucket={null} latestGpsDatetime={ago(1000)} />);
    expect(container).toBeEmptyDOMElement();
  });
});
