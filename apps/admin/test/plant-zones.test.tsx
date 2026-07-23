import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlantZonesPage } from '../src/pages/admin/PlantZonesPage';
import { buildNav } from '../src/components/shell/nav';

/**
 * #158 S2 — the Operations-Head plant zone reassignment surface.
 *
 * Two things this page must get right that a plain CRUD form would get wrong:
 * 1. A PUT alone is INERT. Master sync is insert-only on `plants.zone_id`, so an override changes
 *    nothing for an already-synced plant until `reapply` runs — the page therefore chains PUT →
 *    reapply and shows the reapply counts as the evidence the edit actually landed.
 * 2. A reason is mandatory. The override row is overwritten on re-pin, so the reason survives only
 *    in `audit_logs`.
 */
const PLANTS = [
  {
    plantId: 1,
    name: 'Alpha Cement',
    zoneId: 9,
    zoneName: 'UNZONED',
    sourcePlantId: '5001',
    sourceZoneName: 'Testonia Zone',
  },
  {
    plantId: 2,
    name: 'Beta Steel',
    zoneId: 3,
    zoneName: 'East',
    sourcePlantId: '5002',
    sourceZoneName: 'EAST',
  },
];

const ZONES = [
  { zoneId: 3, name: 'East' },
  { zoneId: 4, name: 'South' },
  { zoneId: 9, name: 'UNZONED' },
];

const OVERRIDES = [
  { sourcePlantId: '5002', fsmZoneId: '3', fsmZoneName: 'East', reason: 'ops asked' },
];

const REAPPLY = { plantsConsidered: 751, updated: 1, unchanged: 750, landedUnzoned: 3 };

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();

/** Routes each call by URL so assertions can read the calls back by endpoint. */
function route(url: string, init?: RequestInit): Response {
  if (url.includes('/org/plant-zone-overrides')) {
    if (init?.method === 'PUT') return json({ sourcePlantId: '5001', fsmZoneId: '4', fsmZoneName: 'South', reason: 'x' });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return json(OVERRIDES);
  }
  if (url.includes('/org/zone-mappings/reapply')) return json(REAPPLY);
  if (url.includes('/org/plants')) return json(PLANTS);
  if (url.includes('/org/zones')) return json(ZONES);
  return json([]);
}

const callsTo = (fragment: string, method?: string) =>
  fetchMock.mock.calls.filter(
    ([url, init]) => String(url).includes(fragment) && (method === undefined || init?.method === method),
  );

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => route(String(url), init));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Plant Zones nav gating (#158)', () => {
  const link = (role: string) =>
    buildNav(role)
      .flatMap((g) => g.items)
      .find((i) => i.to === '/plant-zones');

  it('shows the nav entry only to the Operations Head', () => {
    expect(link('OPERATIONS_HEAD')).toBeDefined();
    expect(link('ZONAL_MANAGER')).toBeUndefined();
    expect(link('CENTRAL_SERVICE_MANAGER')).toBeUndefined();
    expect(link('SERVICE_ENGINEER')).toBeUndefined();
    expect(link('WAREHOUSE_MANAGER')).toBeUndefined();
  });
});

describe('Plant Zones page (#158)', () => {
  it('shows each plant’s resolved zone next to what AutoPlant claims, and badges overrides', async () => {
    render(<PlantZonesPage />);

    const unzoned = within(await screen.findByTestId('plant-zone-row-5001'));
    expect(unzoned.getByText('Alpha Cement')).toBeInTheDocument();
    expect(unzoned.getByText('UNZONED')).toBeInTheDocument();
    expect(unzoned.getByText('Testonia Zone')).toBeInTheDocument();

    const overridden = within(screen.getByTestId('plant-zone-row-5002'));
    expect(overridden.getByTestId('override-badge-5002')).toHaveTextContent(/pinned/i);
    expect(overridden.getByText(/ops asked/)).toBeInTheDocument();
  });

  it('filters to the UNZONED worklist', async () => {
    render(<PlantZonesPage />);
    await screen.findByTestId('plant-zone-row-5001');

    await userEvent.click(screen.getByTestId('filter-unzoned'));

    expect(screen.getByTestId('plant-zone-row-5001')).toBeInTheDocument();
    expect(screen.queryByTestId('plant-zone-row-5002')).not.toBeInTheDocument();
  });

  it('pins a plant, then runs reapply and reports what it changed', async () => {
    render(<PlantZonesPage />);
    await userEvent.click(await screen.findByTestId('change-zone-5001'));

    await userEvent.selectOptions(await screen.findByTestId('zone-select'), '4');
    await userEvent.type(screen.getByTestId('reason-input'), 'ops confirmed south');
    await userEvent.click(screen.getByTestId('confirm-zone-change'));

    await waitFor(() => expect(callsTo('/org/plant-zone-overrides', 'PUT')).toHaveLength(1));
    const [, init] = callsTo('/org/plant-zone-overrides', 'PUT')[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      sourcePlantId: '5001',
      fsmZoneId: 4,
      reason: 'ops confirmed south',
    });

    // The PUT alone would be inert — reapply is what moves plants.zone_id.
    await waitFor(() => expect(callsTo('/org/zone-mappings/reapply', 'POST')).toHaveLength(1));
    expect(await screen.findByTestId('reapply-result')).toHaveTextContent(/1 plant/i);
  });

  it('refuses to submit a zone change with no reason, and calls nothing', async () => {
    render(<PlantZonesPage />);
    await userEvent.click(await screen.findByTestId('change-zone-5001'));

    await userEvent.selectOptions(await screen.findByTestId('zone-select'), '4');
    await userEvent.click(screen.getByTestId('confirm-zone-change'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/reason is required/i);
    expect(callsTo('/org/plant-zone-overrides', 'PUT')).toHaveLength(0);
    expect(callsTo('/org/zone-mappings/reapply', 'POST')).toHaveLength(0);
  });

  it('clears an override and reapplies so the plant falls back to the crosswalk', async () => {
    render(<PlantZonesPage />);
    await userEvent.click(await screen.findByTestId('clear-override-5002'));
    await userEvent.click(await screen.findByTestId('confirm-clear-override'));

    await waitFor(() =>
      expect(callsTo('/org/plant-zone-overrides/5002', 'DELETE')).toHaveLength(1),
    );
    await waitFor(() => expect(callsTo('/org/zone-mappings/reapply', 'POST')).toHaveLength(1));
  });
});
