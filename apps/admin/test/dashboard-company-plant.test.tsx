import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanyPlantRow } from '../src/api/dashboard';
import { CompanyPlantTable } from '../src/pages/dashboard/CompanyPlantTable';
import { companyPlantRow } from './fixtures/fleet';

// A device-ticket row navigates to `/tickets/:ticketId`, so the table needs a Router in scope.
const renderTable = (rows: CompanyPlantRow[]) =>
  render(
    <MemoryRouter>
      <CompanyPlantTable rows={rows} />
    </MemoryRouter>,
  );

/**
 * Issue 06 slice 6 — Company/Plant Overview with company → plant → device drill-down (AC#3).
 * Companies group their plants; expanding a plant loads its devices from the ticket list. CSV export.
 */
const rows: CompanyPlantRow[] = [
  companyPlantRow({
    companyId: '10',
    companyName: 'Acme Logistics',
    companyTier: 'PLATINUM',
    plantId: '7',
    plantName: 'Yard-1',
    operational: 25,
    inactive: 2,
    byBucket: { CRITICAL: 2 },
  }),
];

function stubTickets(deviceId: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = url.includes('/tickets')
        ? [{ ticketId: 't1', deviceId, slaBucket: 'CRITICAL', status: 'OPEN', plantId: '7' }]
        : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

/** Two companies, neither named or ID'd after the device we'll search for — only the ticket search resolves it. */
const twoCompanyRows: CompanyPlantRow[] = [
  companyPlantRow({
    companyId: '10',
    companyName: 'Acme Logistics',
    companyTier: 'PLATINUM',
    plantId: '7',
    plantName: 'Yard-1',
    operational: 25,
    inactive: 2,
    byBucket: { CRITICAL: 2 },
  }),
  companyPlantRow({
    companyId: '20',
    companyName: 'Globex Freight',
    companyTier: 'SILVER',
    plantId: '9',
    plantName: 'Yard-2',
    operational: 10,
    inactive: 1,
    byBucket: { WARNING: 1 },
  }),
];

/** Stubs `/tickets?q=...` to resolve a device id to Globex's plant (id 9); everything else empty. */
function stubDeviceSearch(deviceId: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const isDeviceQuery = url.includes('/tickets') && url.includes(`q=${deviceId}`);
      const body = isDeviceQuery
        ? [{ ticketId: 't9', deviceId, slaBucket: 'WARNING', status: 'OPEN', plantId: '9' }]
        : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Company/Plant Overview (Issue 06 AC#3 / Issue 122)', () => {
  it('opens collapsed, expands a company to its plants, then drills a plant down to devices', async () => {
    stubTickets('5005');
    renderTable(rows);

    const table = within(screen.getByRole('table', { name: /company\/plant overview/i }));
    // Company is its own row and visible; the plant is hidden until the company is expanded.
    expect(table.getByText('Acme Logistics')).toBeInTheDocument();
    expect(table.getByText('PLATINUM')).toBeInTheDocument();
    expect(table.queryByText('Yard-1')).not.toBeInTheDocument();

    // Expand the company row → the plant appears in its own Plant column.
    await userEvent.click(table.getByText('Acme Logistics'));
    const plantRow = table.getByText('Yard-1').closest('tr')!;
    expect(within(plantRow).getByTestId('bucket-CRITICAL')).toHaveTextContent('2');

    // Drill the plant down to its open device tickets (Issue 135: the whole plant row is the toggle).
    await userEvent.click(plantRow);
    expect(await screen.findByText(/5005/)).toBeInTheDocument();
  });

  /** One batched device ticket at plant 7, with `runId` as given (null = pre-ledger / ZM_MANUAL). */
  const stubBatchedTicket = (runId: string | null) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        const body = url.includes('/tickets')
          ? [
              {
                ticketId: 't1',
                deviceId: '5005',
                slaBucket: 'CRITICAL',
                status: 'OPEN',
                plantId: '7',
                assignmentState: 'FORMALLY_ASSIGNED',
                batchId: '55',
                runId,
              },
            ]
          : [];
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );

  const openDeviceTickets = async () => {
    const table = within(screen.getByRole('table', { name: /company\/plant overview/i }));
    await userEvent.click(table.getByText('Acme Logistics'));
    const plantRow = table.getByText('Yard-1').closest('tr')!;
    // Issue 135: the plant row itself opens the device sub-table (the "View devices" button is gone).
    await userEvent.click(plantRow);
  };

  it('links an assigned device ticket to the batch it belongs to', async () => {
    stubBatchedTicket('9');
    renderTable(rows);
    await openDeviceTickets();

    const link = await screen.findByRole('link', { name: /Batch #55/i });
    expect(link).toHaveAttribute('href', '/batches/55');
  });

  it('still links a batch whose schedule has no dispatch run (ZM_MANUAL / pre-ledger)', async () => {
    // `work_schedules.run_id` is null for ZM_MANUAL and pre-ledger schedules — the majority of live
    // batched tickets. A batch is addressed by its own id, so the link must not depend on the run.
    stubBatchedTicket(null);
    renderTable(rows);
    await openDeviceTickets();

    const link = await screen.findByRole('link', { name: /Batch #55/i });
    expect(link).toHaveAttribute('href', '/batches/55');
  });

  it('offers a table-level download control and an assignment-state filter (Issue 160)', async () => {
    stubTickets('5005');
    renderTable(rows);
    const trigger = screen.getByRole('button', { name: 'Download Company/Plant Overview' });
    expect(trigger).toBeInTheDocument();
    await userEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'CSV' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Excel' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'PDF' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Image (PNG)' })).toBeInTheDocument();
    expect(screen.getByLabelText(/assignment state/i)).toBeInTheDocument();
  });

  it('searches within the Plants sub-table, independently of the parent search', async () => {
    // Every level of the drill-down carries its own search: the parent's narrows the whole tree,
    // this one narrows the panel an operator already has open, without collapsing it.
    stubTickets('5005');
    renderTable([
      companyPlantRow({ companyId: '10', companyName: 'Acme Logistics', plantId: '7', plantName: 'Yard-1', operational: 25 }),
      companyPlantRow({ companyId: '10', companyName: 'Acme Logistics', plantId: '8', plantName: 'Dock-2', operational: 5 }),
    ]);

    const overview = within(screen.getByRole('table', { name: /company\/plant overview/i }));
    await userEvent.click(overview.getByText('Acme Logistics'));
    const plants = within(screen.getByRole('table', { name: /plants for acme logistics/i }));
    expect(plants.getByText('Yard-1')).toBeInTheDocument();
    expect(plants.getByText('Dock-2')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/search plants of acme logistics/i), 'dock');
    expect(plants.getByText('Dock-2')).toBeInTheDocument();
    expect(plants.queryByText('Yard-1')).not.toBeInTheDocument();
    // The sub-table re-numbers what survives, so S.No. still reads 1..n rather than leaving a gap.
    expect(plants.getByText('Dock-2').closest('tr')!.querySelector('td')).toHaveTextContent('1');
  });

  it('searches the Open device tickets sub-sub-table across every column it shows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        const body = url.includes('/tickets')
          ? [
              { ticketId: 't1', deviceId: '5005', vehicleNo: 'MH12AB1111', slaBucket: 'CRITICAL', status: 'OPEN', plantId: '7' },
              { ticketId: 't2', deviceId: '6006', vehicleNo: 'GJ01ZZ9999', slaBucket: 'WARNING', status: 'OPEN', plantId: '7' },
            ]
          : [];
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    renderTable(rows);
    await openDeviceTickets();
    expect(await screen.findByText('5005')).toBeInTheDocument();
    expect(screen.getByText('6006')).toBeInTheDocument();

    // A vehicle number is not the device id, so this only works if the search spans the row's columns.
    await userEvent.type(screen.getByLabelText(/search open device tickets/i), 'gj01');
    expect(screen.getByText('6006')).toBeInTheDocument();
    expect(screen.queryByText('5005')).not.toBeInTheDocument();
  });

  it('resolves a device id search to its plant via the universal ticket search (bug fix)', async () => {
    // `CompanyPlantRow` carries no device/vehicle identity — searching "9988" can't match by
    // company/plant name or id. The placeholder promises device/vehicle search anyway, so it must
    // fall back to the same `/tickets?q=` universal search the drill-down already uses.
    stubDeviceSearch('9988');
    renderTable(twoCompanyRows);

    const table = within(screen.getByRole('table', { name: /company\/plant overview/i }));
    expect(table.getByText('Acme Logistics')).toBeInTheDocument();
    expect(table.getByText('Globex Freight')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/search company, plant or id/i), '9988');

    // Only Globex (which owns plant 9, the ticket's plant) should remain, auto-expanded to reveal
    // the matched plant — not left collapsed as if nothing were found. Wait on the plant itself: its
    // appearance only follows the debounced `/tickets?q=` lookup resolving, unlike Acme's disappearance
    // (which is immediate either way and would make the assertion pass before the lookup completes).
    expect(await table.findByText('Yard-2')).toBeInTheDocument();
    // Globex now appears on its company row AND (Issue 135) on its expanded plant row's Company cell.
    expect(table.getAllByText('Globex Freight').length).toBeGreaterThan(0);
    expect(table.queryByText('Acme Logistics')).not.toBeInTheDocument();
  });
});
