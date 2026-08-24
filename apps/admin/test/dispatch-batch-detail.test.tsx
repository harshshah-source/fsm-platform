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
      // #266 — a candidate whose tier was never reached: it passed every hard filter but sits below
      // the winning tier, so it was never scored. Neither PASSED-with-a-number nor DROPPED.
      { seId: 'se-uuid-3', coverageType: 'MULTI_PLANT', precedenceRank: 3, verdict: 'TIER_NOT_REACHED', dropReason: null, plannerPlanned: false, score: null },
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
  it('drops the Rank / Selection basis / Recommendation columns and shows the batch SE + plant per row', async () => {
    renderPage();
    const row = within(await screen.findByTestId('dispatch-assignment-row-t-uuid-1'));
    expect(row.getByText('DEV-9001')).toBeInTheDocument();
    // The Rank / Selection basis / Recommendation columns were removed — no "Precedence" basis chip and
    // the raw candidate score never surfaces on the row.
    expect(row.queryByText('Precedence')).toBeNull();
    expect(row.queryByText('4.20')).toBeNull();
    // Enrichment (Issue 125): vehicle under device, company + transporter columns; plus the new
    // batch-level Plant + SE columns (a batch is one SE dispatched to one plant).
    expect(row.getByText('RJ14-GA-1234')).toBeInTheDocument();
    expect(row.getByText('UltraTech')).toBeInTheDocument();
    expect(row.getByText('Kotputli Works')).toBeInTheDocument();
    expect(row.getByText('Ramesh Kumar')).toBeInTheDocument();
    expect(row.getByText('Blue Dart')).toBeInTheDocument();
  });

  it('offers a table-level Download control with CSV / Excel / PDF / Image formats (Issue 160)', async () => {
    renderPage();
    await screen.findByTestId('dispatch-assignment-row-t-uuid-1');
    // The old page-level two-control ExportMenu is gone — one button per table, disambiguated by its
    // own aria-label, per issue #160 decision 3.
    const trigger = screen.getByRole('button', { name: 'Download Batch assignments' });
    expect(trigger).toBeEnabled();
    await userEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'CSV' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Excel' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'PDF' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Image (PNG)' })).toBeInTheDocument();
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
    // #266 — the score is what decides the winner now, so the drawer has to show it. A runner-up
    // carrying its OWN number is the whole point: two candidates that used to display the winner's
    // score looked like a tie the engine never saw.
    expect(screen.getByText('4.20')).toBeInTheDocument();
    // #266 — a never-reached tier reads as its own outcome, not as a near-miss. It has no score to
    // show, and rendering one would re-tell the lie the backend just stopped telling.
    expect(screen.getByText('TIER_NOT_REACHED')).toBeInTheDocument();
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

  it('shows the AutoPlant device columns — Inactive Duration, IMSI, Device Type, Trip Creation', async () => {
    renderPage();
    const row = within(await screen.findByTestId('dispatch-assignment-row-t-uuid-1'));
    expect(row.getByText('V5')).toBeInTheDocument();
    expect(row.getByText('0404920694896515')).toBeInTheDocument();
    // Derived from latestGpsDatetime by the same helper the device list uses (26h → "1d 2h").
    expect(row.getByText('1d 2h')).toBeInTheDocument();
    // Trip creation carries its year — these stamps run back to 2023 on the live source.
    expect(row.getByText(/13 Jul 2026/)).toBeInTheDocument();
  });

  it('degrades each device column to "—" when the source has no value for it', async () => {
    renderPage();
    const row = within(await screen.findByTestId('dispatch-assignment-row-t-uuid-2'));
    // Device Type, IMSI, Inactive Duration, Trip Creation — all absent on this row.
    expect(row.getAllByText('—')).toHaveLength(4);
    expect(row.getByText('DEV-9002')).toBeInTheDocument(); // the row itself still renders
  });

  it('renders the device columns when the backend omits them entirely (version skew)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          ...batch,
          rows: batch.rows.map(
            ({ deviceType: _dt, imsiNo: _i, latestGpsDatetime: _g, tripCreationDatetime: _t, ...rest }) => rest,
          ),
        }),
      ),
    );
    renderPage();
    // The table must render rather than blank out — the new columns simply read "—".
    const row = within(await screen.findByTestId('dispatch-assignment-row-t-uuid-1'));
    expect(row.getByText('DEV-9001')).toBeInTheDocument();
    expect(row.getByText('RJ14-GA-1234')).toBeInTheDocument();
  });

  /**
   * #281 AC6/AC7 (#280 R4/R10) — the drill-down used to dead-end here. The page named an engineer, a
   * plant and every ticket and linked none of them; its only two links pointed back UP the chain. To
   * reach the day plan the batch produced, the operator went to the sidebar, opened Schedules and
   * searched by name — for a route (`/schedules/:seId`) that was already live and already rendering
   * exactly that.
   */
  describe('#281 — the chain reaches the work it produced', () => {
    it('AC6: reaches the SE day plan this batch produced in one action', async () => {
      renderPage();
      const identity = within(await screen.findByTestId('batch-identity'));
      const dayPlan = identity.getByRole('link', { name: /Ramesh Kumar/ });
      expect(dayPlan).toHaveAttribute('href', '/schedules/se-uuid-1');
      // The link states the question it moves to, per #280 R8 — not a bare name.
      expect(identity.getByTestId('batch-se-link').textContent).toMatch(/day plan/i);
    });

    it('AC7: links the plant to its device investigation', async () => {
      renderPage();
      const identity = within(await screen.findByTestId('batch-identity'));
      expect(identity.getByRole('link', { name: /Kotputli Works/ })).toHaveAttribute(
        'href',
        '/reports/device?plantId=10',
      );
    });

    it('AC7: links every ticket row to its ticket', async () => {
      renderPage();
      const row = within(await screen.findByTestId('dispatch-assignment-row-t-uuid-1'));
      expect(row.getByRole('link', { name: /DEV-9001/ })).toHaveAttribute('href', '/tickets/t-uuid-1');

      const sparse = within(screen.getByTestId('dispatch-assignment-row-t-uuid-2'));
      expect(sparse.getByRole('link', { name: /DEV-9002/ })).toHaveAttribute('href', '/tickets/t-uuid-2');
    });

    it('AC3: the batch never claims to be editable — it links out, it does not act', async () => {
      renderPage();
      const identity = within(await screen.findByTestId('batch-identity'));
      // Dispatch Runs is the immutable ledger (#280 R3/#281 AC5). Every affordance on it is a link
      // to somewhere else; a button here would be a write surface on history.
      expect(identity.queryAllByRole('button')).toHaveLength(0);
      expect(identity.getByTestId('batch-identity-note').textContent).toMatch(/what this run did/i);
    });

    it('keeps the day-plan link when the batch names no engineer, without showing a raw uuid', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => json({ ...batch, seName: null })));
      renderPage();
      const identity = within(await screen.findByTestId('batch-identity'));
      // The destination is keyed by seId, so a missing NAME is no reason to drop the link — but the
      // uuid is never the label (#281 AC10's rule, applied here too).
      const link = identity.getByTestId('batch-se-link');
      expect(link.querySelector('a')).toHaveAttribute('href', '/schedules/se-uuid-1');
      expect(link.textContent).not.toContain('se-uuid-1');
      expect(await screen.findByTestId('dispatch-assignment-row-t-uuid-1')).toBeInTheDocument();
    });
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
