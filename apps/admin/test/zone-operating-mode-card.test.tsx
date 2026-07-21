import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ZoneOperatingModeCard } from '../src/components/dashboard/ZoneOperatingModeCard';

/**
 * Issue 136 slice 2 — the ZM own-zone operating-mode card. It shows the plain-language label + reason +
 * a human fact, never the raw engine enum, and is ZM-only (OH/CSM get the cross-zone strip).
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

const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const oh: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

function renderFor(session: SessionView) {
  return render(
    <AuthProvider initialSession={session}>
      <ZoneOperatingModeCard />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('#136 ZoneOperatingModeCard', () => {
  it('shows the plain "Catch-up" label + reason + fact for a DEFICIT zone, never the raw enum', async () => {
    stubMode([{ zoneId: '1', zoneName: 'North', mode: 'DEFICIT', silentCount: 142, eligibleCount: 3010 }]);
    renderFor(zm);
    const card = await screen.findByTestId('zone-operating-mode-card');
    expect(card).toHaveTextContent('Catch-up');
    expect(card).toHaveTextContent(/getting engineers to those outages/i);
    expect(card).toHaveTextContent('142 of 3,010 devices we track in your zone are currently quiet.');
    expect(card).not.toHaveTextContent(/DEFICIT/i);
    expect(card).not.toHaveTextContent(/threshold/i);
  });

  it('shows the plain "Steady" label for a PREVENTIVE zone', async () => {
    stubMode([{ zoneId: '1', zoneName: 'North', mode: 'PREVENTIVE', silentCount: 2, eligibleCount: 900 }]);
    renderFor(zm);
    const card = await screen.findByTestId('zone-operating-mode-card');
    expect(card).toHaveTextContent('Steady');
    expect(card).not.toHaveTextContent(/PREVENTIVE/i);
  });

  it('renders an honest empty state when the zone has no data', async () => {
    stubMode([]);
    renderFor(zm);
    const card = await screen.findByTestId('zone-operating-mode-card');
    expect(card).toHaveTextContent(/enough data/i);
  });

  it('renders nothing (and does not fetch) for a non-ZM role', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderFor(oh);
    await waitFor(() => expect(screen.queryByTestId('zone-operating-mode-card')).not.toBeInTheDocument());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
