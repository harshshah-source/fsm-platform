import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, EmptyState, Skeleton, type Column } from '../src/components/data';
import { IconTicket } from '../src/components/ui/icons';

/**
 * Shared-primitive coverage for the UI elevation pass: the canonical `DataTable` (+ `EmptyState` /
 * `Skeleton`) states that every re-skinned page now inherits — designed empty, skeleton loading (no
 * layout jump), inline error+retry, sticky header, right-aligned tabular numerics, keyboard row
 * activation, and the reduced-motion contract.
 */
interface Row {
  id: string;
  name: string;
  count: number;
}

const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name },
  { key: 'count', header: 'Count', align: 'right', render: (r) => r.count },
];

const rows: Row[] = [
  { id: 'a', name: 'Alpha', count: 3 },
  { id: 'b', name: 'Beta', count: 7 },
];

function renderTable(props: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) {
  return render(
    <DataTable ariaLabel="Sample" rowKey={(r) => r.id} columns={columns} rows={rows} {...props} />,
  );
}

describe('DataTable shared primitive', () => {
  it('renders skeleton placeholder rows while loading (no data leaks through)', () => {
    const { container } = renderTable({ loading: true, rows: [] });
    // Loading shows shimmer placeholders, not the empty state or rows.
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('renders a designed empty state with icon + action when there are no rows', async () => {
    const onAdd = vi.fn();
    renderTable({
      rows: [],
      empty: (
        <EmptyState
          icon={<IconTicket />}
          message="No tickets match these filters."
          action={
            <button type="button" onClick={onAdd}>
              Clear filters
            </button>
          }
        />
      ),
    });
    expect(screen.getByText('No tickets match these filters.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('renders an inline error state with a working retry', async () => {
    const onRetry = vi.fn();
    renderTable({ error: 'Failed to load', onRetry });
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load');
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('activates a clickable row from the keyboard (Enter) without dropping the row role', async () => {
    const onRowClick = vi.fn();
    renderTable({ onRowClick });
    const bodyRows = screen.getAllByRole('row').slice(1); // still real rows, role preserved
    bodyRows[0].focus();
    expect(bodyRows[0]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });

  it('right-aligns numeric columns with tabular-nums for stable digits', () => {
    renderTable();
    const countCell = screen.getByText('7').closest('td')!;
    expect(countCell.className).toMatch(/tabular-nums/);
    expect(countCell.className).toMatch(/text-right/);
  });

  it('pins the header cells when stickyHeader is set', () => {
    renderTable({ stickyHeader: true });
    const header = within(screen.getByRole('table')).getAllByRole('columnheader')[0];
    expect(header.className).toMatch(/sticky/);
  });

  it('Skeleton uses animate-pulse, which the global reduced-motion rule neutralizes', () => {
    // The actual motion reduction lives in a global @media (prefers-reduced-motion) block that disables
    // animation-duration app-wide; the primitive only needs to opt into that animation class.
    const { container } = render(<Skeleton className="h-4 w-24" />);
    expect(container.firstChild).toHaveClass('animate-pulse');
  });
});
