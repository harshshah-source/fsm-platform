import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlantDeactivationsPage } from '../src/pages/admin/PlantDeactivationsPage';
import { buildNav } from '../src/components/shell/nav';

/**
 * Issue 119 — the OH Plant Deactivations page + role-gated nav. Covers nav visibility (OH only),
 * the list render, the Reactivate confirm → API call, and the Deactivate flow's mandatory-reason
 * validation.
 */
const ROWS = [
  {
    id: '1',
    plantId: '3040',
    plantName: 'JORHAT CPW-SCL-LUMS',
    sourcePlantId: '3040',
    company: 'STAR CEMENT',
    zone: 'UNZONED',
    deviceCount: 280,
    reason: 'STAR CEMENT shutdown (disputed)',
    deactivatedBy: 'abcdef12-0000-0000-0000-000000000000',
    deactivatedAt: '2026-07-14T06:00:00.000Z',
  },
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Plant Deactivations nav gating (Issue 119)', () => {
  const link = (role: string) =>
    buildNav(role)
      .flatMap((g) => g.items)
      .find((i) => i.to === '/plant-deactivations');

  it('shows the nav entry only to the Operations Head', () => {
    expect(link('OPERATIONS_HEAD')).toBeDefined();
    expect(link('ZONAL_MANAGER')).toBeUndefined();
    expect(link('CENTRAL_SERVICE_MANAGER')).toBeUndefined();
    expect(link('SERVICE_ENGINEER')).toBeUndefined();
  });
});

describe('Plant Deactivations page (Issue 119)', () => {
  it('lists active deactivations with company, plant and device count', async () => {
    fetchMock.mockImplementation(async () => json(ROWS));
    render(<PlantDeactivationsPage />);
    const row = await screen.findByTestId('deactivation-3040');
    expect(within(row).getByText('STAR CEMENT')).toBeInTheDocument();
    expect(within(row).getByText('JORHAT CPW-SCL-LUMS')).toBeInTheDocument();
    expect(within(row).getByText('280')).toBeInTheDocument();
  });

  it('reactivate → confirm dialog → API call', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/reactivate')) return json({ result: 'OK' });
      return json(ROWS);
    });
    render(<PlantDeactivationsPage />);
    await userEvent.click(await screen.findByTestId('reactivate-3040'));
    expect(screen.getByText(/re-created for still-inactive devices/i)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('confirm-reactivate'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/plants/3040/reactivate'))).toBe(true),
    );
  });

  it('deactivate flow blocks submit until a reason is given', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/org/plants')) return json([{ plantId: 3040, name: 'JORHAT', zoneId: 1 }]);
      return json(ROWS);
    });
    render(<PlantDeactivationsPage />);
    await userEvent.click(await screen.findByTestId('open-deactivate'));
    await userEvent.click(screen.getByTestId('confirm-deactivate'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/plant|reason/i);
    // No deactivate call was made (validation blocked it).
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/deactivate'))).toBe(false);
  });
});
