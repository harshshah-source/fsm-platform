import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/AppRoutes';
import { AuthProvider } from '../src/auth/AuthProvider';
import { SeManagementDirectoryPage } from '../src/pages/engineers/SeManagementDirectoryPage';

/**
 * Phase 4 — SE Management directory (`/engineers/manage`). Presentation over the Phase-4 CRUD backend
 * (`/api/engineers` admin surface). Role-based affordances only (authority is server-side): OH/CSM get a
 * zone filter + zone select; a ZM's create Zone is pre-filled + locked; SE is bounced by the route.
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();

const OH: SessionView = { user_id: 'oh', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const ZM: SessionView = { user_id: 'zm', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const SE: SessionView = { user_id: 'se', role: 'SERVICE_ENGINEER', zone_id: 1, acted_as_role: null };

const DIR_ROW = {
  seId: 'se-1',
  name: 'Asha Rao',
  phone: '+91 90000 11111',
  email: 'asha@fsm.test',
  address: 'Pune',
  zoneId: 1,
  coverageType: 'DEDICATED',
  dailyCapacity: 10,
  isActive: true,
  plants: [{ id: 5, name: 'Pune Depot', coverageId: 77 }],
  companies: [],
};

function stubReads(extra?: (url: string, opts?: RequestInit) => Response | undefined, directory: unknown[] = [DIR_ROW]) {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const hit = extra?.(u, opts);
    if (hit) return hit;
    if (u.includes('/engineers/directory')) return json(directory);
    if (u.includes('/org/zones')) return json([{ zoneId: 1, name: 'North', zonalManagerUserId: null }, { zoneId: 2, name: 'South', zonalManagerUserId: null }]);
    if (u.includes('/org/plants')) return json([{ plantId: 5, name: 'Pune Depot', zoneId: 1 }]);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage(session: SessionView = OH) {
  return render(
    <AuthProvider initialSession={session}>
      <SeManagementDirectoryPage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  sessionStorage.setItem('fsm.accessToken', 'test-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('SE Management directory (Phase 4)', () => {
  it('renders the directory columns, the create form, and a row', async () => {
    stubReads();
    renderPage();
    expect(await screen.findByRole('heading', { name: /se management/i })).toBeInTheDocument();
    expect(await screen.findByText('Asha Rao')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: /se directory/i });
    for (const col of [/name/i, /phone/i, /email/i, /address/i, /zone/i, /mapped plants/i, /mapped companies/i, /status/i]) {
      expect(within(table).getByRole('columnheader', { name: col })).toBeInTheDocument();
    }
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add service engineer/i })).toBeInTheDocument();
  });

  it('shows the empty-state prompt when there are no SEs', async () => {
    stubReads(undefined, []);
    renderPage();
    expect(await screen.findByText(/no ses yet — add engineers to enable dispatch/i)).toBeInTheDocument();
  });

  it('OH gets a zone filter + a zone select in the create form', async () => {
    stubReads();
    renderPage(OH);
    expect(await screen.findByLabelText(/filter zone/i)).toBeInTheDocument();
    const zoneField = screen.getByLabelText(/^zone$/i) as HTMLSelectElement;
    expect(zoneField.tagName).toBe('SELECT');
    expect(zoneField).not.toBeDisabled();
  });

  it('a ZM has no zone filter and a locked, pre-filled Zone field', async () => {
    stubReads();
    renderPage(ZM);
    await screen.findByRole('heading', { name: /se management/i });
    expect(screen.queryByLabelText(/filter zone/i)).toBeNull();
    const zoneField = (await screen.findByLabelText(/^zone$/i)) as HTMLInputElement;
    expect(zoneField).toBeDisabled();
    expect(zoneField.value).toBe('North'); // pre-filled from the ZM's home zone
  });

  it('creates an SE with the entered fields (OH picks a zone)', async () => {
    stubReads((u, opts) => {
      if (u.endsWith('/engineers') && (opts?.method ?? 'GET') === 'POST') return json({ ...DIR_ROW, seId: 'se-new', name: 'Ravi K' });
      return undefined;
    });
    renderPage(OH);
    await userEvent.type(await screen.findByLabelText(/^name$/i), 'Ravi K');
    await userEvent.type(screen.getByLabelText(/^phone$/i), '+91 90000 22222');
    await userEvent.type(screen.getByLabelText(/^email$/i), 'ravi@fsm.test');
    await userEvent.selectOptions(screen.getByLabelText(/^zone$/i), '1');
    await userEvent.click(screen.getByRole('button', { name: /add service engineer/i }));

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).endsWith('/engineers') && (opts as RequestInit | undefined)?.method === 'POST',
      );
      expect(posted).toBeTruthy();
      const body = String((posted![1] as RequestInit).body);
      expect(body).toContain('"name":"Ravi K"');
      expect(body).toContain('"zoneId":1');
    });
  });

  it('removes a mapped plant via its coverage id from the edit panel', async () => {
    let deleted: string | null = null;
    stubReads((u, opts) => {
      if (u.includes('/engineers/se-1/coverage/77') && (opts?.method ?? 'GET') === 'DELETE') {
        deleted = u;
        return json({ id: 77 });
      }
      return undefined;
    });
    renderPage(OH);
    // Row selection is the explicit "Manage coverage →" affordance, NOT the name — the name cell is an
    // EditableCell (#150), so clicking it starts an inline edit instead of opening the panel. Scoped to
    // the SE's own row so a second directory row can never satisfy this click.
    const row = (await screen.findByText('Asha Rao')).closest('tr');
    expect(row).not.toBeNull();
    await userEvent.click(within(row!).getByRole('button', { name: /manage coverage/i }));
    await userEvent.click(await screen.findByRole('button', { name: /remove pune depot/i }));
    await waitFor(() => expect(deleted).toContain('/engineers/se-1/coverage/77'));
  });

  it('maps a backend validation code to an inline message', async () => {
    stubReads((u, opts) => {
      if (u.endsWith('/engineers') && (opts?.method ?? 'GET') === 'POST') return json({ code: 'INVALID_EMAIL' }, 400);
      return undefined;
    });
    renderPage(OH);
    await userEvent.type(await screen.findByLabelText(/^name$/i), 'Bad Email');
    await userEvent.type(screen.getByLabelText(/^phone$/i), '+91 90000 33333');
    await userEvent.type(screen.getByLabelText(/^email$/i), 'nope');
    await userEvent.selectOptions(screen.getByLabelText(/^zone$/i), '1');
    await userEvent.click(screen.getByRole('button', { name: /add service engineer/i }));
    expect(await screen.findByText(/enter a valid email address/i)).toBeInTheDocument();
  });
});

describe('SE Management route gating (Phase 4)', () => {
  function renderRoute(path: string, session: SessionView) {
    return render(
      <AuthProvider initialSession={session}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </AuthProvider>,
    );
  }

  it('lets a manager reach /engineers/manage', async () => {
    stubReads();
    renderRoute('/engineers/manage', OH);
    expect(await screen.findByRole('heading', { name: /se management/i })).toBeInTheDocument();
  });

  it('bounces a Service Engineer away from /engineers/manage', async () => {
    stubReads();
    renderRoute('/engineers/manage', SE);
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /se management/i })).toBeNull();
    });
  });
});
