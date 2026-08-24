import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ActionRequiredCard } from '../src/api/dashboard';
import { ActionRequiredPanel } from '../src/pages/dashboard/ActionRequiredPanel';

/**
 * Issue 06 slice 7 — Action Required panel (AC#1). The Grouped Critical Work Queue this file also
 * covered was retired by #277 — `dashboard/CriticalQueue.tsx` was orphaned (imported by nothing) and
 * is absorbed into the Assign Work Console's Critical+ preset (`assign-console.test.tsx`); the cluster
 * size signal survives as the pool's `criticalCount` badge, and the deferral-confirm wiring survives
 * as `ReviewCommitScreen`'s "Resolve hold" flow (already covered by `assign-console.test.tsx`) plus
 * `deferral-override-confirm.test.tsx`'s direct `DeferralConfirm` coverage.
 */
const cards: ActionRequiredCard[] = [
  { key: 'a', label: 'Auto-dispatched batches awaiting review', urgency: 1, count: 0, available: false, source: 'Issue 11' },
  { key: 'b', label: 'Manual assignment required', urgency: 2, count: 3, available: true, source: 'Issue 30' },
];

describe('Action Required panel (Issue 06 AC#1)', () => {
  it('renders cards in urgency order, stubbing unbuilt sources gracefully', () => {
    render(<ActionRequiredPanel cards={cards} />);

    const items = screen.getAllByTestId('action-card');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(/batches awaiting review/i);
    expect(items[1]).toHaveTextContent(/manual assignment/i);
    // Unbuilt source → "coming soon" stub; built source shows its count.
    expect(within(items[0]).getByText(/coming soon/i)).toBeInTheDocument();
    expect(within(items[1]).getByText('3')).toBeInTheDocument();
  });
});
