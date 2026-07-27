import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DataTable, type Column } from '../src/components/data';

/**
 * Per-table download (Issue 160, Edit 2) — one button per `DataTable`, table-level export of the
 * on-screen (post-filter/post-sort) view via a DOM read. Mirrors the DataTable shared-primitive
 * fixture from datatable.test.tsx.
 */
interface Row {
  id: string;
  name: string;
  count: number;
}

const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name },
  { key: 'count', header: 'Count', align: 'right', sortable: true, sortValue: (r) => r.count, render: (r) => r.count },
];

const rows: Row[] = [
  { id: 'a', name: 'Alpha', count: 3 },
  { id: 'b', name: 'Beta', count: 7 },
];

vi.mock('../src/lib/exportFile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/exportFile')>();
  return { ...actual, exportTable: vi.fn() };
});
import { exportTable } from '../src/lib/exportFile';
const exportTableMock = vi.mocked(exportTable);

function renderTable(props: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) {
  return render(
    <DataTable ariaLabel="Sample" rowKey={(r) => r.id} columns={columns} rows={rows} {...props} />,
  );
}

beforeEach(() => {
  exportTableMock.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TableDownloadButton', () => {
  it('renders exactly one download control, disambiguated by aria-label', () => {
    renderTable();
    expect(screen.getByRole('button', { name: 'Download Sample' })).toBeInTheDocument();
  });

  it('exports CSV with S.No. included and column order pinned', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole('button', { name: 'Download Sample' }));
    await user.click(screen.getByRole('menuitem', { name: 'CSV' }));

    expect(exportTableMock).toHaveBeenCalledWith(
      'csv',
      'sample',
      'Sample',
      ['S.No.', 'Name', 'Count'],
      [
        ['1', 'Alpha', '3'],
        ['2', 'Beta', '7'],
      ],
    );
  });

  it('exports the post-sort view, not the original row order', async () => {
    const user = userEvent.setup();
    renderTable();
    const countHeader = screen.getByRole('columnheader', { name: /count/i });
    await user.click(countHeader); // asc
    await user.click(countHeader); // desc: Beta(7) first

    await user.click(screen.getByRole('button', { name: 'Download Sample' }));
    await user.click(screen.getByRole('menuitem', { name: 'CSV' }));

    expect(exportTableMock).toHaveBeenCalledWith(
      'csv',
      'sample',
      'Sample',
      ['S.No.', 'Name', 'Count'],
      [
        ['1', 'Beta', '7'],
        ['2', 'Alpha', '3'],
      ],
    );
  });

  it('excludes the expansion panel row from the export', async () => {
    const user = userEvent.setup();
    renderTable({ renderExpanded: (r) => <div>Detail for {r.name}</div> });
    await user.click(screen.getByText('Alpha').closest('tr')!);
    expect(screen.getByText('Detail for Alpha')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Download Sample' }));
    await user.click(screen.getByRole('menuitem', { name: 'CSV' }));

    const [, , , , exportedRows] = exportTableMock.mock.calls[0];
    expect((exportedRows as string[][]).flat()).not.toContain('Detail for Alpha');
  });

  it('omits a column marked exportable: false from headers and every row', async () => {
    const user = userEvent.setup();
    renderTable({
      columns: [...columns, { key: 'actions', header: 'Actions', exportable: false, render: () => 'Edit' }],
    });
    await user.click(screen.getByRole('button', { name: 'Download Sample' }));
    await user.click(screen.getByRole('menuitem', { name: 'CSV' }));

    const [, , , headers, exportedRows] = exportTableMock.mock.calls[0];
    expect(headers).toEqual(['S.No.', 'Name', 'Count']);
    expect((exportedRows as string[][]).flat()).not.toContain('Edit');
  });

  it('disables the button while loading, on error, and with zero rows', () => {
    const { rerender } = renderTable({ loading: true });
    expect(screen.getByRole('button', { name: 'Download Sample' })).toBeDisabled();

    rerender(<DataTable ariaLabel="Sample" rowKey={(r) => r.id} columns={columns} rows={rows} error="Failed" />);
    expect(screen.getByRole('button', { name: 'Download Sample' })).toBeDisabled();

    rerender(<DataTable ariaLabel="Sample" rowKey={(r) => r.id} columns={columns} rows={[]} />);
    expect(screen.getByRole('button', { name: 'Download Sample' })).toBeDisabled();
  });

  it('issues zero network requests during export (AC-16 zone-scoping proof)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole('button', { name: 'Download Sample' }));
    await user.click(screen.getByRole('menuitem', { name: 'CSV' }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('gives each of several tables on one page its own addressable button', () => {
    render(
      <>
        <DataTable ariaLabel="First" rowKey={(r) => r.id} columns={columns} rows={rows} />
        <DataTable ariaLabel="Second" rowKey={(r) => r.id} columns={columns} rows={rows} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Download First' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Second' })).toBeInTheDocument();
  });

  it('does not render a download control when downloadable is false', () => {
    renderTable({ downloadable: false });
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull();
  });
});
