import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpsExplorerPage } from '../src/pages/ops-explorer/OpsExplorerPage';
import { resetOpsExplorerMetaCache } from '../src/pages/ops-explorer/useOpsExplorerMeta';
import { buildNav } from '../src/components/shell/nav';
import { resolveBreadcrumb } from '../src/components/shell/breadcrumb';

/**
 * #217 — the Operations Data Explorer's admin surface.
 *
 * The through-line of these tests is that **the two gates and the developer-mode strip are server
 * facts, and the client only ever reflects them**. So the fixtures below vary the server's response
 * (404 / role error / developerMode true|false) rather than any client flag, and each test asserts the
 * page's reaction — which is the actual contract.
 */

const meta = (developerMode: boolean) => ({
  enabled: true,
  developerMode,
  roles: ['OPERATIONS_HEAD'],
  datasets: [
    {
      key: 'devices',
      name: 'Devices & device state',
      description: 'Every device FSM mirrors.',
      grain: 'One row per device_id.',
      searchColumns: ['deviceId'],
      defaultSort: { column: 'inactivityHours', direction: 'desc' },
      ...(developerMode ? { from: 'devices d LEFT JOIN device_states ds ON ds.device_id = d.device_id' } : {}),
      columns: [
        {
          key: 'deviceId',
          label: 'Device ID',
          type: 'string',
          filterable: true,
          sortable: true,
          defaultVisible: true,
          drilldown: { label: 'Device detail', route: '/reports/device?deviceId=:value' },
          lineage: {
            definition: 'The AutoPlant business identifier for the GPS unit.',
            system: 'AUTOPLANT_MYSQL',
            table: 'devices (mirrored)',
            refreshTrigger: 'Daily master sync.',
            ...(developerMode
              ? { developer: { column: 'devices.device_id', expression: 'd.device_id' } }
              : {}),
          },
        },
        {
          key: 'slaBucket',
          label: 'SLA bucket',
          type: 'enum',
          enumValues: ['CRITICAL', 'SEVERE'],
          filterable: true,
          sortable: true,
          defaultVisible: true,
          lineage: {
            definition: 'Stored severity band derived from inactivity hours.',
            system: 'DERIVED',
            table: 'device_states',
            refreshTrigger: '30-minute recompute.',
            excludes: ['Departed devices are neither healthy nor inactive'],
            ...(developerMode
              ? {
                  developer: {
                    column: 'device_states.sla_bucket',
                    expression: 'ds.sla_bucket::text',
                    formula: 'SQL CASE from SLA_BANDS',
                  },
                }
              : {}),
          },
        },
      ],
    },
  ],
});

const page = (developerMode: boolean) => ({
  dataset: { key: 'devices', name: 'Devices & device state' },
  columns: [
    { key: 'deviceId', label: 'Device ID', type: 'string' },
    { key: 'slaBucket', label: 'SLA bucket', type: 'enum' },
  ],
  rows: [
    { deviceId: '0086412', slaBucket: 'CRITICAL' },
    { deviceId: '0086413', slaBucket: null },
  ],
  page: 1,
  pageSize: 50,
  totalRows: 2,
  totalPages: 1,
  ...(developerMode
    ? {
        diagnostics: {
          rowsSql: 'SELECT d.device_id AS "deviceId" FROM devices d LIMIT $1 OFFSET $2',
          countSql: 'SELECT COUNT(*)::int AS "count" FROM devices d',
          params: [50, 0],
          rowsQueryMs: 12,
          countQueryMs: 3,
          endpoint: 'POST /api/ops-explorer/datasets/devices/query',
        },
      }
    : {}),
});

