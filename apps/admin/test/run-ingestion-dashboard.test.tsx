import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ToastProvider } from '../src/components/data/Toast';
import { DashboardHome } from '../src/pages/dashboard/DashboardHome';
import { emitIngestionComplete } from '../src/pages/dashboard/ingestionEvents';
import { RunIngestionButton } from '../src/pages/dashboard/RunIngestionButton';

/**
 * OH dashboard wiring for the manual ingestion trigger: a completed run must refetch the KPI data
 * sources (zone-overview / action-required) and the KPI cards must show the fresh figures. The trigger
 * now lives in the top bar and broadcasts on completion (see ingestionEvents); this renders the button
 * alongside the dashboard so the same decoupled bridge is exercised. Motion is snapped here
 * (reduced-motion) so the assertions read the settled real values.
 */
const opsHead: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

const summary = {
  master: { runId: '11', status: 'SUCCEEDED', stats: {} },
  snapshot: { runId: '22', status: 'SUCCEEDED', chunks: 4, inserted: 360 },
  deviceState: { upserted: 1200 },
  tickets: { created: 0 },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// zone-overview returns a different inactive total after the run so we can watch the KPI move.
function stubFetch() {
  let zoneCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, opts?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/integration/run-pipeline') && opts?.method === 'POST') return json(summary);
    if (url.includes('dashboard/zone-overview')) {
      zoneCalls += 1;
      const inactiveOperational = zoneCalls === 1 ? 40 : 55; // pre-run vs post-run refetch
      return json([
        { zoneId: '1', zoneName: 'NORTH', inactiveOperational, operationalDevices: 100, healthyOperational: 100 - inactiveOperational, warehouseDevices: 12, mirroredDevices: 112, inactivePct: inactiveOperational, fleetHealthPct: 100 - inactiveOperational, byBucket: { CRITICAL: 3 }, trendPctVsPrevDay: null },
      ]);
    }
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, zoneCalls: () => zoneCalls };
}

beforeEach(() => {
  // Snap the odometer so assertions read settled values.
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function renderHome() {
  return render(
    <AuthProvider initialSession={opsHead}>
      <MemoryRouter>
        <ToastProvider>
          <RunIngestionButton onSuccess={emitIngestionComplete} />
          <DashboardHome />
        </ToastProvider>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('OH dashboard — Run Ingestion Now wiring', () => {
  it('refetches the KPI sources on a completed run and the Inactive Devices KPI reflects the fresh value', async () => {
    const { fetchMock } = stubFetch();
    renderHome();

    // Pre-run KPI value from the first zone-overview load.
    expect(await screen.findByText('Pan-India Fleet Command')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('40')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('run-ingestion-btn'));
    await userEvent.click(screen.getByTestId('run-ingestion-confirm'));

    // The run POSTs, then the dashboard refetches zone-overview (a 2nd GET) and the KPI updates to 55.
    await waitFor(() => {
      const zoneGets = fetchMock.mock.calls.filter(([url, opts]) => {
        const method = (opts as RequestInit | undefined)?.method ?? 'GET';
        return String(url).includes('dashboard/zone-overview') && method === 'GET';
      });
      expect(zoneGets.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => expect(screen.getByText('55')).toBeInTheDocument());
  });
});
