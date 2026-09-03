import type { SessionView } from '@fsm/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { AdminShell } from '../src/components/AdminShell';

/**
 * Issue 27 AC#2 — the persistent "Acting as Zonal Manager for [Zone]" banner. A CSM / Operations Head
 * enters acting mode for a zone; the banner shows across the shell and an Exit clears it. A ZM never
 * sees the entry control.
 *
 * The entry control is a picker over the real zones (`/org/zones`), not a free-text zone id — a typo
 * used to enter acting mode for a zone that does not exist. When the list cannot be read (an older
 * backend), it falls back to the numeric input so the control is never a dead end.
 *
 * #339 adds three things to the same flow: the banner names the **zone**, not its id (an operator has
 * no reason to know that zone 3 is WEST — and the reference banner reads "Acting as Zonal Manager for
 * West"); the sidebar becomes the **ZM's** menu while acting, because a menu offering CSM-only
 * destinations contradicts the banner directly above it; and entering and leaving acting are
 * **recorded** (`POST /acting/enter` / `/acting/exit`), which is what makes an acted-as decision
 * traceable to a session rather than only to the individual writes inside it.
 */
const csm: SessionView = { user_id: 'csm1', role: 'CENTRAL_SERVICE_MANAGER', zone_id: null, acted_as_role: null };
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const ZONES = [
  { zoneId: 3, name: 'WEST', zonalManagerUserId: null },
  { zoneId: 4, name: 'EAST', zonalManagerUserId: null },
];

/** `zones` = the `/org/zones` payload, or null to make the read fail (the fallback path). */
/** Every request the shell made, so the acting audit calls can be asserted (#339). */
let calls: { url: string; method: string; actingZone: string | null }[] = [];

function stubFetch(zones: typeof ZONES | null) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: init?.method ?? 'GET', actingZone: headers['X-Acting-As-Zone'] ?? null });
      if (url.includes('/org/zones')) {
        if (!zones) return new Response('{}', { status: 403 });
        return new Response(JSON.stringify(zones), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

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

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Acting-as-ZM banner (Issue 27)', () => {
  it('a CSM picks a zone by name, sees the persistent banner, then exits', async () => {
    const user = userEvent.setup();
    stubFetch(ZONES);
    renderShell(csm);
    expect(screen.queryByText(/acting as zonal manager for zone/i)).not.toBeInTheDocument();

    const picker = await screen.findByRole('combobox', { name: /act as zm for zone/i });
    // Nothing chosen yet — Go must not be armed (it used to accept an empty / bogus value silently).
    expect(screen.getByRole('button', { name: /^go$/i })).toBeDisabled();

    await user.selectOptions(picker, '3');
    await user.click(screen.getByRole('button', { name: /^go$/i }));

    // #339 — the zone by NAME. "Zone 3" is the id the operator never chose and cannot check.
    expect(screen.getByText(/acting as zonal manager for west/i)).toBeInTheDocument();
    expect(sessionStorage.getItem('fsm.actingZone')).toBe('3');

    await user.click(screen.getByRole('button', { name: /exit acting mode/i }));
    expect(screen.queryByText(/acting as zonal manager for/i)).not.toBeInTheDocument();
    expect(sessionStorage.getItem('fsm.actingZone')).toBeNull();
  });

  it('#339 — records entering and leaving acting, each carrying the zone', async () => {
    const user = userEvent.setup();
    stubFetch(ZONES);
    renderShell(csm);

    await user.selectOptions(await screen.findByRole('combobox', { name: /act as zm for zone/i }), '3');
    await user.click(screen.getByRole('button', { name: /^go$/i }));

    const entered = calls.find((c) => c.url.includes('/acting/enter'));
    expect(entered).toBeDefined();
    expect(entered!.method).toBe('POST');
    // The header is what the backend audits from, so the call is worthless without it.
    expect(entered!.actingZone).toBe('3');

    await user.click(screen.getByRole('button', { name: /exit acting mode/i }));
    const exited = calls.find((c) => c.url.includes('/acting/exit'));
    expect(exited).toBeDefined();
    expect(exited!.actingZone).toBe('3');
  });

  it('#339 — the sidebar becomes the ZM menu while acting', async () => {
    const user = userEvent.setup();
    stubFetch(ZONES);
    renderShell(csm);

    // A CSM-only destination, present before acting…
    expect(screen.getAllByRole('link', { name: /se assignment threshold/i }).length).toBeGreaterThan(0);

    await user.selectOptions(await screen.findByRole('combobox', { name: /act as zm for zone/i }), '3');
    await user.click(screen.getByRole('button', { name: /^go$/i }));

    // …and gone while acting: the menu must not offer what the banner says you are not.
    expect(screen.queryByRole('link', { name: /se assignment threshold/i })).not.toBeInTheDocument();
  });

  it('falls back to the numeric zone input when the zone list cannot be read', async () => {
    const user = userEvent.setup();
    stubFetch(null);
    renderShell(csm);

    const input = await screen.findByLabelText(/act as zm for zone/i);
    await user.type(input, '3');
    await user.click(screen.getByRole('button', { name: /^go$/i }));

    // No name to show — the id is the honest fallback rather than a blank.
    expect(screen.getByText(/acting as zonal manager for zone 3/i)).toBeInTheDocument();
  });

  it('a ZM never sees the acting entry control', () => {
    stubFetch(ZONES);
    renderShell(zm);
    expect(screen.queryByLabelText(/act as zm for zone/i)).not.toBeInTheDocument();
  });
});
