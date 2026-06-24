import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CriticalQueueGroup } from '../src/api/dashboard';
import { CriticalQueue } from '../src/pages/dashboard/CriticalQueue';

/**
 * Issue 13b AC#6 — the Grouped Critical Work Queue "Assign" wires to the one-click assign endpoint
 * (`POST /api/schedules/assign`), creating a Formal Assignment. The target SE comes from the
 * zone-scoped engineer list. Assigning a plant cluster assigns each ticket in the group.
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

const engineers = [
  { engineerId: 'se-north-1', coverageType: 'MULTI_PLANT', zoneId: '1', dailyCapacity: 10, isActive: true },
  { engineerId: 'se-north-2', coverageType: 'MULTI_PLANT', zoneId: '1', dailyCapacity: 10, isActive: true },
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Critical Queue assign (Issue 13b AC#6)', () => {
  it('assigns the cluster to a picked SE via the one-click assign endpoint', async () => {
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      const u = String(url);
      if (u.includes('/schedules/assign') && (opts?.method ?? 'GET') === 'POST') {
        const body = JSON.parse(String(opts?.body)) as { ticketId: string; seId: string };
        return json({ result: 'OK', scheduleId: '1', batchId: '1', ticketId: body.ticketId, seId: body.seId });
      }
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const onAssigned = vi.fn();
    render(<CriticalQueue groups={groups} engineers={engineers} onAssigned={onAssigned} />);

    const group = screen.getByText('Yard-1').closest('[data-testid="critical-group"]') as HTMLElement;
    const picker = within(group).getByLabelText(/assign to/i);
    expect(within(group).getByRole('button', { name: /assign/i })).toBeDisabled();

    await userEvent.selectOptions(picker, 'se-north-2');
    await userEvent.click(within(group).getByRole('button', { name: /assign/i }));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([url, opts]) =>
          String(url).includes('/schedules/assign') && (opts as RequestInit | undefined)?.method === 'POST',
      );
      const bodies = posts.map(([, opts]) => String((opts as RequestInit).body));
      expect(bodies.some((b) => b.includes('"ticketId":"t1"') && b.includes('"seId":"se-north-2"'))).toBe(true);
      expect(bodies.some((b) => b.includes('"ticketId":"t2"') && b.includes('"seId":"se-north-2"'))).toBe(true);
    });

    await waitFor(() => expect(onAssigned).toHaveBeenCalled());
  });
});
