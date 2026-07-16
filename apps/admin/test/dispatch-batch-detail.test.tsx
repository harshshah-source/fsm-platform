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
      return json(batch); // /dispatch-runs/42/batches/900
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/dispatch-runs/42/batches/900']}>
      <Routes>
        <Route path="/dispatch-runs/:runId/batches/:batchId" element={<DispatchBatchDetailPage />} />
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
    // Identity strip (Issue 125): full context in the expanded trace.
    expect(screen.getByText('Kotputli Works')).toBeInTheDocument();
    expect(screen.getByText('Transporter')).toBeInTheDocument();
    // Runner-up rendered by name (not UUID) with its verdict.
    expect(screen.getByText(/Suresh Rao/)).toBeInTheDocument();
    expect(screen.getByText('PASSED')).toBeInTheDocument();
    // The degeneracy note is surfaced.
    expect(screen.getByText(/decided by precedence/)).toBeInTheDocument();
  });
});
