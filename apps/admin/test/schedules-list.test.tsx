import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { SchedulesPage } from '../src/pages/schedules/SchedulesPage';

/**
 * Issue 13b slice 1 — the ZM Batch-Schedule list (`/schedules`). Per-SE rows with batch/ticket counts
 * and an AUTO_ASSIGNED / OVERRIDDEN status badge. Monitoring only: there is no Approve action and no
 * approval countdown (the approval gate was removed — CONTEXT.md Decisions §7, ADR-0019 superseded).
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const rows = [
  {
    scheduleId: '10',
    seId: 'se-north-1',
    seName: 'Karan Singh',
    zoneId: '1',
    zoneName: 'North',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-22',
    status: 'AUTO_ASSIGNED',
    batchCount: 2,
    ticketCount: 7,
  },
  {
    scheduleId: '11',
    seId: 'se-north-2',
    seName: 'Rajesh Kumar',
    zoneId: '1',
    zoneName: 'North',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-22',
    status: 'OVERRIDDEN',
    batchCount: 1,
    ticketCount: 3,
  },
];

const fetchMock = vi.fn();
function stubList() {
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter>
        <SchedulesPage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('ZM Schedule list (Issue 13b AC#1)', () => {
  it('renders a per-SE row with counts and an AUTO_ASSIGNED / OVERRIDDEN status badge', async () => {
    stubList();
    renderPage();

    const table = within(await screen.findByRole('table', { name: /schedules/i }));
    const bodyRows = table.getAllByRole('row').slice(1); // drop header
    expect(bodyRows).toHaveLength(2);

    // Issue 122b — the operator-facing SE NAME leads the row (the uuid renders as a small hint).
    expect(bodyRows[0]).toHaveTextContent('Karan Singh');
    expect(bodyRows[0]).toHaveTextContent('North');
    expect(within(bodyRows[0]).getByTestId('schedule-status-AUTO_ASSIGNED')).toBeInTheDocument();
    expect(within(bodyRows[1]).getByTestId('schedule-status-OVERRIDDEN')).toBeInTheDocument();

    // Reads the monitoring endpoint.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/schedules'))).toBe(true);
  });

  /**
   * #284 §D — the page's own copy says "What today's run actually committed", and until the endpoint
   * gained `?date=` the query had no date predicate at all: a never-closed plan from last week came
   * back beside today's. The page now asks for the operating day by default and says which scope it
   * is showing, so the sentence above the table is true of the table below it.
   */
  it('#284 — scopes to the operating day by default, and says so', async () => {
    stubList();
    renderPage();
    await screen.findByRole('table', { name: /schedules/i });

    const dated = fetchMock.mock.calls.map(([url]) => String(url)).filter((u) => u.includes('/schedules?'));
    expect(dated.some((u) => /date=\d{4}-\d{2}-\d{2}/.test(u))).toBe(true);
    expect(screen.getByTestId('schedule-scope-today')).toHaveAttribute('aria-pressed', 'true');
  });

  /**
   * The escape hatch, and why it exists: a plan that was never closed is a real fault, and a page that
   * silently hid it would replace a wrong list with a missing one.
   */
  it('#284 — "All live plans" drops the date and shows everything again', async () => {
    stubList();
    const { default: userEvent } = await import('@testing-library/user-event');
    renderPage();
    await screen.findByRole('table', { name: /schedules/i });
    fetchMock.mockClear();

    await userEvent.click(screen.getByTestId('schedule-scope-all'));

    const urls = fetchMock.mock.calls.map(([url]) => String(url)).filter((u) => u.includes('/schedules'));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((u) => u.includes('date='))).toBe(false);
  });

  it('shows no Approve action and no approval countdown (no gate)', async () => {
    stubList();
    renderPage();
    await screen.findByRole('table', { name: /schedules/i });

    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByTestId('approval-countdown')).toBeNull();
  });
});
