import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchZoneDetailPage } from '../src/pages/dispatch/DispatchZoneDetailPage';

/**
 * Issue 123 — zone detail: dispatched batches (SE, plant, capacity used against the frozen snapshot)
 * and unassignable tickets with their NO_COVERAGE vs ALL_DROPPED reason + drop counts.
 */
const zoneDetail = {
  runId: '42',
  zone: {
    zoneId: '1',
    zoneName: 'North',
    mode: 'DEFICIT',
    weightSetRef: 'v1',
    ticketsConsidered: 3,
    recommended: 2,
    unassignable: 1,
    unassignableReasons: { NO_COVERAGE: 1, ALL_DROPPED: 0, dropBuckets: {} },
    schedules: 1,
    batches: 1,
    ticketsDispatched: 1,
    error: null,
  },
  batches: [
    {
      batchId: '900',
      scheduleId: '5',
      seId: 'se-uuid-1',
      seName: 'Ramesh Kumar',
      plantId: '10',
      plantName: 'Kotputli Works',
      stopSequence: 1,
      status: 'ACTIVE',
      ticketCount: 1,
      capacityUsed: { used: 1, cap: 25 },
    },
  ],
  unassignable: [
    {
      ticketId: 't-uuid-1',
      deviceId: 'DEV-9001',
      plantId: '11',
      plantName: 'Nathdwara Works',
      poolEmptyReason: 'NO_COVERAGE',
      dropCounts: {},
    },
  ],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => json(zoneDetail)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Dispatch zone detail (Issue 123)', () => {
  it('renders the batch row with SE + capacity, and the unassignable row with its reason', async () => {
    render(
      <MemoryRouter initialEntries={['/dispatch-runs/42/zones/1']}>
        <Routes>
          <Route path="/dispatch-runs/:runId/zones/:zoneId" element={<DispatchZoneDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const batch = within(await screen.findByTestId('dispatch-batch-row-900'));
    expect(batch.getByText('Ramesh Kumar')).toBeInTheDocument();
    expect(batch.getByText('Kotputli Works')).toBeInTheDocument();
    expect(batch.getByText('1 / 25')).toBeInTheDocument();

    const un = within(await screen.findByTestId('dispatch-unassignable-row-t-uuid-1'));
    expect(un.getByText('DEV-9001')).toBeInTheDocument();
    expect(un.getByText('No coverage')).toBeInTheDocument();
  });
});
