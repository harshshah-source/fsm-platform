import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ScheduleDetailPage } from '../src/pages/schedules/ScheduleDetailPage';

/**
 * #366 — the Zone Warehouse pickup stop on the ZM schedule detail.
 *
 * Reference: `docs/ui/desktop/approved-designs/warehouse-pickup-stop.html` (the operator-approved
 * direction; `12-batch-schedule-review.png` governs the surrounding chrome). What that design pins,
 * and therefore what this file asserts:
 *
 *  - the pickup is a **stop row at sequence 0**, first in the ordered list — not a banner above it,
 *    because the engineer cannot do stop 1 without the part;
 *  - it names the parts, so a dispatcher does not have to open the component requests;
 *  - it carries a kind tag, so the row survives grayscale and colour-blind rendering — colour alone
 *    never carries the meaning;
 *  - a plan with no pickup renders exactly as it does today.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const stops = [
  {
    batchId: '100',
    stopSequence: 1,
    plantId: '7',
    plantName: 'Bhilwara Cement Works',
    status: 'AUTO_ASSIGNED',
    deviceCount: 2,
    tickets: [{ ticketId: 'tkt-1', sortOrder: 1, reasoning: null }],
  },
  {
    batchId: '101',
    stopSequence: 2,
    plantId: '8',
    plantName: 'Chittorgarh Depot',
    status: 'AUTO_ASSIGNED',
    deviceCount: 1,
    tickets: [{ ticketId: 'tkt-2', sortOrder: 1, reasoning: null }],
  },
];

const detailWithoutPickup = {
  scheduleId: '10',
  seId: 'se-north-1',
  seName: 'Ramesh Kumar',
  status: 'AUTO_ASSIGNED',
  dateFrom: '2026-06-28',
  dateTo: '2026-06-28',
  pickup: null,
  stops,
};

const detailWithPickup = {
  ...detailWithoutPickup,
  pickup: {
    stopSequence: 0,
    warehouseName: 'Rajasthan North Zone Warehouse',
    parts: [
      {
        requestId: '1a2b3c4d-0000-4000-8000-000000000001',
        ticketId: 'tkt-1',
        componentId: '11',
        componentName: 'Modem board',
        trackingRef: 'TRK-114',
      },
      {
        requestId: '9f8e7d6c-0000-4000-8000-000000000002',
        ticketId: 'tkt-2',
        componentId: '12',
        componentName: 'Antenna assembly',
        trackingRef: 'TRK-119',
      },
    ],
  },
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();
function stubWith(body: unknown) {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/schedules/engineers')) return json([]); // zone-SE picker source
    return json(body);
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

describe('#366 — Zone Warehouse pickup stop on the ZM schedule detail', () => {
  it('renders the pickup as stop 0, first in the ordered list, above the first plant', async () => {
    stubWith(detailWithPickup);
    renderPage();

    const pickup = await screen.findByTestId('schedule-pickup-stop');
    expect(pickup).toHaveTextContent('Zone Warehouse');
    expect(pickup).toHaveTextContent('Rajasthan North Zone Warehouse');
    // Sequence 0 — the stop numbering stays literal and the plant stops keep 1 and 2.
    expect(within(pickup).getByTestId('pickup-stop-sequence')).toHaveTextContent('0');

    // Ordering is the whole argument for a stop row over a banner: it must precede stop 1 in the DOM.
    const plantStops = screen.getAllByTestId('schedule-stop');
    expect(pickup.compareDocumentPosition(plantStops[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(plantStops).toHaveLength(2);
    expect(plantStops[0]).toHaveTextContent('Bhilwara Cement Works');
  });

  it('names every part waiting at the warehouse, with its request reference', async () => {
    stubWith(detailWithPickup);
    renderPage();

    const pickup = await screen.findByTestId('schedule-pickup-stop');
    expect(pickup).toHaveTextContent('Modem board');
    expect(pickup).toHaveTextContent('Antenna assembly');
    // The request reference, so a dispatcher can find the request without guessing.
    expect(pickup).toHaveTextContent('REQ-1a2b3c4d');
    expect(pickup).toHaveTextContent('REQ-9f8e7d6c');
    expect(pickup).toHaveTextContent('2 parts');
  });

  it('carries the kind in text, so the row does not depend on colour to be understood', async () => {
    stubWith(detailWithPickup);
    renderPage();

    const pickup = await screen.findByTestId('schedule-pickup-stop');
    expect(within(pickup).getByTestId('pickup-kind-tag')).toHaveTextContent(/pickup/i);
  });

  it('renders nothing extra when no part is waiting — the plan is exactly today’s', async () => {
    stubWith(detailWithoutPickup);
    renderPage();

    const plantStops = await screen.findAllByTestId('schedule-stop');
    expect(plantStops).toHaveLength(2);
    expect(screen.queryByTestId('schedule-pickup-stop')).toBeNull();
  });
});
