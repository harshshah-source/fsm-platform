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

describe('Exports page (Issue 120)', () => {
  it('renders the entity-mapping card with the row-count/freshness hint', async () => {
    fetchMock.mockImplementation(async () => json({ rowCount: 18942, dataAsOf: '2026-07-14T04:00:00.000Z' }));
    render(<ExportsPage />);
    expect(screen.getByText('Entity mapping (CSV)')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('entity-mapping-hint')).toHaveTextContent('18,942 devices'),
    );
  });

  it('downloads the CSV via an auth-fetch of the export endpoint', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/summary') ? json({ rowCount: 1, dataAsOf: null }) : csv('device_id\n123\n'),
    );
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
