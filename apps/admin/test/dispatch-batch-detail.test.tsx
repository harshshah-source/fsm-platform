import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchBatchDetailPage } from '../src/pages/dispatch/DispatchBatchDetailPage';

/**
 * Issue 123 — batch detail: the assignment table with the inline "why this SE" decision trace. Pins
 * the two audit guarantees: the numeric score is hidden while scoreDegenerate holds (selection basis
 * reads "Precedence"), and expanding a row lazily loads + renders the precedence-terms trace with
 * SE names (not UUIDs).
 */
const batch = {
  runId: '42',
  batchId: '900',
  scheduleId: '5',
  zoneId: '1',
  seId: 'se-uuid-1',
  seName: 'Ramesh Kumar',
  plantId: '10',
  plantName: 'Kotputli Works',
  rows: [
    {
      ticketId: 't-uuid-1',
      deviceId: 'DEV-9001',
      companyName: 'UltraTech',
      vehicleNo: 'RJ14-GA-1234',
      transporterName: 'Blue Dart',
      // AutoPlant enrichment. The ping is relative to now, so the derived duration is stable without
      // fake timers; the trip stamp is mid-day UTC so its calendar date survives any viewer timezone.
      deviceType: 'V5',
      imsiNo: '0404920694896515',
      latestGpsDatetime: new Date(Date.now() - 26 * 3600_000).toISOString(),
      tripCreationDatetime: '2026-07-13T08:36:27.000Z',
      plantId: '10',
      seId: 'se-uuid-1',
      sortOrder: 0,
      rank: 1,
      score: 4.2,
      scoreDegenerate: true,
      recStatus: 'DISPATCHED',
      ticketStatus: 'OPEN',
      hasTrace: true,
    },
    {
      // Sparse at source (IMSI ~85% / Device Type ~93% of the fleet) and never-tripped devices exist —
      // this row carries none of the enrichment, so the columns must degrade to "—".
      ticketId: 't-uuid-2',
      deviceId: 'DEV-9002',
      companyName: 'UltraTech',
      vehicleNo: 'RJ14-GA-5678',
      transporterName: 'Gati',
      deviceType: null,
      imsiNo: null,
      latestGpsDatetime: null,
      tripCreationDatetime: null,
      plantId: '10',
      seId: 'se-uuid-1',
      sortOrder: 1,
      rank: 2,
      score: 4.2,
      scoreDegenerate: true,
      recStatus: 'DISPATCHED',
      ticketStatus: 'OPEN',
      hasTrace: false,
    },
  ],
};

