import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkUnassignPage } from '../src/pages/admin/BulkUnassignPage';
import { buildNav } from '../src/components/shell/nav';

/**
 * #179 Slice 4 — the OH bulk unassign / mid-day rebalance admin page. Two buttons (Unassign,
 * Run dispatch), a preview modal with per-class counts + typed confirmation, and a history list.
 */
const ZONES = [
  { zoneId: 1, name: 'North', zonalManagerUserId: null },
  { zoneId: 2, name: 'South', zonalManagerUserId: null },
];

const PREVIEW = {
  operationId: 'op-1',
  previewToken: 'tok-1',
  targetDate: '2026-07-29',
  zones: [
    {
      zoneId: '1',
      zoneName: 'North',
      counts: {
        eligible: 3,
        onSite: 2,
        componentBlocked: 1,
        closedExcluded: 4,
        installRecoveryExcluded: 1,
        deferredExcluded: 0,
      },
    },
  ],
};

const EXECUTE_OK = {
  result: 'OK',
  operationId: 'op-1',
  zones: [{ zoneId: '1', zoneName: 'North', skipped: false, skipReason: null, ticketsUnassigned: 6 }],
};

const HISTORY = [
  {
    id: '10',
    operationId: 'op-0',
    actorId: '33333333-3333-3333-3333-333333333333',
    scope: 'ZONE',
    zoneId: '1',
    zoneName: 'North',
    reasonCode: 'ROUTINE_REBALANCE',
    skipped: false,
    skipReason: null,
    counts: { eligible: 2, onSite: 0, componentBlocked: 0, closedExcluded: 0, installRecoveryExcluded: 0, deferredExcluded: 0 },
    ticketsUnassigned: 2,
    createdAt: '2026-07-28T09:00:00.000Z',
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

describe('Bulk Unassign nav gating (#179)', () => {
  const link = (role: string) =>
    buildNav(role)
      .flatMap((g) => g.items)
      .find((i) => i.to === '/bulk-unassign');

  it('shows the nav entry only to the Operations Head', () => {
    expect(link('OPERATIONS_HEAD')).toBeDefined();
    expect(link('ZONAL_MANAGER')).toBeUndefined();
    expect(link('CENTRAL_SERVICE_MANAGER')).toBeUndefined();
    expect(link('SERVICE_ENGINEER')).toBeUndefined();
  });
});

describe('Bulk Unassign page (#179 slice 4)', () => {
  it('shows the "only helps when data changed" copy and loads history on mount', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/org/zones')) return json(ZONES);
      if (url.includes('/bulk-unassign/history')) return json(HISTORY);
      return json({});
    });
    render(<BulkUnassignPage />);
    expect(screen.getByText(/reproduces materially the same plan/i)).toBeInTheDocument();
    const row = await screen.findByTestId('history-10');
    expect(within(row).getByText('North')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
  });

  it('picks a zone, previews, and shows per-class counts including a "waiting on parts" line', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/org/zones')) return json(ZONES);
      if (url.includes('/bulk-unassign/history')) return json(HISTORY);
      if (url.endsWith('/schedules/bulk-unassign') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body.mode === 'PREVIEW') return json(PREVIEW);
      }
      return json({});
    });
    render(<BulkUnassignPage />);
    await userEvent.click(await screen.findByRole('combobox', { name: 'Zone' }));
    await userEvent.click(await screen.findByText('North (#1)'));
    await userEvent.type(screen.getByTestId('reason-input'), 'Bad roster data, redoing the morning run');
    await userEvent.click(screen.getByTestId('open-unassign'));

    await screen.findByRole('dialog');
    expect(await screen.findByText(/3 eligible/i)).toBeInTheDocument();
    expect(screen.getByText(/2 on-site/i)).toBeInTheDocument();
    expect(screen.getByText(/1 waiting on parts/i)).toBeInTheDocument();
  });

  it('blocks confirm until the typed zone name matches, then executes and shows the per-zone result', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/org/zones')) return json(ZONES);
      if (url.includes('/bulk-unassign/history')) return json(HISTORY);
      if (url.endsWith('/schedules/bulk-unassign') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body.mode === 'PREVIEW') return json(PREVIEW);
        if (body.mode === 'EXECUTE') return json(EXECUTE_OK);
      }
      return json({});
    });
    render(<BulkUnassignPage />);
    await userEvent.click(await screen.findByRole('combobox', { name: 'Zone' }));
    await userEvent.click(await screen.findByText('North (#1)'));
    await userEvent.type(screen.getByTestId('reason-input'), 'Bad roster data, redoing the morning run');
    await userEvent.click(screen.getByTestId('open-unassign'));
    await screen.findByRole('dialog');
    await screen.findByTestId('confirm-text'); // preview loaded

    // Wrong confirmation text — blocked, no execute call made.
    await userEvent.type(screen.getByTestId('confirm-text'), 'south');
    await userEvent.click(screen.getByTestId('confirm-unassign'));
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST' && String(i.body).includes('"EXECUTE"'))).toBe(false);

    await userEvent.clear(screen.getByTestId('confirm-text'));
    await userEvent.type(screen.getByTestId('confirm-text'), 'North');
    await userEvent.click(screen.getByTestId('confirm-unassign'));

    const resultRow = await screen.findByTestId('unassign-result-1');
    expect(within(resultRow).getByText(/6/)).toBeInTheDocument();
  });

  it('Run dispatch is a separate button that calls dispatch-run with the selected zone', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/org/zones')) return json(ZONES);
      if (url.includes('/bulk-unassign/history')) return json(HISTORY);
      if (url.endsWith('/schedules/dispatch-run')) return json({ zones: 1, schedules: 2, tickets: 2, errors: [], runId: '9' });
      return json({});
    });
    render(<BulkUnassignPage />);
    await userEvent.click(await screen.findByRole('combobox', { name: 'Zone' }));
    await userEvent.click(await screen.findByText('North (#1)'));
    await userEvent.click(screen.getByTestId('run-dispatch'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (args: unknown[]) => String(args[0]).endsWith('/schedules/dispatch-run') && String((args[1] as RequestInit | undefined)?.body).includes('"zoneId":1'),
        ),
      ).toBe(true),
    );
  });
});
