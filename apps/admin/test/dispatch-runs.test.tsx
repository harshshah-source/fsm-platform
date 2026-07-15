import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchRunsPage } from '../src/pages/dispatch/DispatchRunsPage';
import { buildNav } from '../src/components/shell/nav';

/**
 * Issue 123 — Batch-Assignment transparency, runs list. Asserts the run rows render from the
 * `/dispatch-runs` endpoint (trigger + actor, status, totals) and that the "Dispatch Runs" nav entry
 * is manager-scoped (present for ZM/CSM/OH, absent for Warehouse / Service Engineer).
 */
const runs = [
  {
    runId: '42',
    trigger: 'MANUAL',
    actorRole: 'OPERATIONS_HEAD',
    actorName: 'Priya Nair',
    startedAt: '2026-07-15T05:00:00Z',
    finishedAt: '2026-07-15T05:00:03Z',
    durationMs: 3200,
    status: 'SUCCESS',
    zones: 2,
    schedules: 5,
    batches: 4,
    ticketsDispatched: 7,
    recommended: 8,
    unassignable: 1,
    errorCount: 0,
  },
  {
    runId: '41',
    trigger: 'CRON',
    actorRole: null,
    actorName: null,
    startedAt: '2026-07-14T05:00:00Z',
    finishedAt: '2026-07-14T05:00:05Z',
    durationMs: 5000,
    status: 'PARTIAL',
    zones: 90,
    schedules: 24,
    batches: 30,
    ticketsDispatched: 560,
    recommended: 600,
    unassignable: 40,
    errorCount: 2,
  },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
  if (String(url).includes('/dispatch-runs')) return json(runs);
  return json({});
});

beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockClear();
  sessionStorage.clear();
});

describe('Dispatch Runs — runs list (Issue 123)', () => {
  it('renders each run with its trigger/actor, status and totals', async () => {
    render(
      <MemoryRouter>
        <DispatchRunsPage />
      </MemoryRouter>,
    );

    const manual = within(await screen.findByTestId('dispatch-run-42'));
    expect(manual.getByText('Manual')).toBeInTheDocument();
    expect(manual.getByText('Manual — Priya Nair')).toBeInTheDocument();
    expect(manual.getByText('SUCCESS')).toBeInTheDocument();

    const cron = within(await screen.findByTestId('dispatch-run-41'));
    expect(cron.getByText('Auto')).toBeInTheDocument();
    expect(cron.getByText('Automatic')).toBeInTheDocument();
    expect(cron.getByText('PARTIAL')).toBeInTheDocument();
    expect(cron.getByText('40')).toBeInTheDocument(); // unassignable
    expect(cron.getByText('2')).toBeInTheDocument(); // errors
  });

  it('exposes the manager-scoped Dispatch Runs nav entry', () => {
    for (const role of ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']) {
      const links = buildNav(role).flatMap((g) => g.items);
      expect(links.some((l) => l.to === '/dispatch-runs')).toBe(true);
    }
    for (const role of ['WAREHOUSE_MANAGER', 'SERVICE_ENGINEER']) {
      const links = buildNav(role).flatMap((g) => g.items);
      expect(links.some((l) => l.to === '/dispatch-runs')).toBe(false);
    }
  });
});
