import type { SessionView } from '@fsm/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { AdminShell } from '../src/components/AdminShell';

/**
 * The top-bar global search. It was inert — a bare `<input>` with no state, no handler and no target,
 * so every term typed into it disappeared on Enter. It now submits to the Device Detail list, the one
 * read that indexes the placeholder's nouns (device id / vehicle no / plant / company).
 */
const opsHead: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const warehouse: SessionView = { user_id: 'wm1', role: 'WAREHOUSE_MANAGER', zone_id: null, acted_as_role: null };

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
}

/** Stands in for the Device Detail page so the assertion is on what the search actually navigates to. */
function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{`${pathname}${search}`}</div>;
}

function renderShell(session: SessionView) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AdminShell />}>
            <Route index element={<div>home</div>} />
            <Route path="reports/device" element={<LocationProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Top-bar global search', () => {
  it('submitting a term lands on the Device Detail list filtered by it', async () => {
    const user = userEvent.setup();
    stubFetch();
    renderShell(opsHead);

    await user.type(screen.getByLabelText('Search'), 'MH12AB1234{Enter}');

    expect(screen.getByTestId('location')).toHaveTextContent('/reports/device?search=MH12AB1234');
  });

  it('encodes a term with spaces rather than breaking the query string', async () => {
    const user = userEvent.setup();
    stubFetch();
    renderShell(opsHead);

    await user.type(screen.getByLabelText('Search'), 'Acme Logistics{Enter}');

    expect(screen.getByTestId('location')).toHaveTextContent('/reports/device?search=Acme%20Logistics');
  });

  it('an empty or whitespace-only term does not navigate', async () => {
    const user = userEvent.setup();
    stubFetch();
    renderShell(opsHead);

    await user.type(screen.getByLabelText('Search'), '   {Enter}');

    expect(screen.queryByTestId('location')).not.toBeInTheDocument();
    expect(screen.getByText('home')).toBeInTheDocument();
  });

  it('is not offered to a Warehouse Manager, who cannot reach the device list', () => {
    stubFetch();
    renderShell(warehouse);

    expect(screen.queryByLabelText('Search')).not.toBeInTheDocument();
  });
});
