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
