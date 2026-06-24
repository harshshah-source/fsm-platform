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
    zoneId: '1',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-22',
    status: 'AUTO_ASSIGNED',
    batchCount: 2,
    ticketCount: 7,
  },
  {
    scheduleId: '11',
    seId: 'se-north-2',
    zoneId: '1',
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

    expect(bodyRows[0]).toHaveTextContent('se-north-1');
    expect(within(bodyRows[0]).getByTestId('schedule-status-AUTO_ASSIGNED')).toBeInTheDocument();
    expect(within(bodyRows[1]).getByTestId('schedule-status-OVERRIDDEN')).toBeInTheDocument();

    // Reads the monitoring endpoint.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/schedules'))).toBe(true);
  });

  it('shows no Approve action and no approval countdown (no gate)', async () => {
    stubList();
    renderPage();
    await screen.findByRole('table', { name: /schedules/i });

    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByTestId('approval-countdown')).toBeNull();
  });
});
