import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../src/AppRoutes';
import { AuthProvider } from '../src/auth/AuthProvider';

/**
 * #281 AC11 / audit §2.5 D3 — a mistyped or retired admin URL used to match no route at all, so the
 * pathless shell layout never rendered: no sidebar, no breadcrumb, no message, and no way back except
 * the browser's Back button. The catch-all renders **inside** the shell, which is the part that
 * matters — the operator keeps the navigation they would need to recover.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

function renderAt(path: string) {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('#281 AC11 — unknown admin URLs', () => {
  it('renders the shell with a not-found message and a way back, not a blank page', () => {
    renderAt('/schedules/preview/typo-that-never-existed');

    // The shell is present — this is the difference between "lost" and "stranded".
    expect(screen.getByRole('navigation', { name: /primary/i })).toBeInTheDocument();
    // Scoped to the message itself — the sidebar has its own Dashboard link, and the point of this
    // assertion is that the *page* offers the way back, not that the shell happens to have one.
    const notFound = within(screen.getByTestId('not-found'));
    expect(notFound.getByRole('link', { name: /back to the dashboard/i })).toHaveAttribute('href', '/');
  });

  it('echoes the path that did not resolve, so the operator can see the typo', () => {
    renderAt('/dispatch-runsss');
    expect(screen.getByTestId('not-found').textContent).toContain('/dispatch-runsss');
  });

  it('does not swallow a real route', () => {
    renderAt('/dispatch-runs');
    expect(screen.queryByTestId('not-found')).toBeNull();
  });
});
