import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { SeManagementPage } from '../src/pages/engineers/SeManagementPage';

/**
 * Issue 122 — SE Activity drill-down. Selecting an SE reveals the full "Scheduled Work" context: the
 * Work Schedule header plus each plant stop with its live tickets (device · vehicle · company · SLA).
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const list = [
  { seId: 'se-1', name: 'Karan Singh', zoneId: '1', coverageType: 'DEDICATED', activityStatus: 'BUSY', availabilityStatus: 'AVAILABLE', activeTicketCount: 2, kitComplete: true, missingKit: [], dailyCapacity: 10, isActive: true },
];

const detail = {
  seId: 'se-1',
  name: 'Karan Singh',
  zoneId: '1',
  zoneName: 'North',
  coverageType: 'DEDICATED',
  dailyCapacity: 10,
  isActive: true,
  activityStatus: 'BUSY',
  availabilityStatus: 'AVAILABLE',
  dayPlan: { status: 'ACTIVE', ticketCount: 2 },
  schedule: { scheduleId: '42', status: 'ACTIVE', dateFrom: '2026-07-14', dateTo: '2026-07-14' },
  stops: [
    {
      batchId: '7',
      stopSequence: 1,
      status: 'AUTO_ASSIGNED',
      plantId: '5',
      plantName: 'SATNA PLANT',
      tickets: [
        { ticketId: 't1', deviceId: '900', vehicleNo: 'MP-09-XX', workType: 'TROUBLESHOOT', status: 'OPEN', slaBucket: 'CRITICAL', companyName: 'Prism Cement' },
      ],
    },
  ],
  vanStock: [],
  kit: { complete: true, missing: [] },
  availabilityRows: [],
};

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function renderPage() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={['/engineers']}>
        <Routes>
          <Route path="/engineers" element={<SeManagementPage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (/\/engineers\/se-1$/.test(u)) return json(detail);
    if (/\/engineers$/.test(u)) return json(list);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('SE Activity drill-down (Issue 122)', () => {
  it('shows the schedule + plant stops with full ticket context on select', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /se management/i });
    await user.click(within(screen.getByTestId('se-row-se-1')).getByRole('button', { name: /karan singh/i }));

    const panel = within(await screen.findByRole('region', { name: /se detail/i }));
    const work = within(await panel.findByTestId('se-scheduled-work'));
    expect(work.getByText(/Schedule #42/)).toBeInTheDocument();
    expect(work.getByText(/SATNA PLANT/)).toBeInTheDocument();
    expect(work.getByText(/900/)).toBeInTheDocument();
    expect(work.getByText(/MP-09-XX/)).toBeInTheDocument();
    expect(work.getByText(/Prism Cement/)).toBeInTheDocument();
  });
});
