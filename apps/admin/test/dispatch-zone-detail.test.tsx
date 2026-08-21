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
    outcome: 'DONE',
    contendedWithRunId: null,
    withheldBelowThreshold: 4,
    bucketlessDropped: 12,
    componentBlockedWithheld: null,
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

/** #252 — the same page over a different payload, for the ledger-counter cases. */
function renderWith(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => json(body)));
  renderPage();
}

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
    // Scoped to the Batches cell — issue #160's leading S.No. column also reads "2" for this row (it
    // is the second visible row overall), so a bare getByText('2') is now ambiguous.
    const cells = plant.getAllByRole('cell');
    expect(cells[cells.length - 2]).toHaveTextContent('2'); // 2 batches formed at this plant in the run
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

  /**
   * #252 (landed with #259) — the two "the engine did not decide" populations were written to the
   * ledger by #238 and #242 and read by nobody, so `recommended + unassignable` read as the whole
   * funnel while a larger population sat outside it. #177's third column has the same shape and is
   * included here for the same reason.
   *
   * They are rendered apart from `unassignable` and from each other on purpose: `unassignable` is an
   * Ops coverage gap, "not looked at yet" is policy working, "no SLA bucket" is a data fault and
   * "waiting on a part" is the warehouse's clock. Folding them together sends the wrong team.
   */
  it('#252 — shows the withheld and bucket-less populations apart from unassignable', async () => {
    renderWith(zoneDetail);
    const funnel = await screen.findByTestId('zone-funnel');
    expect(funnel).toHaveTextContent(/1 unassignable/);
    expect(funnel).toHaveTextContent(/held below threshold: 4/i);
    expect(funnel).toHaveTextContent(/no SLA bucket: 12/i);
  });

  /**
   * `bucketless_dropped` and `component_blocked_withheld` are nullable precisely so a run predating the
   * counter does not claim a measurement nobody took. "0" would be that claim.
   */
  it('#252 — a null counter reads as "not recorded", never as 0', async () => {
    renderWith({ ...zoneDetail, zone: { ...zoneDetail.zone, bucketlessDropped: null, componentBlockedWithheld: null } });
    const funnel = await screen.findByTestId('zone-funnel');
    expect(funnel).toHaveTextContent(/no SLA bucket: not recorded/i);
    expect(funnel).not.toHaveTextContent(/no SLA bucket: 0/i);
  });

  /** The newest of the three (#177) renders on the same terms once a run has measured it. */
  it('#252 — the component-blocked population renders when the run measured it', async () => {
    renderWith({ ...zoneDetail, zone: { ...zoneDetail.zone, componentBlockedWithheld: 7 } });
    expect(await screen.findByTestId('zone-funnel')).toHaveTextContent(/waiting on a part: 7/i);
  });
});
