import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { resolveBreadcrumb } from '../src/components/shell/breadcrumb';
import { SidebarProvider } from '../src/components/shell/SidebarContext';
import { ThemeProvider } from '../src/components/shell/ThemeContext';
import { TopBar } from '../src/components/shell/TopBar';

const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

function renderTopBar(path: string, session: SessionView = zm) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter initialEntries={[path]}>
        {/* The top bar hosts the theme toggle, so it needs the theme context as well as the sidebar's
            — same two providers <AppShell> wraps it in. */}
        <ThemeProvider>
          <SidebarProvider>
            <TopBar />
          </SidebarProvider>
        </ThemeProvider>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('resolveBreadcrumb', () => {
  it('/ resolves to a single terminal Dashboard crumb, no link', () => {
    expect(resolveBreadcrumb('/', 'ZONAL_MANAGER')).toEqual([{ label: 'Dashboard' }]);
  });

  it('a route that is itself a nav item resolves to Dashboard + its own label', () => {
    expect(resolveBreadcrumb('/reports/device', 'OPERATIONS_HEAD')).toEqual([
      { label: 'Dashboard', to: '/' },
      { label: 'Device Detail' },
    ]);
  });

  it('a detail route beyond a nav item resolves a three-crumb chain', () => {
    expect(resolveBreadcrumb('/tickets/T-1', 'ZONAL_MANAGER')).toEqual([
      { label: 'Dashboard', to: '/' },
      { label: 'Tickets', to: '/tickets' },
      { label: 'Ticket #T-1' },
    ]);
  });

  it('pins the longest-prefix nav match over a shorter one', () => {
    expect(resolveBreadcrumb('/engineers/manage', 'ZONAL_MANAGER')).toEqual([
      { label: 'Dashboard', to: '/' },
      { label: 'Manage SEs' },
    ]);
  });

  /**
   * #281 AC9 / audit §2.5 D1 — `/schedules/preview` is a LITERAL route sitting under the
   * `/schedules/:engineerId` param route. `AppRoutes.tsx` guards that ordering explicitly, with a
   * comment saying so; this resolver did not, so a screen whose whole job is being a projection
   * announced itself as `Schedules › Schedule Detail` — the committed plan for an engineer named
   * "preview". The guard is general, not a special case for this one path, so the next literal
   * added under a param route cannot regress silently.
   */
  it('resolves /schedules/preview to its own crumb, not Schedule Detail (D1)', () => {
    expect(resolveBreadcrumb('/schedules/preview', 'ZONAL_MANAGER')).toEqual([
      { label: 'Dashboard', to: '/' },
      { label: 'Scheduler Preview' },
    ]);
  });

  it('still resolves a real engineer id under /schedules to the detail crumb', () => {
    expect(resolveBreadcrumb('/schedules/se-uuid-1', 'ZONAL_MANAGER')).toEqual([
      { label: 'Dashboard', to: '/' },
      { label: 'Schedules', to: '/schedules' },
      { label: 'Schedule Detail' },
    ]);
  });

  it('prefers the literal nav route over any param pattern that would also match it', () => {
    // One case per literal-under-param nav route in the shell. A new literal added beneath an
    // existing `:param` route belongs in this list — that is what stops the D1 class of defect
    // from coming back on a different path.
    const LITERALS_UNDER_PARAM_ROUTES: [string, string][] = [['/schedules/preview', 'Scheduler Preview']];
    for (const [path, label] of LITERALS_UNDER_PARAM_ROUTES) {
      expect(resolveBreadcrumb(path, 'OPERATIONS_HEAD')).toEqual([
        { label: 'Dashboard', to: '/' },
        { label },
      ]);
    }
  });

  it('falls back to Console for an unmatched in-shell path', () => {
    expect(resolveBreadcrumb('/nonexistent', 'ZONAL_MANAGER')).toEqual([
      { label: 'Dashboard', to: '/' },
      { label: 'Console' },
    ]);
  });
});

describe('TopBar breadcrumb', () => {
  it('renders a linked ancestor crumb and a current-page terminal crumb', () => {
    renderTopBar('/tickets/T-1');
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Tickets' })).toHaveAttribute('href', '/tickets');
    expect(within(nav).getByText('Ticket #T-1')).toHaveAttribute('aria-current', 'page');
  });

  it('never renders the retired console string', () => {
    renderTopBar('/tickets/T-1');
    expect(screen.queryByText(/FSM Command Console/)).toBeNull();
  });
});