const trace = {
  runId: '42',
  ticketId: 't-uuid-1',
  seId: 'se-uuid-1',
  scoreBreakdown: { score: 4.2 },
  recStatus: 'DISPATCHED',
  seNames: { 'se-uuid-1': 'Ramesh Kumar', 'se-uuid-2': 'Suresh Rao' },
  identity: { deviceId: 'DEV-9001', vehicleNo: 'RJ14-GA-1234', plantName: 'Kotputli Works', companyName: 'UltraTech', transporterName: 'Blue Dart' },
  trace: {
    candidatesTotal: 3,
    passedCount: 2,
    dropCounts: { COMMON_KIT_INCOMPLETE: 1 },
    chosen: {
      seId: 'se-uuid-1',
      coverageType: 'DEDICATED',
      precedenceRank: 1,
      plannerPlanned: false,
      plannerBias: false,
      capacityAtDecision: { used: 1, cap: 25 },
      clusterSeed: false,
    },
    runnersUp: [
      { seId: 'se-uuid-2', coverageType: 'FLOATING', precedenceRank: 2, verdict: 'PASSED', dropReason: null, plannerPlanned: false, score: 4.2 },
    ],
    scoreDegenerate: true,
    poolEmptyReason: null,
  },
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/tickets/') && u.includes('/trace')) return json(trace);
      return json(batch); // /batches/900
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/batches/900']}>
      <Routes>
        <Route path="/batches/:batchId" element={<DispatchBatchDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Dispatch batch detail (Issue 123)', () => {
  it('hides the numeric score while scoreDegenerate holds (selection basis = Precedence)', async () => {
    renderPage();
    const row = within(await screen.findByTestId('dispatch-assignment-row-t-uuid-1'));
    expect(row.getByText('DEV-9001')).toBeInTheDocument();
    expect(row.getByText('Precedence')).toBeInTheDocument();
    // The raw score number is not shown on the row.
    expect(row.queryByText('4.20')).toBeNull();
    // Enrichment (Issue 125): vehicle under device, company + transporter columns.
    expect(row.getByText('RJ14-GA-1234')).toBeInTheDocument();
    expect(row.getByText('UltraTech')).toBeInTheDocument();
    expect(row.getByText('Blue Dart')).toBeInTheDocument();
  });

  it('expands the row to the precedence-terms trace with SE names, not UUIDs', async () => {
    renderPage();
    const row = await screen.findByTestId('dispatch-assignment-row-t-uuid-1');
    expect(screen.queryByText(/Chosen:/)).toBeNull();

    await userEvent.click(row);

    expect(await screen.findByText(/Chosen: Ramesh Kumar/)).toBeInTheDocument();
    expect(screen.getByText(/1st of 3 eligible/)).toBeInTheDocument();
    // Identity strip (Issue 125): full context in the expanded trace. Scoped to the strip so its
    // "Transporter" label isn't confused with the assignment table's Transporter column header.
    const identity = within(screen.getByTestId('trace-identity'));
    expect(identity.getByText('Kotputli Works')).toBeInTheDocument();
    expect(identity.getByText('Transporter')).toBeInTheDocument();
    // Runner-up rendered by name (not UUID) with its verdict.
    expect(screen.getByText(/Suresh Rao/)).toBeInTheDocument();
    expect(screen.getByText('PASSED')).toBeInTheDocument();
    // The degeneracy note is surfaced.
    expect(screen.getByText(/decided by precedence/)).toBeInTheDocument();
  });

  it('searches by device id / vehicle number and filters by the transporters on this batch', async () => {
    renderPage();
    expect(await screen.findByTestId('dispatch-assignment-row-t-uuid-1')).toBeInTheDocument();
    expect(screen.getByTestId('dispatch-assignment-row-t-uuid-2')).toBeInTheDocument();

    // The dropdown lists only transporters present on the batch (Blue Dart, Gati) — nothing else.
    const dropdown = screen.getByLabelText(/filter by transporter/i);
    expect(within(dropdown).getByRole('option', { name: 'Blue Dart' })).toBeInTheDocument();
    expect(within(dropdown).getByRole('option', { name: 'Gati' })).toBeInTheDocument();

    // Search by vehicle number → only the matching row.
    await userEvent.type(screen.getByLabelText(/search by device id or vehicle number/i), '5678');
    expect(screen.queryByTestId('dispatch-assignment-row-t-uuid-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('dispatch-assignment-row-t-uuid-2')).toBeInTheDocument();

    // Clear, then filter by transporter → only Blue Dart's row.
    await userEvent.clear(screen.getByLabelText(/search by device id or vehicle number/i));
    await userEvent.selectOptions(dropdown, 'Blue Dart');
    expect(screen.getByTestId('dispatch-assignment-row-t-uuid-1')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatch-assignment-row-t-uuid-2')).not.toBeInTheDocument();
  });

  it('is addressed by batch id alone — a run-less batch renders, minus the zone breadcrumb', async () => {
    // Most live batches have no run (pre-ledger / ZM_MANUAL). The batch must still render; only the
    // run-keyed trace and the zone drill-down (a view OF a run) drop away.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        // The read is by batch id — never nested under a run.
        expect(u).toContain('/batches/900');
        expect(u).not.toContain('/dispatch-runs/');
        return json({ ...batch, runId: null, rows: batch.rows.map((r) => ({ ...r, hasTrace: false })) });
      }),
    );
    renderPage();

    expect(await screen.findByTestId('dispatch-assignment-row-t-uuid-1')).toBeInTheDocument();
    expect(screen.getByText('DEV-9001')).toBeInTheDocument();
    // No zone to go back to without a run — the runs list stands in.
    expect(screen.queryByText(/Back to zone/)).toBeNull();
    expect(screen.getByRole('link', { name: /Dispatch runs/ })).toHaveAttribute('href', '/dispatch-runs');
  });

  it('renders the trace without crashing when identity is absent (older backend / version skew)', async () => {
    const { identity: _omit, ...traceNoIdentity } = trace;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes('/tickets/') && u.includes('/trace')) return json(traceNoIdentity);
        return json(batch);
      }),
    );
    renderPage();
    const row = await screen.findByTestId('dispatch-assignment-row-t-uuid-1');
    await userEvent.click(row);
    // Precedence narrative still renders; the identity strip is simply omitted.
    expect(await screen.findByText(/Chosen: Ramesh Kumar/)).toBeInTheDocument();
    expect(screen.queryByTestId('trace-identity')).toBeNull();
  });
});
