import type { SessionView } from '@fsm/shared';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { HelpCenterPage } from '../src/pages/help/HelpCenterPage';

/**
 * FE-26 — Help Center (reference 27). Role-scoped grouped topic cards (Your module / Components &
 * Warehouse / Analytics / Admin) with per-topic "View Docs" links, plus a "Model states & terminology"
 * glossary. Static/role-aware content — no backend. Topic visibility uses the same role logic as the
 * nav (managers see Analytics; only the Operations Head sees Admin; Warehouse Manager is scoped to
 * their own module).
 */
const session = (role: string, zone_id: number | null = 1): SessionView =>
  ({ user_id: 'u', role, zone_id, acted_as_role: null }) as SessionView;

function renderHelp(role: string) {
  return render(
    <AuthProvider initialSession={session(role)}>
      <MemoryRouter>
        <HelpCenterPage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

afterEach(() => sessionStorage.clear());

describe('Help Center (FE-26 / ref 27)', () => {
  it('shows a role-scoped "Your module" group, topic docs links, and the glossary for a Zonal Manager', () => {
    renderHelp('ZONAL_MANAGER');
    expect(
      screen.getByRole('heading', { name: /your module .* zonal manager/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /view docs/i }).length).toBeGreaterThan(0);
    expect(
      screen.getByRole('heading', { name: /model states & terminology/i }),
    ).toBeInTheDocument();
    // Managers (non-OH) do not get the Admin group.
    expect(screen.queryByRole('heading', { name: /^admin$/i })).toBeNull();
  });

  it('shows the Analytics and Admin groups to the Operations Head', () => {
    renderHelp('OPERATIONS_HEAD');
    expect(screen.getByRole('heading', { name: /^analytics$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^admin$/i })).toBeInTheDocument();
  });

  it('scopes a Warehouse Manager to their own module without Analytics/Admin', () => {
    renderHelp('WAREHOUSE_MANAGER');
    expect(
      screen.getByRole('heading', { name: /your module .* warehouse manager/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^analytics$/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /^admin$/i })).toBeNull();
  });
});
