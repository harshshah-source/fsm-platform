import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchRunDetailPage } from '../src/pages/dispatch/DispatchRunDetailPage';

/**
 * Issue 123 — run detail: the config-in-effect panel (frozen snapshot, plain language) + per-zone
 * cards with reason buckets. Also pins the code-default fallback ("Default weighting (not overridden)")
 * for the #124 gap so the panel never invents numbers.
 */
const detail = {
  runId: '42',
  trigger: 'MANUAL',
  actorRole: 'OPERATIONS_HEAD',
  actorName: 'Priya Nair',
  actorUserId: 'u1',
  startedAt: '2026-07-15T05:00:00Z',
  finishedAt: '2026-07-15T05:00:03Z',
  durationMs: 3200,
  status: 'SUCCESS',
  schedules: 5,
  batches: 4,
  ticketsDispatched: 7,
  recommended: 8,
  unassignable: 1,
  errorCount: 0,
  configSnapshot: {
    priorityRules: [
      { weightSetRef: 'v1', component: 'companyPriorityRank', weight: 5 },
      { weightSetRef: 'v1', component: 'dispatchUrgency', weight: 3 },
    ],
    settings: { plant_cluster_multiplier: '1.25', eligibility_mode: 'all-deployed' },
    capacity: { a: { dailyCapacity: 25, isActive: true }, b: { dailyCapacity: 10, isActive: true } },
    scheduler: { businessSweepsEnabled: false, dispatchCron: '0 5 * * *' },
  },
  zones: [
    {
      zoneId: '1',
      zoneName: 'North',
      mode: 'DEFICIT',
      weightSetRef: 'v1',
      ticketsConsidered: 3,
      recommended: 2,
      unassignable: 1,
      unassignableReasons: { NO_COVERAGE: 1, ALL_DROPPED: 0, dropBuckets: {} },
      schedules: 2,
      batches: 2,
      ticketsDispatched: 2,
      error: null,
      outcome: 'DONE',
      contendedWithRunId: null,
    },
  ],
  build: null,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function renderWith(body: unknown) {
  const fetchMock = vi.fn(async () => json(body));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <MemoryRouter initialEntries={['/dispatch-runs/42']}>
      <Routes>
        <Route path="/dispatch-runs/:runId" element={<DispatchRunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
beforeEach(() => sessionStorage.clear());

describe('Dispatch run detail (Issue 123)', () => {
  it('renders the config-in-effect panel in plain language and a zone card', async () => {
    renderWith(detail);

    const config = within(await screen.findByTestId('config-in-effect'));
    expect(config.getByText('Customer priority')).toBeInTheDocument();
    expect(config.getByText('SLA urgency')).toBeInTheDocument();
    expect(config.getByText(/2 active of 2 engineers/)).toBeInTheDocument();
    expect(config.getByText(/daily at 5:00 AM/)).toBeInTheDocument();
    expect(config.getByText('all-deployed')).toBeInTheDocument();

    const zone = within(await screen.findByTestId('dispatch-zone-card-1'));
    expect(zone.getByText('North')).toBeInTheDocument();
    expect(zone.getByText('DEFICIT')).toBeInTheDocument();
    expect(zone.getByText(/No coverage:/)).toBeInTheDocument();
  });

  it('shows the code-default fallback when no DB weights were captured (#124 gap)', async () => {
    renderWith({ ...detail, configSnapshot: { ...detail.configSnapshot, priorityRules: [], settings: {} } });
    const config = within(await screen.findByTestId('config-in-effect'));
    expect(config.getByText('Default weighting (not overridden)')).toBeInTheDocument();
    expect(config.getByText(/Default ×1.25 \(not overridden\)/)).toBeInTheDocument();
  });

  it('#131 — renders the stale-build badge when the run predates the current lock version', async () => {
    renderWith({
      ...detail,
      build: {
        buildVersion: '100',
        buildFingerprint: 'stalesha',
        staleBuild: true,
        currentVersion: '200',
        currentFingerprint: 'currentsha',
      },
    });

    const badge = await screen.findByTestId('stale-build-badge');
    expect(badge).toHaveTextContent(/ran under build v100/i);
    expect(badge).toHaveTextContent(/current v200/i);
  });

  it('#131 — no badge when the run is on the current build', async () => {
    renderWith({
      ...detail,
      build: {
        buildVersion: '200',
        buildFingerprint: 'currentsha',
        staleBuild: false,
        currentVersion: '200',
        currentFingerprint: 'currentsha',
      },
    });
    await screen.findByTestId('config-in-effect');
    expect(screen.queryByTestId('stale-build-badge')).not.toBeInTheDocument();
  });

  it('#131 — no badge for a historical run with no build stamp (version skew)', async () => {
    renderWith({ ...detail, build: null });
    await screen.findByTestId('config-in-effect');
    expect(screen.queryByTestId('stale-build-badge')).not.toBeInTheDocument();
  });

  // #179 follow-up — the ledger is immutable history; read alone it implies the dispatched work is
  // still on engineers' plans. When some has since been pulled back, the card must say so.
  it('#179 — flags how much of a zone dispatched work has since been unassigned', async () => {
    renderWith({
      ...detail,
      zones: [{ ...detail.zones[0], ticketsDispatched: 77, ticketsStillAssigned: 0, ticketsRemovedSince: 77 }],
    });

    const zone = within(await screen.findByTestId('dispatch-zone-card-1'));
    // The ledger figure is untouched — scoped to the "Dispatched" stat, since the note repeats 77.
    expect(zone.getByText('Dispatched').previousSibling).toHaveTextContent('77');
    const note = zone.getByTestId('zone-removed-since');
    expect(note).toHaveTextContent(/77/);
    expect(note).toHaveTextContent(/no longer assigned|since unassigned|removed/i);
  });

  it('#179 — no removed-since note when every dispatched ticket is still assigned', async () => {
    renderWith({
      ...detail,
      zones: [{ ...detail.zones[0], ticketsDispatched: 2, ticketsStillAssigned: 2, ticketsRemovedSince: 0 }],
    });

    await screen.findByTestId('dispatch-zone-card-1');
    expect(screen.queryByTestId('zone-removed-since')).not.toBeInTheDocument();
  });

  /**
   * #259 — a zone this run asked for and did not get. Its counters are all zero, which without a label
   * reads exactly like a zone that had no work to do; the card has to say the run never held the zone,
   * and name the run that did so the operator can go and read it.
   */
  it('#259 — labels a contended zone and names the run that held it', async () => {
    renderWith({
      ...detail,
      status: 'PARTIAL',
      zones: [
        ...detail.zones,
        {
          zoneId: '2',
          zoneName: 'West',
          mode: null,
          weightSetRef: null,
          ticketsConsidered: 0,
          recommended: 0,
          unassignable: 0,
          unassignableReasons: null,
          schedules: 0,
          batches: 0,
          ticketsDispatched: 0,
          error: null,
          outcome: 'CONTENDED',
          contendedWithRunId: '41',
        },
      ],
    });

    // The header counts zones the run WORKED, matching the runs-list column for the same run; the
    // contended zone still gets a card, so 2 cards under a "Zones 1" tile is the intended reading.
    expect(await screen.findByTestId('metric-zones')).toHaveTextContent('1');

    const zone = within(await screen.findByTestId('dispatch-zone-card-2'));
    expect(zone.getByText('CONTENDED')).toBeInTheDocument();
    expect(zone.getByTestId('zone-contended-note')).toHaveTextContent(/already running under run 41/i);
    // The zero counters are not shown: a "0 dispatched" tile beside the label would invite the reading
    // that this run looked and found nothing.
    expect(zone.queryByText('Dispatched')).not.toBeInTheDocument();
  });

  /** A dispatched zone keeps its counters and gains no label — the ordinary case must not change. */
  it('#259 — a DONE zone is unchanged: counters, no outcome badge', async () => {
    renderWith(detail);
    const zone = within(await screen.findByTestId('dispatch-zone-card-1'));
    expect(zone.getByText('Dispatched')).toBeInTheDocument();
    expect(zone.queryByText('CONTENDED')).not.toBeInTheDocument();
    expect(zone.queryByTestId('zone-contended-note')).not.toBeInTheDocument();
  });
});
