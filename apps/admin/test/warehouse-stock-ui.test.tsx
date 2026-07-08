import type { SessionView } from '@fsm/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { WarehouseDashboard } from '../src/pages/dashboard/WarehouseDashboard';

/**
 * Issue 73 / FE-17 — the Warehouse Stock table + Low-Stock + Fulfillment-SLA KPIs, filled from the new
 * `/inventory/warehouse-stock` reads (previously gated placeholders). WM can adjust a SKU (audited PATCH).
 */
const wm: SessionView = { user_id: 'wm1', role: 'WAREHOUSE_MANAGER', zone_id: null, acted_as_role: null };

const stock = [
  { zoneId: '1', zoneName: 'NORTH', componentId: '9', componentName: 'GPS Antenna', onHand: 8, reserved: 3, available: 5, lowStockThreshold: 6, lowStock: true },
  { zoneId: '1', zoneName: 'NORTH', componentId: '7', componentName: 'SIM', onHand: 40, reserved: 2, available: 38, lowStockThreshold: 10, lowStock: false },
];
const fulfillment = { totalReceived: 20, withinSlaPct: 85, avgFulfillmentHours: 30, openRequests: 4, slaWindowDays: 7 };

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function stub(extra?: (url: string, opts?: RequestInit) => Response | undefined) {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const hit = extra?.(u, opts);
    if (hit) return hit;
    if (u.includes('/inventory/warehouse-stock/fulfillment-sla')) return json(fulfillment);
    if (u.includes('/inventory/warehouse-stock')) return json(stock);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderDash(session: SessionView = wm) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter>
        <WarehouseDashboard />
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => sessionStorage.setItem('fsm.accessToken', 'tok'));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Warehouse Stock UI (Issue 73 / FE-17)', () => {
  it('fills the stock table and the Low-Stock + Fulfillment-SLA KPIs from the endpoint', async () => {
    stub();
    renderDash();
    const table = within(await screen.findByRole('table', { name: /warehouse stock/i }));
    const row = table.getByTestId('stock-row-9');
    expect(row).toHaveTextContent(/GPS Antenna/);
    expect(row).toHaveTextContent(/Low/);
    // KPIs
    expect(screen.getByText('85%')).toBeInTheDocument(); // fulfillment
    expect(screen.getByText('available ≤ threshold')).toBeInTheDocument(); // low-stock KPI label present
  });

  it('lets the WM adjust a SKU (audited PATCH)', async () => {
    stub((u, opts) => {
      if (u.includes('/inventory/warehouse-stock') && opts?.method === 'PATCH')
        return json({ zoneId: '1', zoneName: 'NORTH', componentId: '9', componentName: 'GPS Antenna', onHand: 30, reserved: 3, available: 27, lowStockThreshold: 6, lowStock: false });
      return undefined;
    });
    renderDash();
    fireEvent.click(await screen.findByTestId('stock-adjust-9'));
    const onHand = await screen.findByLabelText(/on hand/i);
    fireEvent.change(onHand, { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('stock-save'));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/inventory/warehouse-stock'), expect.objectContaining({ method: 'PATCH' })),
    );
  });
});
