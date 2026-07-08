import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemEfficiencyPage } from '../src/pages/reports/SystemEfficiencyPage';

/**
 * FE-24 — System Efficiency (ref 24). Dense KPI grid + auto-dispatch-by-zone bars + per-zone table
 * over the Issue 42 `/reports/efficiency` endpoint. Panels with no aggregation source render gated.
 */
const metrics = {
  failureCyclesOpened: 100, ticketsCreated: 120, troubleshootTicketsCreated: 110,
  autoAssignments: 99, manualAssignments: 21, overrides: 12,
  autoAssignmentRatePct: 82.5, manualAssignmentRatePct: 17.5, overrideRatePct: 10,
  cyclesResolved: 90, verifiedCycles: 80, failedVerifications: 6, autoRecoveries: 14,
  repeatFailures: 9, firstTimeFixes: 70, componentPauses: 4, agedResolutions: 3, autoEscalations: 3,
  repeatFailureRatePct: 9, firstTimeFixRatePct: 70, failedVerificationRatePct: 5, autoRecoveryRatePct: 15,
};
const report = {
  from: '2026-06-01', to: '2026-06-30',
  filters: { zoneId: null, companyId: null, plantId: null, deviceType: null, seId: null },
  fleet: metrics,
  byZone: [{ ...metrics, zoneId: '1', zoneName: 'West', ticketsCreated: 60, autoAssignmentRatePct: 80 }],
};

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
  sessionStorage.setItem('fsm.accessToken', 'tok');
  fetchMock.mockImplementation(async (url: string) => (String(url).includes('/reports/efficiency') ? json(report) : json({})));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('System Efficiency (FE-24)', () => {
  it('renders the KPI grid and the per-zone efficiency table from the endpoint', async () => {
    render(<SystemEfficiencyPage />);
    expect(await screen.findByRole('heading', { name: /system efficiency/i })).toBeInTheDocument();
    // Auto-dispatch KPI (fleet auto-assignment rate)
    expect(await screen.findByText('82.5%')).toBeInTheDocument();
    // Per-zone table row
    const table = await screen.findByRole('table', { name: /efficiency by zone/i });
    const row = within(table).getByTestId('eff-row-1');
    expect(row).toHaveTextContent(/West/);
    expect(row).toHaveTextContent(/80/);
  });

  it('queries the efficiency endpoint', async () => {
    render(<SystemEfficiencyPage />);
    await screen.findByTestId('eff-row-1');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/reports/efficiency'))).toBe(true);
  });
});
