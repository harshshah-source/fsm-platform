import type { SessionView } from '@fsm/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { buildNav } from '../src/components/shell/nav';
import { TierOverridesPage } from '../src/pages/admin/TierOverridesPage';

/**
 * #157 S5 — the scoped, expiring company tier overrides surface (AC-7). A role-variant page (ZM own
 * zone; CSM/OH any zone), not a Settings section, since Settings is OH-only in the v2 reference yet
 * this feature is for CSM/ZM — the documented parity discrepancy (mirrors #158 Plant Zones). The list
 * doubles as the monthly report; the live winning override per (company, zone) pair is badged (AC-6).
 */
const COMPANIES = [
  { companyId: 10, name: 'Acme Cement', companyTier: 'SILVER', companyPriorityRank: 'C', opsOverride: false },
  { companyId: 11, name: 'Beta Metals', companyTier: 'GOLD', companyPriorityRank: 'B', opsOverride: false },
];
const ZONES = [
  { zoneId: 1, name: 'North', zonalManagerUserId: null },
  { zoneId: 2, name: 'South', zonalManagerUserId: null },
];
// Deliberately NOT in canonical priority order — the dropdown-sourcing test proves options read this.
const TIERS = [
  { name: 'SILVER', rank: 3 },
  { name: 'GOLD', rank: 2 },
  { name: 'PLATINUM', rank: 1 },
];
const OVERRIDES = [
  {
    id: '100',
    companyId: 10,
    companyName: 'Acme Cement',
    zoneId: 1,
    zoneName: 'North',
    tier: 'PLATINUM',
    reason: 'peak-season priority for the North zone',
    expiresAt: '2026-08-30T00:00:00.000Z',
    status: 'ACTIVE',
    createdBy: 'oh1',
    createdAt: '2026-07-20T00:00:00.000Z',
    isWinning: true,
  },
  {
    id: '101',
    companyId: 10,
    companyName: 'Acme Cement',
    zoneId: 1,
    zoneName: 'North',
    tier: 'GOLD',
    reason: 'older stacked override, since superseded',
    expiresAt: '2026-08-25T00:00:00.000Z',
    status: 'ACTIVE',
    createdBy: 'oh1',
    createdAt: '2026-07-10T00:00:00.000Z',
    isWinning: false,
  },
];

const opsHead: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();

function route(url: string, init?: RequestInit): Response {
  if (url.includes('/org/tier-overrides')) {
    if (init?.method === 'POST') return json({ ...OVERRIDES[0], id: '200' });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return json(OVERRIDES);
  }
  if (url.includes('/org/companies')) return json(COMPANIES);
  if (url.includes('/org/zones')) return json(ZONES);
  if (url.includes('/org/tiers')) return json(TIERS);
  return json([]);
}

const callsTo = (fragment: string, method?: string) =>
  fetchMock.mock.calls.filter(
    ([url, init]) => String(url).includes(fragment) && (method === undefined || init?.method === method),
  );

function renderPage(session: SessionView) {
  return render(
    <AuthProvider initialSession={session}>
      <TierOverridesPage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => route(String(url), init));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Tier Overrides nav gating (#157 S5)', () => {
  const link = (role: string) =>
    buildNav(role)
      .flatMap((g) => g.items)
      .find((i) => i.to === '/tier-overrides');

  it('shows the nav entry to ZM, CSM and OH, and hides it from SE and Warehouse', () => {
    expect(link('ZONAL_MANAGER')).toBeDefined();
    expect(link('CENTRAL_SERVICE_MANAGER')).toBeDefined();
    expect(link('OPERATIONS_HEAD')).toBeDefined();
    expect(link('SERVICE_ENGINEER')).toBeUndefined();
    expect(link('WAREHOUSE_MANAGER')).toBeUndefined();
  });
});

