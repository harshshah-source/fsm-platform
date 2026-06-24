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
