import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchZoneDetailPage } from '../src/pages/dispatch/DispatchZoneDetailPage';

/**
 * Zone detail (change-request 2026-07): the zone opens on its companies and plants — each plant with
 * its assignment (ticket) and batch counts — collapsed by company, expanding to plants that drill into
 * their batches. Unassignable tickets keep their NO_COVERAGE vs ALL_DROPPED reason + drop counts.
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
      companyName: 'UltraTech',
      stopSequence: 1,
      status: 'ACTIVE',
      ticketCount: 3,
      capacityUsed: { used: 4, cap: 25 },
    },
    {
      batchId: '901',
      scheduleId: '6',
      seId: 'se-uuid-2',
      seName: 'Suresh Rao',
      plantId: '10',
      plantName: 'Kotputli Works',
      companyName: 'UltraTech',
      stopSequence: 2,
      status: 'ACTIVE',
      ticketCount: 1,
      capacityUsed: { used: 4, cap: 25 },
    },
  ],
  plantStats: {
    '10': { totalDevices: 40, inactiveDevices: 5, assignedDevices: 12, unassignedDevices: 28 },
  },
  unassignable: [
    {
      ticketId: 't-uuid-1',
      deviceId: 'DEV-9001',
      plantId: '11',
      plantName: 'Nathdwara Works',
      companyName: 'Shree Cement',
      poolEmptyReason: 'NO_COVERAGE',
      dropCounts: {},
    },
    {
      ticketId: 't-uuid-2',
      deviceId: 'DEV-9002',
      plantId: '12',
      plantName: 'Kodinar Works',
      companyName: 'Ambuja',
      poolEmptyReason: 'ALL_DROPPED',
      dropCounts: { COMMON_KIT_INCOMPLETE: 2 },
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

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/dispatch-runs/42/zones/1']}>
      <Routes>
        <Route path="/dispatch-runs/:runId/zones/:zoneId" element={<DispatchZoneDetailPage />} />
        {/* A batch is addressed by its own id, not nested under the run. */}
        <Route path="/batches/:batchId" element={<div>batch page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Dispatch zone detail — companies & plants overview', () => {
  it('opens collapsed by company, expands to the plant with its assignment + batch counts', async () => {
    renderPage();

    // The company aggregates its plant's tickets/batches and is visible; the plant is hidden until expanded.
    const company = within(await screen.findByTestId('zone-company-row-UltraTech'));
    expect(company.getByText('UltraTech')).toBeInTheDocument();
    expect(company.getByText('1 plant')).toBeInTheDocument();
    expect(screen.queryByTestId('zone-plant-row-10')).not.toBeInTheDocument();

    await userEvent.click(company.getByText('UltraTech'));

    const plant = within(await screen.findByTestId('zone-plant-row-10'));
    expect(plant.getByText('Kotputli Works')).toBeInTheDocument();
    expect(plant.getByText('4')).toBeInTheDocument(); // 3 + 1 assignments across the plant's two batches
    // Fleet-context columns from plantStats: inactive/total, assigned, unassigned.
    expect(plant.getByText('5')).toBeInTheDocument(); // inactive
    expect(plant.getByText('/ 40')).toBeInTheDocument(); // total
    expect(plant.getByText('12')).toBeInTheDocument(); // assigned
    expect(plant.getByText('28')).toBeInTheDocument(); // unassigned
  });

  it('drills a multi-batch plant down to its batches, each linking to the batch detail', async () => {
    renderPage();
    await userEvent.click(await screen.findByText('UltraTech'));
    await userEvent.click(await screen.findByText('Kotputli Works'));

    // Two batches at this plant → an in-row batch list appears; a batch row navigates to its detail.
    const batchRow = within(await screen.findByTestId('zone-batch-row-901'));
    expect(batchRow.getByText('Suresh Rao')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('zone-batch-row-901'));
    expect(await screen.findByText('batch page')).toBeInTheDocument();
  });

  it('keeps the unassignable table with its NO_COVERAGE reason', async () => {
    renderPage();
    const un = within(await screen.findByTestId('dispatch-unassignable-row-t-uuid-1'));
    expect(un.getByText('DEV-9001')).toBeInTheDocument();
    expect(un.getByText('Shree Cement')).toBeInTheDocument(); // company under plant
    expect(un.getByText('No coverage')).toBeInTheDocument();
  });

  it('filters the unassignable table by reason and searches by company', async () => {
    renderPage();
    // Both rows present initially.
    expect(await screen.findByTestId('dispatch-unassignable-row-t-uuid-1')).toBeInTheDocument();
    expect(screen.getByTestId('dispatch-unassignable-row-t-uuid-2')).toBeInTheDocument();

    // Reason filter → only ALL_DROPPED (Ambuja) survives.
    await userEvent.selectOptions(screen.getByLabelText(/filter by reason/i), 'ALL_DROPPED');
    expect(screen.queryByTestId('dispatch-unassignable-row-t-uuid-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('dispatch-unassignable-row-t-uuid-2')).toBeInTheDocument();

    // Reset, then search by company name → only Shree Cement.
    await userEvent.selectOptions(screen.getByLabelText(/filter by reason/i), '');
    await userEvent.type(screen.getByLabelText(/search unassignable/i), 'shree');
    expect(await screen.findByTestId('dispatch-unassignable-row-t-uuid-1')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatch-unassignable-row-t-uuid-2')).not.toBeInTheDocument();
  });
});
