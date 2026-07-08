import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootCauseAnalyticsPage } from '../src/pages/reports/RootCauseAnalyticsPage';

/**
 * FE-23 — Root-Cause Analytics (ref 23). KPI strip + distribution bars + breakdown table over the
 * Issue 41 `/reports/root-cause` endpoint (structured root cause from troubleshoot forms).
 */
const report = {
  fromMonth: '2026-06-01',
  toMonth: '2026-06-30',
  totalSubmissions: 40,
  filters: { zoneId: null, companyId: null, plantId: null, deviceType: null, seId: null },
  distribution: [
    { category: 'GPS_ANTENNA_ISSUE', count: 20, pct: 50 },
    { category: 'POWER_ISSUE', count: 12, pct: 30 },
    { category: 'UNKNOWN', count: 8, pct: 20 },
  ],
};

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
  sessionStorage.setItem('fsm.accessToken', 'tok');
  fetchMock.mockImplementation(async (url: string) => (String(url).includes('/reports/root-cause') ? json(report) : json({})));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Root-Cause Analytics (FE-23)', () => {
  it('renders the breakdown table with each cause and its share from the endpoint', async () => {
    render(<RootCauseAnalyticsPage />);
    expect(await screen.findByRole('heading', { name: /root-cause analytics/i })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: /root cause breakdown/i });
    const row = within(table).getByTestId('rc-row-GPS_ANTENNA_ISSUE');
    expect(row).toHaveTextContent(/50/);
    expect(row).toHaveTextContent(/20/);
  });

  it('queries the root-cause endpoint', async () => {
    render(<RootCauseAnalyticsPage />);
    await screen.findByTestId('rc-row-GPS_ANTENNA_ISSUE');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/reports/root-cause'))).toBe(true);
  });
});
