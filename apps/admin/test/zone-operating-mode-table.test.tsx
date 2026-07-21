import type { SessionView } from '@fsm/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ZoneOperatingModeTable } from '../src/components/dashboard/ZoneOperatingModeTable';

/**
 * Issue 136 slice 3 — the OH/CSM cross-zone operating-mode TABLE (sortable). Lists every zone with its
 * plain-language mode, never the raw enum; sortable header row; OH + CSM only (ZM gets the own-zone card).
 */
type ModeRow = {
  zoneId: string;
  zoneName: string;
  mode: 'DEFICIT' | 'PREVENTIVE';
  silentCount: number;
  eligibleCount: number;
};

function stubMode(rows: ModeRow[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/dashboard/operating-mode')) {
        return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

const oh: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const csm: SessionView = { user_id: 'csm1', role: 'CENTRAL_SERVICE_MANAGER', zone_id: null, acted_as_role: null };
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

function renderFor(session: SessionView) {
  return render(
    <AuthProvider initialSession={session}>
      <ZoneOperatingModeTable />
    </AuthProvider>,
  );
}

// Alphabetical order (Alpha < Zeta) deliberately differs from the attention-first default
// (Zeta is Catch-up, Alpha is Steady) so a Zone-header sort visibly re-orders.
const zones: ModeRow[] = [
  { zoneId: '10', zoneName: 'Alpha', mode: 'PREVENTIVE', silentCount: 1, eligibleCount: 500 },
  { zoneId: '20', zoneName: 'Zeta', mode: 'DEFICIT', silentCount: 200, eligibleCount: 1000 },
];

const dataRowNames = () =>
  screen
    .getAllByRole('row')
    .slice(1) // drop the header row
    .map((r) => r.textContent ?? '');

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('#136 ZoneOperatingModeTable', () => {
  it('renders a row per zone with its plain mode for an Operations Head, never the raw enum', async () => {
    stubMode(zones);
    renderFor(oh);
    const table = await screen.findByTestId('zone-operating-mode-table');
    expect(within(table).getByTestId('zone-mode-row-10')).toHaveTextContent('Steady');
    expect(within(table).getByTestId('zone-mode-row-20')).toHaveTextContent('Catch-up');
    expect(table).not.toHaveTextContent(/DEFICIT|PREVENTIVE|threshold/i);
  });

  it('defaults to attention-first order (Catch-up zones on top)', async () => {
    stubMode(zones);
    renderFor(oh);
    await screen.findByTestId('zone-operating-mode-table');
    const names = dataRowNames();
    expect(names[0]).toContain('Zeta'); // Catch-up first
    expect(names[1]).toContain('Alpha'); // Steady second
  });

  it('re-sorts alphabetically when the Zone header is clicked', async () => {
    stubMode(zones);
    renderFor(oh);
    await screen.findByTestId('zone-operating-mode-table');
    fireEvent.click(screen.getByRole('button', { name: /sort by zone/i }));
    const names = dataRowNames();
    expect(names[0]).toContain('Alpha');
    expect(names[1]).toContain('Zeta');
  });

  it('also renders for a Central Service Manager', async () => {
    stubMode(zones);
    renderFor(csm);
    const table = await screen.findByTestId('zone-operating-mode-table');
    expect(within(table).getByTestId('zone-mode-row-10')).toBeInTheDocument();
    expect(within(table).getByTestId('zone-mode-row-20')).toBeInTheDocument();
  });

  it('renders an honest empty state when there are no zones', async () => {
    stubMode([]);
    renderFor(oh);
    const table = await screen.findByTestId('zone-operating-mode-table');
    expect(table).toHaveTextContent(/no zones to show/i);
  });

  it('renders nothing (and does not fetch) for a ZM', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderFor(zm);
    await waitFor(() => expect(screen.queryByTestId('zone-operating-mode-table')).not.toBeInTheDocument());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
