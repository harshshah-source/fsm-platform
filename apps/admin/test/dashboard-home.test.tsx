import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { DashboardHome } from '../src/pages/dashboard/DashboardHome';

/**
 * Issue 06 slice 5 — the Zone Operations Dashboard landing, Zone Overview section (AC#2, AC#5).
 * Renders per-zone inactive counts broken down by SLA bucket with the reference colour coding, a
 * trend placeholder (Issue 40), and a CSV export. ACTIVE never appears.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

function stubFetch(byUrl: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const key = Object.keys(byUrl).find((k) => url.includes(k));
      const body = key ? byUrl[key] : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function renderHome(session: SessionView) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter>
        <DashboardHome />
      </MemoryRouter>
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Zone Operations Dashboard — Zone Overview (Issue 06 AC#2/#5)', () => {
  it('renders per-zone bucket counts with a trend placeholder and no ACTIVE', async () => {
    stubFetch({
      'dashboard/zone-overview': [
        {
          zoneId: '1',
          zoneName: 'NORTH',
          totalInactive: 5,
          byBucket: { CRITICAL: 3, WARNING: 2 },
          trendPctVsPrevDay: null,
        },
      ],
      'dashboard/action-required': [],
    });

    renderHome(zm);

    const table = await screen.findByRole('table', { name: /zone overview/i });
    const row = within(table).getByText('NORTH').closest('tr')!;
    expect(within(row).getByText('5')).toBeInTheDocument(); // total inactive
    // CRITICAL bucket cell carries the bucket identity for colour coding.
    const critical = within(row).getByTestId('bucket-CRITICAL');
    expect(critical).toHaveTextContent('3');
    // Trend is a neutral placeholder until Issue 40.
    expect(within(row).getByTestId('trend')).toHaveTextContent('—');
    // ACTIVE is never a column or value.
    expect(screen.queryByText('ACTIVE')).not.toBeInTheDocument();
  });

  it('offers a CSV export for the Zone Overview', async () => {
    stubFetch({ 'dashboard/zone-overview': [], 'dashboard/action-required': [] });
    renderHome(zm);
    expect(await screen.findByRole('button', { name: /export zone overview/i })).toBeInTheDocument();
  });
});
