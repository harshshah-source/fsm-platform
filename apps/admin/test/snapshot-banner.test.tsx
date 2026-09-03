import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/AppRoutes';
import { AuthProvider } from '../src/auth/AuthProvider';

/**
 * Issue 04 slice 8 — the Snapshot freshness banner (AC#5/#6). It rides the top of every admin
 * page, shows the data-as-of timestamp from the last SUCCESS run, and turns into a red alert when
 * the latest run FAILED or is stuck RUNNING past the expected window.
 */

type LatestPayload = {
  dataAsOf: string | null;
  lastSuccessAt: string | null;
  latest: {
    runId: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    dataAsOf: string | null;
  } | null;
  // #300 — additive on the wire; the older payloads below deliberately omit them, which is also the
  // upgrade-order case (a new FE against a not-yet-deployed BE must not crash the global banner).
  partialDataAsOf?: string | null;
  ingestion?: {
    streak: number;
    threshold: number;
    alert: boolean;
    latestStatus: string | null;
    downstreamGated: boolean;
    gatedStages: string[];
    failingChunk: { runId: string; chunkNo: number; retryCount: number; error: string | null } | null;
    repeatingFailure: boolean;
    rejected: Record<string, number>;
    repaired: Record<string, number>;
  };
};

function stubLatest(payload: LatestPayload) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/snapshots/latest')) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

function renderAt(path: string, session: SessionView) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Snapshot freshness banner (Issue 04 AC#5/#6)', () => {
  it('shows the data-as-of timestamp from the last successful snapshot', async () => {
    const asOf = '2026-06-19T08:00:00.000Z';
    stubLatest({
      dataAsOf: asOf,
      lastSuccessAt: '2026-06-19T08:05:00.000Z',
      latest: {
        runId: '7',
        status: 'SUCCESS',
        startedAt: '2026-06-19T08:00:00.000Z',
        finishedAt: '2026-06-19T08:05:00.000Z',
        dataAsOf: asOf,
      },
    });

    renderAt('/', zm);

    const banner = await screen.findByRole('status', { name: /snapshot/i });
    expect(banner).toHaveTextContent(/data as of/i);
    expect(within(banner).getByText((_, el) => el?.tagName === 'TIME')).toHaveAttribute(
      'datetime',
      asOf,
    );
    // A healthy snapshot is not an alert.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders a red alert when the latest snapshot FAILED', async () => {
    stubLatest({
      dataAsOf: '2026-06-19T08:00:00.000Z',
      lastSuccessAt: '2026-06-19T08:05:00.000Z',
      latest: {
        runId: '8',
        status: 'FAILED',
        startedAt: '2026-06-19T12:00:00.000Z',
        finishedAt: '2026-06-19T12:01:00.000Z',
        dataAsOf: null,
      },
    });

    renderAt('/', zm);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/snapshot/i);
    expect(alert).toHaveTextContent(/fail/i);
  });

  it('renders a red alert when a RUNNING snapshot is stuck past the expected window', async () => {
    const longAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    stubLatest({
      dataAsOf: '2026-06-19T08:00:00.000Z',
      lastSuccessAt: '2026-06-19T08:05:00.000Z',
      latest: {
        runId: '9',
        status: 'RUNNING',
        startedAt: longAgo,
        finishedAt: null,
        dataAsOf: null,
      },
    });

    renderAt('/', zm);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/snapshot/i);
    expect(alert).toHaveTextContent(/stuck|overdue/i);
  });

  it('rides the top of the Settings page too (every admin page)', async () => {
    stubLatest({
      dataAsOf: '2026-06-19T08:00:00.000Z',
      lastSuccessAt: '2026-06-19T08:05:00.000Z',
      latest: {
        runId: '7',
        status: 'SUCCESS',
        startedAt: '2026-06-19T08:00:00.000Z',
        finishedAt: '2026-06-19T08:05:00.000Z',
        dataAsOf: '2026-06-19T08:00:00.000Z',
      },
    });

    renderAt('/settings', {
      user_id: 'oh1',
      role: 'OPERATIONS_HEAD',
      zone_id: null,
      acted_as_role: null,
    });

    expect(await screen.findByRole('status', { name: /snapshot/i })).toBeInTheDocument();
  });
});

/**
 * #300 — the banner must never render a gated pipeline as healthy freshness (AC2).
 *
 * Before this, a PARTIAL run produced the ordinary grey "data as of …" line. That is the reading an
 * operator must not get: PARTIAL means the #230 gate skipped device-state derivation, auto-recovery
 * and ticket creation, so the timestamp on screen describes a fleet nothing has re-derived since.
 * The banner said "fresh"; the pipeline was frozen.
 */
