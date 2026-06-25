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
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/settings', opsHead);
    await userEvent.click(await screen.findByRole('tab', { name: /companies/i }));

    await userEvent.type(screen.getByLabelText(/company name/i), 'Globex');
    await userEvent.selectOptions(screen.getByLabelText(/tier/i), 'GOLD');
    await userEvent.type(screen.getByLabelText(/rank/i), 'B');
    await userEvent.click(screen.getByRole('button', { name: /add company/i }));

    expect(await screen.findByText('Globex')).toBeInTheDocument();
    const postCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeTruthy();
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
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/settings', opsHead);
    await userEvent.click(await screen.findByRole('tab', { name: /companies/i }));

    const row = (await screen.findByText('Acme Logistics')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /edit/i }));
    await userEvent.selectOptions(within(row).getByLabelText(/tier for/i), 'GOLD');
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

  it('blocks a non-Operations-Head role from the Settings route', () => {
    renderAt('/settings', zm);
    expect(screen.queryByRole('heading', { name: /settings/i })).not.toBeInTheDocument();
    // Redirected back to the shell instead (its main heading is the Zone Operations Dashboard).
    expect(
      screen.getByRole('heading', { name: /zone operations dashboard/i }),
    ).toBeInTheDocument();
  });
});
