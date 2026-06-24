import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ScheduleDetailPage } from '../src/pages/schedules/ScheduleDetailPage';

/**
 * Issue 13b slice 2 — the ZM Schedule detail (`/schedules/:engineerId`). Ordered stop list (by stop
 * sequence) with plant + device count, and a per-ticket "Why suggested?" chip that expands to the
 * Recommender reasoning (Company Tier, Device Bucket, Priority Rank, Plant Cluster Multiplier).
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const detail = {
  scheduleId: '10',
  seId: 'se-north-1',
  status: 'AUTO_ASSIGNED',
  dateFrom: '2026-06-22',
  dateTo: '2026-06-22',
  stops: [
    {
      batchId: '100',
      stopSequence: 1,
      plantId: '7',
      plantName: 'Pune Depot',
      status: 'AUTO_ASSIGNED',
      deviceCount: 2,
      tickets: [
        {
          ticketId: 'tkt-1',
          sortOrder: 1,
          reasoning: {
            companyTier: 'PLATINUM',
            deviceBucket: 'CRITICAL',
            companyPriorityRank: 'A',
            clusterMultiplier: 1.25,
          },
        },
      ],
    },
    {
      batchId: '101',
      stopSequence: 2,
      plantId: '8',
      plantName: 'Mumbai Yard',
      status: 'AUTO_ASSIGNED',
      deviceCount: 1,
      tickets: [{ ticketId: 'tkt-2', sortOrder: 1, reasoning: null }],
    },
  ],
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();
function stubDetail() {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/schedules/engineers')) return json([]); // zone-SE picker source
    return json(detail); // GET detail
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={['/schedules/se-north-1']}>
        <Routes>
          <Route path="/schedules/:engineerId" element={<ScheduleDetailPage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('ZM Schedule detail (Issue 13b AC#2)', () => {
  it('renders ordered stops with plant and device count, fetching the SE detail', async () => {
    stubDetail();
    renderPage();

    const stops = await screen.findAllByTestId('schedule-stop');
    expect(stops).toHaveLength(2);
    // Order preserved by stop sequence.
    expect(stops[0]).toHaveTextContent('Pune Depot');
    expect(stops[1]).toHaveTextContent('Mumbai Yard');
    expect(stops[0]).toHaveTextContent('2');

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/schedules/se-north-1'))).toBe(true);
  });

  it('expands a "Why suggested?" chip to reveal the Recommender reasoning', async () => {
    stubDetail();
    renderPage();

    const firstStop = within((await screen.findAllByTestId('schedule-stop'))[0]);
    // Reasoning hidden until the chip is expanded.
    expect(firstStop.queryByText(/PLATINUM/)).toBeNull();

    await userEvent.click(firstStop.getByRole('button', { name: /why suggested/i }));

    expect(firstStop.getByText(/PLATINUM/)).toBeInTheDocument();
    expect(firstStop.getByText(/CRITICAL/)).toBeInTheDocument();
    expect(firstStop.getByText(/1\.25/)).toBeInTheDocument();
  });
});