const gatedIngestion = (over: Partial<LatestPayload['ingestion']> = {}) => ({
  streak: 1,
  threshold: 3,
  alert: false,
  latestStatus: 'PARTIAL',
  downstreamGated: true,
  gatedStages: ['device-state derivation', 'auto-recovery', 'ticket creation'],
  failingChunk: null,
  repeatingFailure: false,
  rejected: {},
  repaired: {},
  ...over,
});

describe('#300 — the banner states a gated pipeline', () => {
  it('warns, names the paused stages, and does not read as plain freshness', async () => {
    stubLatest({
      dataAsOf: '2026-09-01T10:00:00.000Z',
      lastSuccessAt: '2026-09-01T10:05:00.000Z',
      latest: {
        runId: '20',
        status: 'PARTIAL',
        startedAt: '2026-09-01T11:00:00.000Z',
        finishedAt: '2026-09-01T11:04:00.000Z',
        dataAsOf: '2026-09-01T11:30:00.000Z',
      },
      partialDataAsOf: '2026-09-01T11:30:00.000Z',
      ingestion: gatedIngestion(),
    });

    renderAt('/', zm);

    const alert = await screen.findByTestId('snapshot-banner-gated');
    expect(alert).toHaveTextContent(/did not complete/i);
    expect(alert).toHaveTextContent(/auto-recovery/i);
    expect(alert).toHaveTextContent(/ticket creation/i);
    expect(alert).toHaveTextContent(/may be stale/i);
    // The healthy grey line must be gone — not merely accompanied by a warning.
    expect(screen.queryByRole('status', { name: /snapshot/i })).not.toBeInTheDocument();
  });

  it('F10 — reports the PARTIAL watermark under its own name, never as data-as-of', async () => {
    stubLatest({
      dataAsOf: '2026-09-01T10:00:00.000Z',
      lastSuccessAt: '2026-09-01T10:05:00.000Z',
      latest: {
        runId: '21',
        status: 'PARTIAL',
        startedAt: '2026-09-01T11:00:00.000Z',
        finishedAt: '2026-09-01T11:04:00.000Z',
        dataAsOf: '2026-09-01T11:30:00.000Z',
      },
      partialDataAsOf: '2026-09-01T11:30:00.000Z',
      ingestion: gatedIngestion(),
    });

    renderAt('/', zm);

    const partial = await screen.findByTestId('snapshot-partial-asof');
    expect(partial).toHaveTextContent(/partial data through/i);
    expect(within(partial).getByText((_, el) => el?.tagName === 'TIME')).toHaveAttribute(
      'datetime',
      '2026-09-01T11:30:00.000Z',
    );
    // "Data as of" still names the SUCCESS watermark — a partial read may not advance it.
    const alert = screen.getByTestId('snapshot-banner-gated');
    expect(within(alert).getAllByText((_, el) => el?.tagName === 'TIME')[0]).toHaveAttribute(
      'datetime',
      '2026-09-01T10:00:00.000Z',
    );
  });

  it('escalates a wedged streak to the same alert tone as a failed run', async () => {
    stubLatest({
      dataAsOf: '2026-09-01T10:00:00.000Z',
      lastSuccessAt: '2026-09-01T10:05:00.000Z',
      latest: {
        runId: '22',
        status: 'PARTIAL',
        startedAt: '2026-09-01T13:00:00.000Z',
        finishedAt: '2026-09-01T13:04:00.000Z',
        dataAsOf: null,
      },
      partialDataAsOf: null,
      ingestion: gatedIngestion({ streak: 4, alert: true }),
    });

    renderAt('/', zm);

    const alert = await screen.findByTestId('snapshot-banner-gated');
    expect(alert).toHaveTextContent(/last 4 telemetry runs did not complete/i);
    expect(alert.className).toMatch(/red/);
  });

  it('stays the quiet grey line once a run succeeds again', async () => {
    stubLatest({
      dataAsOf: '2026-09-01T12:00:00.000Z',
      lastSuccessAt: '2026-09-01T12:05:00.000Z',
      latest: {
        runId: '23',
        status: 'SUCCESS',
        startedAt: '2026-09-01T12:00:00.000Z',
        finishedAt: '2026-09-01T12:05:00.000Z',
        dataAsOf: '2026-09-01T12:00:00.000Z',
      },
      partialDataAsOf: null,
      ingestion: gatedIngestion({ streak: 0, latestStatus: 'SUCCESS', downstreamGated: false, gatedStages: [] }),
    });

    renderAt('/', zm);

    expect(await screen.findByRole('status', { name: /snapshot/i })).toHaveTextContent(/data as of/i);
    expect(screen.queryByTestId('snapshot-banner-gated')).not.toBeInTheDocument();
  });
});
