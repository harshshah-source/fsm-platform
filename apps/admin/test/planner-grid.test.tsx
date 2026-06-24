import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { PlannerPage } from '../src/pages/planner/PlannerPage';

/**
 * Issue 14b slice 1 — the SE Planner grid (`/engineers/planner`). Rows = SEs (zone-scoped engineer
 * list), columns = days across a multi-day window (flexible Schedule Cadence — CONTEXT §Schedule
 * Cadence). Each cell holds the plant-visit intents for that (SE, day), read from GET /api/planner.
 * The plant picker is sourced from GET /api/planner/plants. Zone scope is enforced server-side.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const engineers = [
  { engineerId: 'se-north-1', coverageType: 'MULTI_PLANT', zoneId: '1', dailyCapacity: 10, isActive: true },
  { engineerId: 'se-north-2', coverageType: 'DEDICATED', zoneId: '1', dailyCapacity: 8, isActive: true },
];

const plants = [
  { plantId: '7', name: 'Yard-1', zoneId: '1' },
  { plantId: '8', name: 'Depot-2', zoneId: '1' },
];

const entries = [{ id: '100', seId: 'se-north-1', plantId: '7', plannedDate: '2026-06-22' }];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();
function stubReads() {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/schedules/engineers')) return json(engineers);
    if (u.includes('/schedules')) return json([]);
    if (u.includes('/planner/plants')) return json(plants);
    if (u.includes('/planner')) return json(entries);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter>
        <PlannerPage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  // Pin "today" so the multi-day column window is deterministic. `shouldAdvanceTime` keeps the real
  // clock progressing so Testing-Library's async polling (findBy/waitFor) still resolves.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-06-22T08:00:00'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('SE Planner grid (Issue 14b slice 1)', () => {
  it('renders SE rows and a multi-day column window', async () => {
    stubReads();
    renderPage();

    const grid = within(await screen.findByRole('table', { name: /planner/i }));
    // One row per zone engineer (plus the header row).
    expect(grid.getByText('se-north-1')).toBeInTheDocument();
    expect(grid.getByText('se-north-2')).toBeInTheDocument();
    // The window starts at "today" and spans multiple days.
    expect(grid.getByText('2026-06-22')).toBeInTheDocument();
    expect(grid.getByText('2026-06-28')).toBeInTheDocument();
  });

  it('shows a persisted plant-visit intent in the matching SE×day cell', async () => {
    stubReads();
    renderPage();

    await screen.findByRole('table', { name: /planner/i });
    const cell = within(screen.getByTestId('cell-se-north-1-2026-06-22'));
    expect(cell.getByText('Yard-1')).toBeInTheDocument();

    // Other cells stay empty (the intent is not duplicated across the grid).
    const otherCell = within(screen.getByTestId('cell-se-north-2-2026-06-22'));
    expect(otherCell.queryByText('Yard-1')).toBeNull();

    // Reads the zone-scoped planner range endpoint.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/planner?dateFrom='))).toBe(true);
  });
});

/**
 * Slices 2 & 3 — the grid writes through to the API and reflects persisted state. Assigning picks a
 * plant then drops/clicks it onto a cell (POST /api/planner); removing clicks the chip's × (DELETE
 * /api/planner/:id). After each write the grid refetches, so what shows is what the server has.
 */