const reconciliation = {
  checkedAt: '2026-08-06T09:00:00.000Z',
  status: 'FAIL',
  durationMs: 41,
  identities: [
    {
      key: 'zoneRollup',
      name: 'Zone roll-up matches the fleet KPI strip',
      statement: 'Σ zone.operationalDevices = fleet.operationalDevices',
      status: 'FAIL',
      left: { label: 'Σ zones', value: 17_403, measuredBy: '5 rows grouped by plants.zone_id' },
      right: { label: 'Fleet KPI strip', value: 17_415, measuredBy: 'one ungrouped aggregate' },
      difference: -12,
      likelySources: ['A device_states row whose plant_id points at a plant that no longer exists.'],
    },
    {
      key: 'mirroredPartition',
      name: 'Operational + warehouse partitions the mirrored fleet',
      statement: 'operationalDevices + warehouseDevices = mirroredDevices',
      status: 'PASS',
      left: { label: 'Operational + warehouse', value: 23_238, measuredBy: 'two FILTER clauses' },
      right: { label: 'Mirrored', value: 23_238, measuredBy: 'unfiltered COUNT(*)' },
      difference: 0,
      likelySources: [],
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();

/** Route the mock by URL so the page's three concurrent calls each get the right body. */
function routeFetch(developerMode: boolean) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/ops-explorer/meta')) return Promise.resolve(json(meta(developerMode)));
    if (url.includes('/query')) return Promise.resolve(json(page(developerMode)));
    if (url.includes('/reconciliation')) return Promise.resolve(json(reconciliation));
    if (url.includes('/export')) {
      return Promise.resolve(
        new Response('Device ID,SLA bucket\n0086412,CRITICAL\n', {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="ops-explorer-devices-2026-08-06.csv"',
          },
        }),
      );
    }
    return Promise.resolve(json({ message: 'unexpected' }, 500));
  });
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <OpsExplorerPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  resetOpsExplorerMetaCache();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  resetOpsExplorerMetaCache();
  sessionStorage.clear();
});

describe('nav + breadcrumb gating (AC-12)', () => {
  const link = (role: string, opsExplorer: boolean) =>
    buildNav(role, { opsExplorer })
      .flatMap((g) => g.items)
      .find((i) => i.to === '/ops-explorer');

  it('shows the link only to the Operations Head, and only when the feature is enabled', () => {
    expect(link('OPERATIONS_HEAD', true)).toBeDefined();
    expect(link('OPERATIONS_HEAD', false)).toBeUndefined();
    for (const role of ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'SERVICE_ENGINEER', 'WAREHOUSE_MANAGER']) {
      expect(link(role, true), role).toBeUndefined();
    }
  });

  it('defaults to hidden when no feature flags are passed at all', () => {
    expect(
      buildNav('OPERATIONS_HEAD')
        .flatMap((g) => g.items)
        .find((i) => i.to === '/ops-explorer'),
    ).toBeUndefined();
  });

  it('still names the page in the breadcrumb — the flag gates the link, not the label', () => {
    const crumbs = resolveBreadcrumb('/ops-explorer', 'OPERATIONS_HEAD');
    expect(crumbs.at(-1)?.label).toBe('Data Explorer');
  });
});

describe('feature-flag states (AC-1/AC-2)', () => {
  it('explains itself rather than erroring when the backend 404s the feature', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    renderPage();
    expect(await screen.findByText(/not enabled on this environment/i)).toBeInTheDocument();
    expect(screen.getByText(/OPS_EXPLORER_ENABLED/)).toBeInTheDocument();
  });

  it('reports a role refusal distinctly from a disabled feature', async () => {
    fetchMock.mockResolvedValue(json({ message: 'Forbidden' }, 403));
    renderPage();
    expect(await screen.findByText(/restricted to Operations Head/i)).toBeInTheDocument();
  });
});

