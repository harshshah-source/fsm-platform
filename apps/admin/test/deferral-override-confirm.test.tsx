import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DeferralConflict } from '../src/api/schedules';
import { DeferralConfirm } from '../src/components/domain/DeferralConfirm';

/**
 * #249 AC5 — the assign surfaces surface the hold instead of swallowing it.
 *
 * The backend answers a 409 `CONFLICT_DEFERRED` when a manager assigns a ticket whose vehicle is not
 * due back yet. Left unhandled, that is worse than the silent bypass it replaced: the click would
 * simply fail with no explanation. So the caller holds the assign, shows what it is overriding — the
 * return date, and the SE's proposed date beside the authoritative one when a manager has moved it
 * (#245) — and requires a reason before it will resend with `confirm`.
 *
 * Exercised directly against `DeferralConfirm` (#277) rather than through a host component: it is a
 * shared presentational component with three live hosts today — `ReviewCommitScreen`'s "Resolve hold"
 * (#275, its own end-to-end coverage in `assign-console.test.tsx`), `IntradayManualAssignModal` (#277),
 * and formerly the now-retired `CriticalQueue`'s one-click assign. Pinning the banner/reason/confirm/
 * cancel mechanics here once means the behaviour survives whichever host renders it, instead of being
 * re-proven per host.
 */
const CONFLICT: DeferralConflict = {
  code: 'CONFLICT_DEFERRED',
  message: 'Ticket is held to a future vehicle-return date — resend with confirm=true and a reason.',
  ticketId: 't1',
  deferredUntil: '2026-06-26T00:00:00.000Z',
  vuReport: {
    id: '42',
    proposedFrom: '2026-06-25T09:00:00.000Z',
    expectedFrom: '2026-06-26T09:00:00.000Z',
  },
};

describe('#249 AC5 — DeferralConfirm', () => {
  it('shows the return-date context and refuses an empty reason', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<DeferralConfirm conflict={CONFLICT} onConfirm={onConfirm} onCancel={onCancel} />);

    const banner = screen.getByTestId('deferral-conflict-banner');
    expect(within(banner).getByTestId('deferral-until')).toHaveTextContent('2026-06-26');
    expect(within(banner).getByTestId('deferral-proposed-from')).toHaveTextContent('2026-06-25');
    expect(within(banner).getByTestId('deferral-expected-from')).toHaveTextContent('2026-06-26');

    expect(within(banner).getByRole('button', { name: /confirm/i })).toBeDisabled();
    await userEvent.type(within(banner).getByLabelText(/reason/i), '   ');
    expect(within(banner).getByRole('button', { name: /confirm/i })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms with the stated reason once the manager states one', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<DeferralConfirm conflict={CONFLICT} onConfirm={onConfirm} onCancel={onCancel} />);

    const banner = screen.getByTestId('deferral-conflict-banner');
    await userEvent.type(within(banner).getByLabelText(/reason/i), 'vehicle sourced locally');
    await userEvent.click(within(banner).getByRole('button', { name: /confirm/i }));

    expect(onConfirm).toHaveBeenCalledWith('vehicle sourced locally');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancelling calls onCancel and confirms nothing', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<DeferralConfirm conflict={CONFLICT} onConfirm={onConfirm} onCancel={onCancel} />);

    await userEvent.click(within(screen.getByTestId('deferral-conflict-banner')).getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a report-less deferral (a ZM hold, not an SE-proposed one) shows the date alone', () => {
    const noReport: DeferralConflict = { ...CONFLICT, vuReport: null };
    render(<DeferralConfirm conflict={noReport} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    const banner = screen.getByTestId('deferral-conflict-banner');
    expect(within(banner).getByTestId('deferral-until')).toHaveTextContent('2026-06-26');
    expect(within(banner).queryByTestId('deferral-proposed-from')).toBeNull();
    expect(within(banner).queryByTestId('deferral-expected-from')).toBeNull();
  });
});
