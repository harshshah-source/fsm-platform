import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/AppRoutes';
import { AuthProvider } from '../src/auth/AuthProvider';

function stubApi(handlers: Record<string, { status?: number; body: unknown }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const key = Object.keys(handlers).find((k) => url.endsWith(k));
      if (!key) return new Response('[]', { status: 200 });
      const { status = 200, body } = handlers[key];
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

const opsHead: SessionView = {
  user_id: 'oh1',
  role: 'OPERATIONS_HEAD',
  zone_id: null,
  acted_as_role: null,
};
const zm: SessionView = {
  user_id: 'zm1',
  role: 'ZONAL_MANAGER',
  zone_id: 1,
  acted_as_role: null,
};

function renderAt(path: string, session: SessionView) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Settings — Operations Head only (AC#1)', () => {
  it('renders the Settings page with config tabs for Operations Head', async () => {
    stubApi({
      '/org/companies': {
        body: [{ companyId: 1, name: 'Acme Logistics', companyTier: 'PLATINUM', companyPriorityRank: 'A', opsOverride: false }],
      },
    });
    renderAt('/settings', opsHead);

    expect(await screen.findByRole('heading', { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /companies/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /sla rules/i })).toBeInTheDocument();
  });

  it('lists companies and creates a new one through the API', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/org/companies') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ companyId: 2, name: 'Globex', companyTier: 'GOLD', companyPriorityRank: 'B', opsOverride: false }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/org/companies')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/org/tiers')) {
        return new Response(
          JSON.stringify([{ name: 'PLATINUM', rank: 1 }, { name: 'GOLD', rank: 2 }, { name: 'SILVER', rank: 3 }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/settings', opsHead);
    await userEvent.click(await screen.findByRole('tab', { name: /companies/i }));

    await userEvent.type(screen.getByLabelText(/company name/i), 'Globex');
    await userEvent.selectOptions(await screen.findByLabelText(/^tier$/i), 'GOLD');
    await userEvent.type(screen.getByLabelText(/rank/i), 'B');
    await userEvent.click(screen.getByRole('button', { name: /add company/i }));

    expect(await screen.findByText('Globex')).toBeInTheDocument();
    const postCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeTruthy();
  });

  it('sources the tier dropdown options from /org/tiers, not a hard-coded list (Issue 157 AC-1)', async () => {
    stubApi({
      '/org/companies': { body: [] },
      // Deliberately not PLATINUM/GOLD/SILVER order — proves the options are read from the API
      // response, not a hard-coded array (a hard-coded list would ignore this order entirely).
      '/org/tiers': {
        body: [
          { name: 'SILVER', rank: 3 },
          { name: 'GOLD', rank: 2 },
          { name: 'PLATINUM', rank: 1 },
        ],
      },
    });
    renderAt('/settings', opsHead);
    await userEvent.click(await screen.findByRole('tab', { name: /companies/i }));

    const select = await screen.findByLabelText(/^tier$/i);
    const optionLabels = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(optionLabels).toEqual(['SILVER', 'GOLD', 'PLATINUM']);
  });

  it('edits an existing company tier + override via PATCH (Issue 46)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/org/companies/') && init?.method === 'PATCH') {
        return new Response(
          JSON.stringify({ companyId: 1, name: 'Acme Logistics', companyTier: 'GOLD', companyPriorityRank: 'A', opsOverride: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/org/companies')) {
        return new Response(
          JSON.stringify([{ companyId: 1, name: 'Acme Logistics', companyTier: 'PLATINUM', companyPriorityRank: 'A', opsOverride: false }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/org/tiers')) {
        return new Response(
          JSON.stringify([{ name: 'PLATINUM', rank: 1 }, { name: 'GOLD', rank: 2 }, { name: 'SILVER', rank: 3 }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/settings', opsHead);
    await userEvent.click(await screen.findByRole('tab', { name: /companies/i }));

    const row = (await screen.findByText('Acme Logistics')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /edit/i }));
    await userEvent.selectOptions(await within(row).findByLabelText(/tier for/i), 'GOLD');
    await userEvent.click(within(row).getByLabelText(/override for/i));
    await userEvent.click(within(row).getByRole('button', { name: /save/i }));

    const patchCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(patchCall).toBeTruthy();
    expect(String(patchCall![0])).toContain('/org/companies/1');
    // Row reflects the updated tier from the PATCH response.
    expect(await within(row).findByText('GOLD')).toBeInTheDocument();
  });

  it('creates a plant under a chosen zone and lists it (Issue 45)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/org/plants') && init?.method === 'POST') {
        return new Response(JSON.stringify({ plantId: 10, name: 'Pune Yard', zoneId: 1 }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/org/plants')) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/org/zones')) {
        return new Response(JSON.stringify([{ zoneId: 1, name: 'NORTH', zonalManagerUserId: null }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/settings', opsHead);
    await userEvent.click(await screen.findByRole('tab', { name: /plants/i }));
    await userEvent.type(screen.getByLabelText(/plant name/i), 'Pune Yard');
    await userEvent.selectOptions(screen.getByLabelText(/^zone$/i), '1');
    await userEvent.click(screen.getByRole('button', { name: /add plant/i }));

    expect(await screen.findByText('Pune Yard')).toBeInTheDocument();
    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(postCall).toBeTruthy();
  });

  it('surfaces a plant-create error in the UI instead of an unhandled rejection (Issue 45)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/org/plants') && init?.method === 'POST') {
        return new Response(JSON.stringify({ message: 'Zone not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/org/plants')) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/org/zones')) {
        return new Response(JSON.stringify([{ zoneId: 1, name: 'NORTH', zonalManagerUserId: null }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/settings', opsHead);
    await userEvent.click(await screen.findByRole('tab', { name: /plants/i }));
    await userEvent.type(screen.getByLabelText(/plant name/i), 'Orphan');
    await userEvent.selectOptions(screen.getByLabelText(/^zone$/i), '1');
    await userEvent.click(screen.getByRole('button', { name: /add plant/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('shows each SLA bucket as its inactivity range derived from the shared thresholds', async () => {
    renderAt('/settings', opsHead);
    await userEvent.click(await screen.findByRole('tab', { name: /sla rules/i }));

    // The bucket label IS its inactivity range now (severity words replaced), derived from
    // @fsm/shared SLA_BANDS — hours read as `Hr`, 3-day+ bands as `d`, the top band open-ended.
    expect(await screen.findByText('4–8Hr')).toBeInTheDocument(); // WARNING [4,8)
    expect(screen.getByText('8–12Hr')).toBeInTheDocument(); // EARLY_RISK [8,12)
    expect(screen.getByText('12–24Hr')).toBeInTheDocument(); // RISK [12,24)
    expect(screen.getByText('24–48Hr')).toBeInTheDocument(); // CRITICAL [24,48)
    expect(screen.getByText('3–5d')).toBeInTheDocument(); // SEVERE [72,120)
    expect(screen.getByText('7d+')).toBeInTheDocument(); // LONG_PENDING [168,∞)
  });

  it('blocks a non-Operations-Head role from the Settings route', () => {
    renderAt('/settings', zm);
    expect(screen.queryByRole('heading', { name: /settings/i })).not.toBeInTheDocument();
    // Redirected back to the shell instead (its main heading is the Zone Operations Dashboard).
    expect(
      screen.getByRole('heading', { name: /zone operations dashboard/i }),
    ).toBeInTheDocument();
  });
});

/**
 * #362 — the Users section was a read-only registry: `PATCH /org/users/:id` existed and nothing on
 * screen could reach it, and no route changed a role or a zone at all. An OH who needed to move a
 * manager between zones had to open a database console. These pin the three row controls and, more
 * importantly, that the one refusal the server can hand back — the last active Operations Head —
 * lands in front of the operator instead of dying in a rejected promise.
 */
describe('Settings — Users administration (#362)', () => {
  const USERS = [
    {
      userId: 'u1',
      name: 'Vikram Rao',
      role: 'ZONAL_MANAGER',
      zoneId: 1,
      phone: '+911',
      email: 'vikram@fsm.test',
      status: 'ACTIVE',
    },
  ];
  const ZONES = [
    { zoneId: 1, name: 'North', zonalManagerUserId: null },
    { zoneId: 2, name: 'South', zonalManagerUserId: null },
  ];

  /** Serves the Users tab's two lists and lets each test decide what the PATCH replies. */
  function usersApi(patch: (body: unknown) => { status?: number; body: unknown }) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (url.includes('/org/users/') && init?.method === 'PATCH') {
        const { status = 200, body } = patch(JSON.parse(String(init.body)));
        return json(body, status);
      }
      if (url.endsWith('/org/users')) return json(USERS);
      if (url.endsWith('/org/zones')) return json(ZONES);
      return json([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const patchBody = (mock: ReturnType<typeof usersApi>) => {
    const call = mock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(call).toBeTruthy();
    return { url: String(call![0]), body: JSON.parse(String((call![1] as RequestInit).body)) };
  };

  async function openUsersTab() {
    renderAt('/settings', opsHead);
    await userEvent.click(await screen.findByRole('tab', { name: /users/i }));
    return (await screen.findByText('Vikram Rao')).closest('tr') as HTMLElement;
  }

  it('AC1 — disables a user from their row and reflects the new status', async () => {
    const fetchMock = usersApi(() => ({ body: { ...USERS[0], status: 'DISABLED' } }));
    const row = await openUsersTab();

    await userEvent.click(within(row).getByRole('button', { name: /disable/i }));

    const { url, body } = patchBody(fetchMock);
    expect(url).toContain('/org/users/u1');
    expect(body).toEqual({ status: 'DISABLED' });
    expect(await within(row).findByText('DISABLED')).toBeInTheDocument();
    // The control flips to the inverse action — a disabled account must be re-enableable from here.
    expect(within(row).getByRole('button', { name: /enable/i })).toBeInTheDocument();
  });

  it('AC1 — changes a role and a zone in one PATCH', async () => {
    const fetchMock = usersApi((body) => ({
      body: { ...USERS[0], ...(body as object) },
    }));
    const row = await openUsersTab();

    await userEvent.click(within(row).getByRole('button', { name: /^edit$/i }));
    await userEvent.selectOptions(await within(row).findByLabelText(/role for/i), 'CENTRAL_SERVICE_MANAGER');
    await userEvent.selectOptions(within(row).getByLabelText(/zone for/i), '2');
    await userEvent.click(within(row).getByRole('button', { name: /save/i }));

    const { url, body } = patchBody(fetchMock);
    expect(url).toContain('/org/users/u1');
    expect(body).toEqual({ role: 'CENTRAL_SERVICE_MANAGER', zoneId: 2 });
    expect(await within(row).findByText(/central service manager/i)).toBeInTheDocument();
    expect(within(row).getByText('South')).toBeInTheDocument();
  });

  it('AC3 — shows the last-Operations-Head refusal rather than failing silently', async () => {
    usersApi(() => ({
      status: 409,
      body: {
        code: 'LAST_OPERATIONS_HEAD',
        message: 'This is the only active Operations Head.',
      },
    }));
    const row = await openUsersTab();

    await userEvent.click(within(row).getByRole('button', { name: /^edit$/i }));
    await userEvent.selectOptions(await within(row).findByLabelText(/role for/i), 'WAREHOUSE_MANAGER');
    await userEvent.click(within(row).getByRole('button', { name: /save/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/only active Operations Head/i);
    // A refused save stays open on the operator's edit rather than closing as if it had worked, and
    // the row still reads what the server still holds.
    await userEvent.click(within(row).getByRole('button', { name: /cancel/i }));
    expect(within(row).getByText('Zonal Manager')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });
});

describe('Settings — Scoring Weights component vocabulary (#266)', () => {
  it('offers only the components the recommender reads, fetched rather than hard-coded', async () => {
    // The Component field was free text: any string could be saved, and the resulting weight then sat
    // in this table looking exactly like a real lever while contributing nothing to any score. Three
    // had been seeded that way since Issue 02 (`company_tier`, `device_bucket`, `sla_urgency`) and are
    // retired by migration; closing the field is what stops the next one being created.
    stubApi({
      '/org/scoring-weights/components': {
        body: { components: ['company_priority_rank', 'dispatch_urgency', 'device_age'] },
      },
      '/org/scoring-weights': { body: [] },
    });
    renderAt('/settings', opsHead);

    await userEvent.click(await screen.findByRole('tab', { name: /Scoring Weights/i }));

    const select = await screen.findByLabelText('Component');
    // A picker, not a text box — the operator can no longer invent a component the scorer will ignore.
    expect(select.tagName).toBe('SELECT');
    expect(within(select).getByRole('option', { name: 'company_priority_rank' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'device_age' })).toBeInTheDocument();
    // The options come from the server's list, so the picker and the validation that 400s on anything
    // outside it cannot drift apart. A retired component is absent because it is absent there.
    expect(within(select).queryByRole('option', { name: 'company_tier' })).not.toBeInTheDocument();
  });
});
