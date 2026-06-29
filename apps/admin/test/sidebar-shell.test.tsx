import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { AdminShell } from '../src/components/AdminShell';
import { SIDEBAR_STORAGE_KEY } from '../src/components/shell/SidebarContext';

/**
 * App Shell branding + production collapsible sidebar.
 *  - The AutoPlant wordmark matches the legacy reference ("autoplant Systems" + caption).
 *  - The desktop collapse toggle flips state, exposes it via aria + data-collapsed, and persists to
 *    localStorage so the choice survives a reload.
 *  - The mobile drawer opens from the top bar and closes via its own control.
 *  - Existing routing/role nav is untouched (a known link is still rendered and navigable).
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

function renderShell(session: SessionView = zm) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AdminShell />}>
            <Route index element={<div>home</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

const primaryNav = () => screen.getByRole('navigation', { name: /primary/i });

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('App Shell branding', () => {
  it('renders the AutoPlant wordmark identical to the legacy reference', () => {
    renderShell();
    const nav = primaryNav();
    expect(within(nav).getByText('Systems', { exact: false })).toBeInTheDocument();
    expect(within(nav).getByText(/field management system/i)).toBeInTheDocument();
  });

  it('keeps the role-grouped navigation working', () => {
    renderShell();
    const nav = primaryNav();
    // A ZM sees Operations links — proves the existing role nav is intact.
    expect(within(nav).getByRole('link', { name: /tickets/i })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /verification review/i })).toBeInTheDocument();
  });
});

describe('Collapsible sidebar', () => {
  it('toggles collapse state and reflects it on aria + data attributes', async () => {
    const user = userEvent.setup();
    renderShell();
    const nav = primaryNav();
    const toggle = screen.getByRole('button', { name: /collapse sidebar/i });

    expect(nav).toHaveAttribute('data-collapsed', 'false');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);

    expect(nav).toHaveAttribute('data-collapsed', 'true');
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('persists the collapsed choice to localStorage', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('1');
  });

  it('restores the collapsed choice from localStorage on next mount', () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, '1');
    renderShell();
    expect(primaryNav()).toHaveAttribute('data-collapsed', 'true');
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
    // Collapsed items keep their accessible name (visually hidden, still in the a11y tree).
    expect(within(primaryNav()).getByRole('link', { name: /tickets/i })).toBeInTheDocument();
  });

  it('surfaces a label tooltip when a collapsed item is hovered', async () => {
    const user = userEvent.setup();
    localStorage.setItem(SIDEBAR_STORAGE_KEY, '1');
    renderShell();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.hover(within(primaryNav()).getByRole('link', { name: /verification review/i }));
    expect(screen.getByRole('tooltip')).toHaveTextContent(/verification review/i);
  });
});

describe('Mobile drawer', () => {
  it('opens from the top bar and closes via the drawer control', async () => {
    const user = userEvent.setup();
    renderShell();
    const nav = primaryNav();
    expect(nav).toHaveAttribute('data-mobile-open', 'false');

    await user.click(screen.getByRole('button', { name: /open menu/i }));
    expect(nav).toHaveAttribute('data-mobile-open', 'true');

    await user.click(screen.getByRole('button', { name: /close menu/i }));
    expect(nav).toHaveAttribute('data-mobile-open', 'false');
  });
});
