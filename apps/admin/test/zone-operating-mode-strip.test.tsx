import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ZoneOperatingModeStrip } from '../src/components/dashboard/ZoneOperatingModeStrip';

/**
 * Issue 136 slice 3 — the OH/CSM cross-zone operating-mode strip. Lists every zone with its plain-language
 * mode, never the raw enum; OH + CSM only (ZM gets the own-zone card).
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
      <ZoneOperatingModeStrip />
    </AuthProvider>,
  );
}

const twoZones: ModeRow[] = [
  { zoneId: '1', zoneName: 'North', mode: 'DEFICIT', silentCount: 142, eligibleCount: 3010 },
  { zoneId: '2', zoneName: 'South', mode: 'PREVENTIVE', silentCount: 3, eligibleCount: 880 },
];

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('#136 ZoneOperatingModeStrip', () => {
  it('lists every zone with its plain mode for an Operations Head, never the raw enum', async () => {
    stubMode(twoZones);
    renderFor(oh);
    const strip = await screen.findByTestId('zone-operating-mode-strip');

    const north = within(strip).getByTestId('zone-mode-row-1');
    expect(north).toHaveTextContent('North');
    expect(north).toHaveTextContent('Catch-up');

    const south = within(strip).getByTestId('zone-mode-row-2');
    expect(south).toHaveTextContent('South');
    expect(south).toHaveTextContent('Steady');

    expect(strip).not.toHaveTextContent(/DEFICIT/i);
    expect(strip).not.toHaveTextContent(/PREVENTIVE/i);
    expect(strip).not.toHaveTextContent(/threshold/i);
  });

  it('also renders for a Central Service Manager', async () => {
    stubMode(twoZones);
    renderFor(csm);
    const strip = await screen.findByTestId('zone-operating-mode-strip');
    expect(within(strip).getByTestId('zone-mode-row-1')).toBeInTheDocument();
    expect(within(strip).getByTestId('zone-mode-row-2')).toBeInTheDocument();
  });

  it('renders an honest empty state when there are no zones', async () => {
    stubMode([]);
    renderFor(oh);
    const strip = await screen.findByTestId('zone-operating-mode-strip');
    expect(strip).toHaveTextContent(/no zones to show/i);
  });

  it('renders nothing (and does not fetch) for a ZM', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderFor(zm);
    await waitFor(() => expect(screen.queryByTestId('zone-operating-mode-strip')).not.toBeInTheDocument());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
