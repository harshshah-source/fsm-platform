import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ActionRequiredCard, CriticalQueueGroup } from '../src/api/dashboard';
import { ActionRequiredPanel } from '../src/pages/dashboard/ActionRequiredPanel';
import { CriticalQueue } from '../src/pages/dashboard/CriticalQueue';

/**
 * Issue 06 slice 7 — Grouped Critical Work Queue (AC#4) + Action Required panel (AC#1).
 */
const groups: CriticalQueueGroup[] = [
  {
    companyId: '10',
    companyName: 'Acme Logistics',
    companyTier: 'PLATINUM',
    zoneId: '1',
    plantId: '7',
    plantName: 'Yard-1',
    clusterSize: 2,
    suggestedSes: [],
    tickets: [
      { ticketId: 't1', deviceId: '900', slaBucket: 'CRITICAL', status: 'OPEN' },
      { ticketId: 't2', deviceId: '901', slaBucket: 'HIGH_CRITICAL', status: 'OPEN' },
    ],
  },
];

const cards: ActionRequiredCard[] = [
  { key: 'a', label: 'Auto-dispatched batches awaiting review', urgency: 1, count: 0, available: false, source: 'Issue 11' },
  { key: 'b', label: 'Manual assignment required', urgency: 2, count: 3, available: true, source: 'Issue 30' },
];

describe('Grouped Critical Work Queue (Issue 06 AC#4)', () => {
  it('groups CRITICAL+ tickets by company/plant with cluster size and a stubbed SE suggestion', () => {
    render(<CriticalQueue groups={groups} />);

    const group = screen.getByText('Yard-1').closest('[data-testid="critical-group"]')!;
    expect(within(group as HTMLElement).getByText('Acme Logistics')).toBeInTheDocument();
    expect(within(group as HTMLElement).getByText(/cluster.*2/i)).toBeInTheDocument();
    expect(within(group as HTMLElement).getByText(/900/)).toBeInTheDocument();
    expect(within(group as HTMLElement).getByText(/901/)).toBeInTheDocument();
    // Suggested-SE + assign are present but inert until the Recommender (Issue 10/11).
    const assign = within(group as HTMLElement).getByRole('button', { name: /assign/i });
    expect(assign).toBeDisabled();
  });
});

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