function stubWrites() {
  let state: typeof entries = [];
  let nextId = 200;
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const method = (opts?.method ?? 'GET').toUpperCase();
    if (u.includes('/schedules/engineers')) return json(engineers);
    if (u.includes('/schedules')) return json([]);
    if (u.includes('/planner/plants')) return json(plants);
    if (u.match(/\/planner\/\d+$/) && method === 'DELETE') {
      const id = u.split('/').pop()!;
      state = state.filter((e) => e.id !== id);
      return json({ deleted: true });
    }
    if (u.endsWith('/planner') && method === 'POST') {
      const body = JSON.parse(String(opts?.body)) as { seId: string; plantId: string; plannedDate: string };
      const entry = { id: String(nextId++), ...body };
      state = [...state, entry];
      return json(entry);
    }
    if (u.includes('/planner')) return json(state); // GET range
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('SE Planner grid writes (Issue 14b slices 2–3)', () => {
  it('assigns a picked plant into a cell via POST /api/planner and shows it', async () => {
    stubWrites();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    renderPage();
    await screen.findByRole('table', { name: /planner/i });

    await user.selectOptions(screen.getByLabelText(/plant to assign/i), '8');
    await user.click(screen.getByRole('button', { name: /add plant to se-north-2 on 2026-06-23/i }));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([u, o]) => String(u).endsWith('/planner') && (o as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.some(([, o]) => String((o as RequestInit).body).includes('"plantId":"8"'))).toBe(true);
      expect(posts.some(([, o]) => String((o as RequestInit).body).includes('"seId":"se-north-2"'))).toBe(true);
      expect(posts.some(([, o]) => String((o as RequestInit).body).includes('"plannedDate":"2026-06-23"'))).toBe(true);
    });

    const cell = within(await screen.findByTestId('cell-se-north-2-2026-06-23'));
    expect(await cell.findByText('Depot-2')).toBeInTheDocument();
  });

  it('removes a plant intent via DELETE /api/planner/:id', async () => {
    stubWrites();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    renderPage();
    await screen.findByRole('table', { name: /planner/i });

    // Create one, then delete it.
    await user.selectOptions(screen.getByLabelText(/plant to assign/i), '7');
    await user.click(screen.getByRole('button', { name: /add plant to se-north-1 on 2026-06-22/i }));
    const cell = within(await screen.findByTestId('cell-se-north-1-2026-06-22'));
    await cell.findByText('Yard-1');

    await user.click(cell.getByRole('button', { name: /remove yard-1/i }));

    await waitFor(() => {
      const dels = fetchMock.mock.calls.filter(
        ([u, o]) => /\/planner\/\d+$/.test(String(u)) && (o as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(dels.length).toBeGreaterThan(0);
    });
    await waitFor(() => expect(cell.queryByText('Yard-1')).toBeNull());
  });
});

/**
 * Slice 4 (AC#3) — the planner intent rows surface alongside each SE's Batch Schedule so plant-intent
 * and Recommender output stay coherent (CONTEXT §SE Planner; the entry is overridable at the Batch
 * Schedule level, Issue 13b). Each SE row shows its current schedule status + ticket count, or "No batch".
 */
describe('SE Planner grid — Batch Schedule surfaced (Issue 14b AC#3)', () => {
  it('annotates each SE row with its Batch Schedule status, or "No batch"', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/schedules/engineers')) return json(engineers);
      if (u.includes('/schedules'))
        return json([
          {
            scheduleId: '10',
            seId: 'se-north-1',
            zoneId: '1',
            dateFrom: '2026-06-22',
            dateTo: '2026-06-22',
            status: 'OVERRIDDEN',
            batchCount: 1,
            ticketCount: 4,
          },
        ]);
      if (u.includes('/planner/plants')) return json(plants);
      if (u.includes('/planner')) return json([]);
      return json([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByRole('table', { name: /planner/i });

    const withBatch = within(await screen.findByTestId('batch-se-north-1'));
    expect(withBatch.getByTestId('batch-status-se-north-1')).toHaveTextContent('OVERRIDDEN');
    expect(withBatch.getByTestId('batch-status-se-north-1')).toHaveTextContent('4 tickets');

    // The SE with no schedule shows the empty marker, not a stale badge.
    const noBatch = within(screen.getByTestId('batch-se-north-2'));
    expect(noBatch.queryByTestId('batch-status-se-north-2')).toBeNull();
    expect(noBatch.getByText(/no batch/i)).toBeInTheDocument();
  });
});