describe('Tier Overrides page (#157 S5)', () => {
  it('lists active overrides and badges the live winning one per pair; not the superseded one', async () => {
    renderPage(opsHead);
    const winning = within(await screen.findByTestId('tier-override-row-100'));
    expect(winning.getByText('Acme Cement')).toBeInTheDocument();
    expect(winning.getByTestId('winning-100')).toHaveTextContent(/winning/i);

    const superseded = within(screen.getByTestId('tier-override-row-101'));
    expect(superseded.queryByTestId('winning-101')).not.toBeInTheDocument();
  });

  it('states the Q-B scope on the page (dispatch + new tickets only; existing tickets keep their tier)', async () => {
    renderPage(opsHead);
    await screen.findByTestId('tier-override-row-100');
    expect(screen.getByTestId('scope-note')).toHaveTextContent(/existing tickets keep the tier/i);
  });

  it('creates an override: POSTs company, zone, tier, reason and the expiry as ISO', async () => {
    renderPage(opsHead);
    await userEvent.click(await screen.findByTestId('open-create'));

    await userEvent.selectOptions(await screen.findByTestId('company-select'), '10');
    await userEvent.selectOptions(screen.getByTestId('zone-select'), '1');
    await userEvent.selectOptions(screen.getByTestId('tier-select'), 'PLATINUM');
    await userEvent.type(screen.getByTestId('reason-input'), 'regional sales escalation for Q3');
    fireEvent.change(screen.getByTestId('expiry-input'), { target: { value: '2026-09-01' } });
    await userEvent.click(screen.getByTestId('confirm-create'));

    await waitFor(() => expect(callsTo('/org/tier-overrides', 'POST')).toHaveLength(1));
    const [, init] = callsTo('/org/tier-overrides', 'POST')[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      companyId: 10,
      zoneId: 1,
      tier: 'PLATINUM',
      reason: 'regional sales escalation for Q3',
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('refuses to submit a reason under 10 characters and calls nothing', async () => {
    renderPage(opsHead);
    await userEvent.click(await screen.findByTestId('open-create'));

    await userEvent.selectOptions(await screen.findByTestId('company-select'), '10');
    await userEvent.selectOptions(screen.getByTestId('zone-select'), '1');
    await userEvent.selectOptions(screen.getByTestId('tier-select'), 'PLATINUM');
    await userEvent.type(screen.getByTestId('reason-input'), 'too short');
    fireEvent.change(screen.getByTestId('expiry-input'), { target: { value: '2026-09-01' } });
    await userEvent.click(screen.getByTestId('confirm-create'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 10 characters/i);
    expect(callsTo('/org/tier-overrides', 'POST')).toHaveLength(0);
  });

  it('sources the tier dropdown from /org/tiers, not a hard-coded canonical order (AC-1 pattern)', async () => {
    renderPage(opsHead);
    await userEvent.click(await screen.findByTestId('open-create'));
    const select = await screen.findByTestId('tier-select');
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent)
      .filter((t) => t && !/select a tier/i.test(t));
    expect(options).toEqual(['SILVER', 'GOLD', 'PLATINUM']);
  });

  it('locks the zone to a ZM’s home zone (no zone picker) and posts that zone', async () => {
    renderPage(zm);
    await userEvent.click(await screen.findByTestId('open-create'));

    expect(screen.queryByTestId('zone-select')).not.toBeInTheDocument();
    expect(screen.getByTestId('zone-locked')).toHaveValue('North');

    await userEvent.selectOptions(screen.getByTestId('company-select'), '10');
    await userEvent.selectOptions(screen.getByTestId('tier-select'), 'GOLD');
    await userEvent.type(screen.getByTestId('reason-input'), 'zm raising this account this quarter');
    fireEvent.change(screen.getByTestId('expiry-input'), { target: { value: '2026-09-01' } });
    await userEvent.click(screen.getByTestId('confirm-create'));

    await waitFor(() => expect(callsTo('/org/tier-overrides', 'POST')).toHaveLength(1));
    const [, init] = callsTo('/org/tier-overrides', 'POST')[0];
    expect(JSON.parse(String(init?.body)).zoneId).toBe(1);
  });

  it('cancels an active override via DELETE', async () => {
    renderPage(opsHead);
    await userEvent.click(await screen.findByTestId('cancel-100'));
    await userEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(callsTo('/org/tier-overrides/100', 'DELETE')).toHaveLength(1));
  });
});
