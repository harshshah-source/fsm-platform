import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportsPage } from '../src/pages/exports/ExportsPage';
import { buildNav } from '../src/components/shell/nav';

/**
 * Issue 120 — the Operations-Head Exports page + its role-gated nav entry. Covers the nav visibility
 * matrix (OH sees "Exports", managers/SE do not), the card + summary hint render, and the download
 * action (auth-fetch of the CSV endpoint → browser download trigger).
 */

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const csv = (body: string) =>
  new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="entity-mapping-2026-07-14.csv"',
    },
  });

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  // jsdom lacks object-URL APIs used by the download trigger.
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Exports nav gating (Issue 120)', () => {
  const exportsLink = (role: string) =>
    buildNav(role)
      .flatMap((g) => g.items)
      .find((i) => i.to === '/exports');

  it('shows the Exports nav entry only to the Operations Head', () => {
    expect(exportsLink('OPERATIONS_HEAD')).toBeDefined();
    expect(exportsLink('ZONAL_MANAGER')).toBeUndefined();
    expect(exportsLink('CENTRAL_SERVICE_MANAGER')).toBeUndefined();
    expect(exportsLink('SERVICE_ENGINEER')).toBeUndefined();
    expect(exportsLink('WAREHOUSE_MANAGER')).toBeUndefined();
  });
});

/** APPROVED vouchers, two of them submitted in the month under test and one in the month before. */
const approvedVouchers = [
  { voucherId: 'v-1', status: 'APPROVED', submittedAt: '2026-07-03T06:00:00.000Z', totalAmount: 1200, items: [] },
  { voucherId: 'v-2', status: 'APPROVED', submittedAt: '2026-07-28T11:30:00.000Z', totalAmount: 800, items: [] },
  { voucherId: 'v-3', status: 'APPROVED', submittedAt: '2026-06-30T18:00:00.000Z', totalAmount: 500, items: [] },
];

/** Routes every call this page makes; anything unrecognised answers an empty object. */
const route = (url: string) => {
  if (url.includes('/exports/entity-mapping/summary')) return json({ rowCount: 18942, dataAsOf: '2026-07-14T04:00:00.000Z' });
  if (url.includes('/exports/entity-mapping')) return csv('device_id\n123\n');
  if (url.includes('/vouchers/export')) return new Response('voucher_id\nv-1\n', { status: 200 });
  if (url.includes('/vouchers')) return json(approvedVouchers);
  return json({});
};

describe('Exports page (Issue 120)', () => {
  it('renders the entity-mapping card with the row-count/freshness hint', async () => {
    fetchMock.mockImplementation(async (url: string) => route(String(url)));
    render(<ExportsPage />);
    expect(screen.getByText('Entity mapping (CSV)')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('entity-mapping-hint')).toHaveTextContent('18,942 devices'),
    );
  });

  it('downloads the CSV via an auth-fetch of the export endpoint', async () => {
    fetchMock.mockImplementation(async (url: string) => route(String(url)));
    render(<ExportsPage />);
    await userEvent.click(screen.getByTestId('download-entity-mapping'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).endsWith('/exports/entity-mapping')),
      ).toBe(true),
    );
    expect(await screen.findByText(/Last downloaded/)).toBeInTheDocument();
  });
});

/**
 * #364 AC4 — the finance voucher batch card.
 *
 * `GET /vouchers/export?month=` has existed since Issue 59/60 and lived only on the Vouchers page,
 * behind the review queue. The Operations Head who runs the monthly finance pull is not reviewing
 * vouchers; they are on the Exports hub, which showed one card and gave no hint the export existed
 * (§1 correction RPT-08 — a hub card, not an integration).
 *
 * The row count is derived from the APPROVED queue rather than a new endpoint, and that is a real
 * decision rather than a shortcut: the export's own predicate is `status = 'APPROVED' AND
 * submitted_at ∈ month` (`vouchers.service.ts:475-479`), and `GET /vouchers?status=APPROVED` returns
 * exactly that population unpaged. The count and the file therefore cannot disagree — a separate
 * summary endpoint would be a second implementation of the same predicate, free to drift from it.
 */
describe('Exports page — finance voucher batch (#364)', () => {
  it('shows the approved-voucher row count for the picked month, counting only that month', async () => {
    fetchMock.mockImplementation(async (url: string) => route(String(url)));
    render(<ExportsPage />);
    expect(screen.getByText(/finance voucher batch/i)).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText(/voucher month/i));
    await userEvent.type(screen.getByLabelText(/voucher month/i), '2026-07');

    // v-1 and v-2 are July; v-3 is June and must not be counted.
    await waitFor(() => expect(screen.getByTestId('voucher-batch-hint')).toHaveTextContent('2 approved vouchers'));
    expect(screen.getByTestId('voucher-batch-hint')).toHaveTextContent('₹2,000');
  });

  it('downloads the month’s finance CSV from the existing export endpoint', async () => {
    fetchMock.mockImplementation(async (url: string) => route(String(url)));
    render(<ExportsPage />);
    await userEvent.clear(screen.getByLabelText(/voucher month/i));
    await userEvent.type(screen.getByLabelText(/voucher month/i), '2026-07');
    await userEvent.click(screen.getByTestId('download-voucher-batch'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/vouchers/export?month=2026-07'))).toBe(true),
    );
  });

  it('says the month is empty rather than offering a download of nothing', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/vouchers') && !String(url).includes('/export') ? json([]) : route(String(url)),
    );
    render(<ExportsPage />);
    await waitFor(() => expect(screen.getByTestId('voucher-batch-hint')).toHaveTextContent(/no approved vouchers/i));
    expect(screen.getByTestId('download-voucher-batch')).toBeDisabled();
  });
});
