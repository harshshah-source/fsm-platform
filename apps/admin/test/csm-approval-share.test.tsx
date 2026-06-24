import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsmApprovalSharePage } from '../src/pages/reports/CsmApprovalSharePage';

/**
 * Issue 27 AC#5 — the CSM Backup Share report (Operations Head). Per-zone share of acted-as-backup
 * actions performed by a CSM this month.
 */
const rows = [
  { zoneId: '1', csmActions: 8, totalActedActions: 10, sharePct: 80 },
  { zoneId: '2', csmActions: 1, totalActedActions: 4, sharePct: 25 },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockImplementation(async () => json(rows));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('CSM Backup Share report (Issue 27)', () => {
  it('lists per-zone CSM backup share', async () => {
    render(<CsmApprovalSharePage />);
    const table = within(await screen.findByRole('table', { name: /csm backup share/i }));
    expect(within(screen.getByTestId('csm-row-1')).getByText('80%')).toBeInTheDocument();
    expect(within(screen.getByTestId('csm-row-2')).getByText('25%')).toBeInTheDocument();
    expect(table.getByText(/Zone 1/)).toBeInTheDocument();
  });
});
