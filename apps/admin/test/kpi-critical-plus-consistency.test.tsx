import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { DashboardHome } from '../src/pages/dashboard/DashboardHome';
import { criticalOnlyCount, sumCriticalDevices } from '../src/lib/slaBucket';

/**
 * Issue 1 / Issue 122 — KPI consistency. The Pan-India "Critical" KPI must equal the sum of the Zone
 * Performance Scorecard's Critical column: both count strictly the CRITICAL band of inactive DEVICES
 * (Issue 122 decision — worse bands stay in the SLA distribution), never the open-ticket count. The
 * per-zone column sum equals the KPI by construction (same zone-overview source).
 */
const opsHead: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

// NORTH has 3 CRITICAL + 2 WARNING + 5 LONG_PENDING; SOUTH has 4 CRITICAL. The Critical KPI counts
// ONLY the CRITICAL band → 3 + 4 = 7 (the LONG_PENDING/WARNING devices are excluded from this card).
function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      let body: unknown = [];
      if (url.includes('dashboard/zone-overview')) {
        body = [
          { zoneId: '1', zoneName: 'NORTH', zonalManagerName: 'Asha Rao', totalInactive: 10, byBucket: { CRITICAL: 3, WARNING: 2, LONG_PENDING: 5 }, trendPctVsPrevDay: null },
          { zoneId: '2', zoneName: 'SOUTH', zonalManagerName: null, totalInactive: 4, byBucket: { CRITICAL: 4 }, trendPctVsPrevDay: null },
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

describe('Issue 122 — Critical KPI is the CRITICAL band only and matches the scorecard', () => {
  it('criticalOnlyCount counts strictly the CRITICAL bucket', () => {
    const byBucket = { WARNING: 9, EARLY_RISK: 9, RISK: 9, CRITICAL: 1, HIGH_CRITICAL: 2, SEVERE: 3, VERY_SEVERE: 4, LONG_PENDING: 5 };
    expect(criticalOnlyCount(byBucket)).toBe(1);
  });

  it('sumCriticalDevices sums the CRITICAL band across zones', () => {
    const zones: { byBucket: Record<string, number> }[] = [
      { byBucket: { CRITICAL: 3, WARNING: 2, LONG_PENDING: 5 } },
      { byBucket: { CRITICAL: 4 } },
    ];
    expect(sumCriticalDevices(zones)).toBe(7);
  });

  it('Pan-India Critical KPI counts strictly the CRITICAL band (not tickets, not worse bands)', async () => {
    stubFetch();
    render(
      <AuthProvider initialSession={opsHead}>
        <MemoryRouter>
          <DashboardHome />
        </MemoryRouter>
      </AuthProvider>,
    );

    // KPI card reads 7 (3 + 4 CRITICAL devices), NOT 1 (the single open ticket) and NOT the 5
    // LONG_PENDING (worse band, excluded from this card).
    const kpi = await screen.findByTestId('kpi-critical');
    expect(kpi).toHaveTextContent('7');
    expect(kpi).toHaveTextContent(/critical devices/i);
  });

  it('Scorecard "Inactive > 24Hr" column counts the CRITICAL band and worse (24h+)', async () => {
    stubFetch();
    render(
      <AuthProvider initialSession={opsHead}>
        <MemoryRouter>
          <DashboardHome />
        </MemoryRouter>
      </AuthProvider>,
    );

    // The scorecard column is every device inactive 24h+ (CRITICAL + worse bands), NOT the CRITICAL-only
    // KPI: NORTH = 3 CRITICAL + 5 LONG_PENDING = 8, SOUTH = 4 → 12 (the 2 WARNING devices are < 24h).
    const scorecard = await screen.findByRole('table', { name: /zone performance scorecard/i });
    const cells = within(scorecard).getAllByTestId('scorecard-inactive-24h').map((c) => Number(c.textContent));
    expect(cells.reduce((s, n) => s + n, 0)).toBe(12);
  });

  it('shows the Zonal Manager name column on the scorecard', async () => {
    stubFetch();
    render(
      <AuthProvider initialSession={opsHead}>
        <MemoryRouter>
          <DashboardHome />
        </MemoryRouter>
      </AuthProvider>,
    );
    const scorecard = within(await screen.findByRole('table', { name: /zone performance scorecard/i }));
    expect(scorecard.getByText('Asha Rao')).toBeInTheDocument();
  });
});