describe('operational mode', () => {
  beforeEach(() => routeFetch(false));

  it('renders the rows with a read-only badge and no developer badge', async () => {
    renderPage();
    expect(await screen.findByText('0086412')).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.queryByText('Developer mode')).not.toBeInTheDocument();
  });

  it('shows no diagnostics panel when the server sent none', async () => {
    renderPage();
    await screen.findByText('0086412');
    expect(screen.queryByTestId('ops-explorer-diagnostics')).not.toBeInTheDocument();
  });

  it('renders a null cell as an em-dash so "this is blank" is a visible finding', async () => {
    renderPage();
    await screen.findByText('0086413');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('links a drill-down column to the existing device page', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: '0086412' });
    expect(link).toHaveAttribute('href', '/reports/device?deviceId=0086412');
  });

  it('uses the hidden __dd_<key> row field for the link target when the display value differs (S2 fix)', async () => {
    // The bug this pins: a "Plant" column DISPLAYS the plant's NAME but its route needs the plant's
    // ID. The server never sends the difference in metadata (drilldown carries only label/route — the
    // SQL that produced the id is stripped even in Developer Mode); it rides on each ROW as a hidden
    // `__dd_plantName` field instead. If renderCell regresses to using the cell's own displayed value,
    // this test fails with the plant's NAME baked into the href instead of its id.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/ops-explorer/meta')) {
        return Promise.resolve(
          json({
            enabled: true,
            developerMode: false,
            roles: ['OPERATIONS_HEAD'],
            datasets: [
              {
                key: 'plants',
                name: 'Plants',
                description: 'Sites.',
                grain: 'One row per plant_id.',
                searchColumns: ['name'],
                defaultSort: { column: 'name', direction: 'asc' },
                columns: [
                  {
                    key: 'name',
                    label: 'Plant',
                    type: 'string',
                    filterable: true,
                    sortable: true,
                    defaultVisible: true,
                    drilldown: { label: 'Plant devices', route: '/reports/device?plantId=:value' },
                    lineage: { definition: 'x', system: 'FSM_POSTGRES', table: 'plants', refreshTrigger: 'x' },
                  },
                ],
              },
            ],
          }),
        );
      }
      if (url.includes('/query')) {
        return Promise.resolve(
          json({
            dataset: { key: 'plants', name: 'Plants' },
            columns: [{ key: 'name', label: 'Plant', type: 'string' }],
            // The row carries BOTH: the displayed name, and the hidden id the link must actually use.
            rows: [{ name: 'North Depot', __dd_name: '42' }],
            page: 1,
            pageSize: 50,
            totalRows: 1,
            totalPages: 1,
          }),
        );
      }
      if (url.includes('/reconciliation')) return Promise.resolve(json(reconciliation));
      return Promise.resolve(json({ message: 'unexpected' }, 500));
    });

    renderPage();
    const link = await screen.findByRole('link', { name: 'North Depot' });
    expect(link).toHaveAttribute('href', '/reports/device?plantId=42');
  });

  it('shows operational lineage in the column source popover, without SQL', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('0086412');
    await user.click(screen.getByTestId('ops-explorer-source-slaBucket'));
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText(/Stored severity band/)).toBeInTheDocument();
    expect(within(tip).getByText('device_states')).toBeInTheDocument();
    expect(within(tip).getByText(/Departed devices are neither/)).toBeInTheDocument();
    expect(within(tip).queryByText('ds.sla_bucket::text')).not.toBeInTheDocument();
    expect(within(tip).queryByText(/Developer mode/)).not.toBeInTheDocument();
  });
});

describe('developer mode (AC-13)', () => {
  beforeEach(() => routeFetch(true));

  it('shows the badge, the SQL, the timings and the bound parameters separately', async () => {
    renderPage();
    await screen.findByText('0086412');
    expect(screen.getByText('Developer mode')).toBeInTheDocument();

    const panel = await screen.findByTestId('ops-explorer-diagnostics');
    expect(within(panel).getByText(/SELECT d\.device_id/)).toBeInTheDocument();
    expect(within(panel).getByText('POST /api/ops-explorer/datasets/devices/query')).toBeInTheDocument();
    expect(within(panel).getByText('12 ms')).toBeInTheDocument();
    // The parameters are listed on their own, never substituted into the statement above.
    expect(within(panel).getByText(/SELECT d\.device_id/).textContent).toContain('$1');
    expect(within(panel).getByText(/\[\s*50,\s*0\s*\]/)).toBeInTheDocument();
  });

  it('adds the expression and formula to the column source popover', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('0086412');
    await user.click(screen.getByTestId('ops-explorer-source-slaBucket'));
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('ds.sla_bucket::text')).toBeInTheDocument();
    expect(within(tip).getByText('SQL CASE from SLA_BANDS')).toBeInTheDocument();
  });
});

