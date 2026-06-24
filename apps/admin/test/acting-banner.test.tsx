import type { SessionView } from '@fsm/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { AdminShell } from '../src/components/AdminShell';

/**
 * Issue 27 AC#2 — the persistent "Acting as Zonal Manager for [Zone]" banner. A CSM / Operations Head
 * enters acting mode for a zone; the banner shows across the shell and an Exit clears it. A ZM never
 * sees the entry control.
 */
const csm: SessionView = { user_id: 'csm1', role: 'CENTRAL_SERVICE_MANAGER', zone_id: null, acted_as_role: null };
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

function renderShell(session: SessionView) {
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

afterEach(() => sessionStorage.clear());

describe('Acting-as-ZM banner (Issue 27)', () => {
  it('a CSM enters acting mode and sees the persistent banner, then exits', async () => {
    const user = userEvent.setup();
    renderShell(csm);
    expect(screen.queryByText(/acting as zonal manager for zone/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/act as zm for zone/i), '3');
    await user.click(screen.getByRole('button', { name: /^go$/i }));

    expect(screen.getByText(/acting as zonal manager for zone 3/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /exit acting mode/i }));
    expect(screen.queryByText(/acting as zonal manager for zone/i)).not.toBeInTheDocument();
  });

  it('a ZM never sees the acting entry control', () => {
    renderShell(zm);
    expect(screen.queryByLabelText(/act as zm for zone/i)).not.toBeInTheDocument();
  });
});
