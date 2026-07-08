import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { DashboardHome } from '../src/pages/dashboard/DashboardHome';
import { criticalPlusCount, sumCriticalPlusDevices } from '../src/lib/slaBucket';

/**
 * Issue 1 — KPI consistency. The Pan-India "Critical+" KPI must equal the sum of the Zone Performance
 * Scorecard's Critical+ column: both are the count of inactive DEVICES in critical+ buckets, never the
 * open-ticket count. A + B + C + D = X by construction (same zone-overview source).
 */
const opsHead: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

// NORTH has 3 CRITICAL (critical+) + 2 WARNING; SOUTH has 4 SEVERE (critical+); only ONE open ticket
// exists — so a ticket-based KPI would read 1 while the device-based scorecard sums to 7.
function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      let body: unknown = [];
      if (url.includes('dashboard/zone-overview')) {
        body = [
          { zoneId: '1', zoneName: 'NORTH', totalInactive: 5, byBucket: { CRITICAL: 3, WARNING: 2 }, trendPctVsPrevDay: null },
          { zoneId: '2', zoneName: 'SOUTH', totalInactive: 4, byBucket: { SEVERE: 4 }, trendPctVsPrevDay: null },
        ];
      } else if (url.includes('dashboard/critical-queue')) {
        body = [
          {
            companyId: '10', companyName: 'Acme', companyTier: 'PLATINUM', zoneId: '1',
            plantId: '7', plantName: 'Yard-1', clusterSize: 1, suggestedSes: [],
            tickets: [{ ticketId: 't1', deviceId: '900', slaBucket: 'CRITICAL', status: 'OPEN' }],
          },
        ];
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Issue 1 — Critical+ definition is device-based and identical everywhere', () => {
  it('criticalPlusCount sums exactly the five critical+ buckets', () => {
    const byBucket = { WARNING: 9, EARLY_RISK: 9, RISK: 9, CRITICAL: 1, HIGH_CRITICAL: 2, SEVERE: 3, VERY_SEVERE: 4, LONG_PENDING: 5 };
    expect(criticalPlusCount(byBucket)).toBe(1 + 2 + 3 + 4 + 5);
  });

  it('sumCriticalPlusDevices sums critical+ across zones', () => {
    const zones: { byBucket: Record<string, number> }[] = [
      { byBucket: { CRITICAL: 3, WARNING: 2 } },
      { byBucket: { SEVERE: 4 } },
    ];
    expect(sumCriticalPlusDevices(zones)).toBe(7);
  });

  it('Pan-India Critical+ KPI equals the scorecard Critical+ column sum (device-based, not tickets)', async () => {
    stubFetch();
    render(
      <AuthProvider initialSession={opsHead}>
        <MemoryRouter>
          <DashboardHome />
        </MemoryRouter>
      </AuthProvider>,
    );

    // KPI card reads 7 (3 + 4 critical+ devices), NOT 1 (the single open ticket).
    const kpi = await screen.findByTestId('kpi-critical-plus');
    expect(kpi).toHaveTextContent('7');
    expect(kpi).toHaveTextContent(/critical\+ devices/i);

    // Scorecard Critical+ column: NORTH = 3, SOUTH = 4, summing to the KPI.
    const scorecard = screen.getByRole('table', { name: /zone performance scorecard/i });
    const cells = within(scorecard).getAllByTestId('scorecard-critical-plus').map((c) => Number(c.textContent));
    expect(cells.reduce((s, n) => s + n, 0)).toBe(7);
  });
});
