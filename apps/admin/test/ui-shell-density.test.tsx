import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { DataTable } from '../src/components/data/DataTable';
import { FilterSelect } from '../src/components/data/FilterBar';
import { PageHeader } from '../src/components/data/PageHeader';
import { SidebarProvider } from '../src/components/shell/SidebarContext';
import { ThemeProvider, THEME_STORAGE_KEY } from '../src/components/shell/ThemeContext';
import { TopBar } from '../src/components/shell/TopBar';

/**
 * The 2026-07-28 density + theming pass:
 *  1. the boxed per-page title card is gone from view, but the page keeps a heading for AT;
 *  2. a table's own filters live inside the table's card, not in a separate panel above it;
 *  3. the top bar carries a light/dark switch that drives `data-theme` and persists the choice.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('PageHeader — the title card is visually gone', () => {
  it('keeps the title as a heading but renders no visible card around it', () => {
    const { container } = render(<PageHeader title="Ticket Operations" subtitle="Every open ticket." />);

    // Still a heading, so the page is not left anonymous to a screen reader.
    const heading = screen.getByRole('heading', { name: /ticket operations/i });
    expect(heading).toBeInTheDocument();
    // …but screen-reader-only, and carrying none of the card's chrome.
    expect(heading.closest('.sr-only')).not.toBeNull();
    expect(container.querySelector('.shadow-card')).toBeNull();
    expect(container.querySelector('.border-line')).toBeNull();
  });

  it('still renders actions, with no card around them', () => {
    render(<PageHeader title="Settings" actions={<button type="button">Save</button>} />);

    const action = screen.getByRole('button', { name: /save/i });
    expect(action).toBeInTheDocument();
    // The actions row is not inside the sr-only block — it stays visible.
    expect(action.closest('.sr-only')).toBeNull();
  });
});

describe('DataTable — filters ride inside the table card', () => {
  const rows = [{ id: 'a', name: 'Alpha' }];

  it('renders the toolbar controls in the same card as the table, above it', () => {
    const { container } = render(
      <DataTable
        ariaLabel="Widgets"
        rows={rows}
        rowKey={(r) => r.id}
        columns={[{ key: 'name', header: 'Name', render: (r) => r.name }]}
        toolbarTitle="Widgets"
        toolbar={
          <FilterSelect aria-label="Filter by plant">
            <option value="">All plants</option>
          </FilterSelect>
        }
      />,
    );

    const card = container.firstElementChild as HTMLElement;
    const filter = screen.getByLabelText(/filter by plant/i);
    const table = screen.getByRole('table', { name: /widgets/i });

    // One card holds both — the filter is not in a panel of its own.
    expect(card.contains(filter)).toBe(true);
    expect(card.contains(table)).toBe(true);
    // …and the filter precedes the table in document order.
    expect(filter.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The download button shares that one strip rather than claiming a second row.
    const strip = filter.closest('div')?.parentElement?.parentElement as HTMLElement;
    expect(within(strip).getByRole('button', { name: /download/i })).toBeInTheDocument();
  });
});

describe('Theme toggle', () => {
  function renderTopBar() {
    return render(
      <AuthProvider initialSession={zm}>
        <MemoryRouter initialEntries={['/']}>
          <ThemeProvider>
            <SidebarProvider>
              <TopBar />
            </SidebarProvider>
          </ThemeProvider>
        </MemoryRouter>
      </AuthProvider>,
    );
  }

  it('flips <html data-theme> and persists the choice', async () => {
    const user = userEvent.setup();
    renderTopBar();

    // jsdom reports no `prefers-color-scheme: dark`, so the unset preference resolves to light.
    const toggle = screen.getByRole('switch', { name: /switch to dark mode/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByRole('switch', { name: /switch to light mode/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('restores a persisted dark preference on mount', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    renderTopBar();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByRole('switch', { name: /switch to light mode/i })).toHaveAttribute('aria-checked', 'true');
  });
});