describe('querying (AC-7)', () => {
  beforeEach(() => routeFetch(false));

  it('does not re-query on every keystroke — the search is applied explicitly', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('0086412');
    const queriesBefore = fetchMock.mock.calls.filter(([u]) => String(u).includes('/query')).length;

    await user.type(screen.getByTestId('ops-explorer-search'), 'abc');
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/query')).length).toBe(queriesBefore);

    await user.click(screen.getByTestId('ops-explorer-apply'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/query')).length).toBe(queriesBefore + 1),
    );
    const body = JSON.parse(
      String(fetchMock.mock.calls.filter(([u]) => String(u).includes('/query')).at(-1)?.[1]?.body),
    );
    expect(body.search).toBe('abc');
  });

  it('sends a filter row built in the UI', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('0086412');

    await user.click(screen.getByTestId('ops-explorer-add-filter'));
    await user.selectOptions(screen.getByLabelText('Filter 1 column'), 'slaBucket');
    await user.selectOptions(screen.getByLabelText('Filter 1 value'), 'CRITICAL');
    await user.click(screen.getByTestId('ops-explorer-apply'));

    await waitFor(() => {
      const body = JSON.parse(
        String(fetchMock.mock.calls.filter(([u]) => String(u).includes('/query')).at(-1)?.[1]?.body),
      );
      expect(body.filters).toEqual([{ column: 'slaBucket', operator: 'eq', value: 'CRITICAL' }]);
    });
  });
});

describe('server-side export (AC-9)', () => {
  beforeEach(() => routeFetch(false));

  it('posts the applied query with pagination stripped, so the download is the whole result', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('0086412');

    await user.click(screen.getByTestId('ops-explorer-export'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/export'));
      expect(call).toBeDefined();
      const body = JSON.parse(String(call?.[1]?.body));
      expect(body.page).toBeUndefined();
      expect(body.pageSize).toBeUndefined();
      expect(body.columns).toEqual(['deviceId', 'slaBucket']);
    });
  });
});

describe('reconciliation panel (AC-10/AC-11)', () => {
  beforeEach(() => routeFetch(false));

  it('shows both sides, how each was measured, and the signed difference on a mismatch', async () => {
    renderPage();
    const panel = await screen.findByTestId('reconciliation-zoneRollup');
    expect(within(panel).getByText('17,403')).toBeInTheDocument();
    expect(within(panel).getByText('17,415')).toBeInTheDocument();
    expect(within(panel).getByText(/measured by 5 rows grouped by plants\.zone_id/)).toBeInTheDocument();
    expect(within(panel).getByText(/Difference: -12 rows/)).toBeInTheDocument();
    expect(within(panel).getByText(/plant that no longer exists/)).toBeInTheDocument();
  });

  it('tells no story for a passing identity, but still shows its evidence', async () => {
    renderPage();
    const panel = await screen.findByTestId('reconciliation-mirroredPartition');
    expect(within(panel).getByText('PASS')).toBeInTheDocument();
    expect(within(panel).getByText(/measured by unfiltered COUNT/)).toBeInTheDocument();
    expect(within(panel).queryByText(/Difference:/)).not.toBeInTheDocument();
  });

  it('summarises the overall verdict', async () => {
    renderPage();
    expect(await screen.findByText('Mismatch detected')).toBeInTheDocument();
    expect(screen.getByText('1/2 passing')).toBeInTheDocument();
  });
});
