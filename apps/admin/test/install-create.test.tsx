import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/AppRoutes';
import { AuthProvider } from '../src/auth/AuthProvider';
import { InstallCreatePage } from '../src/pages/install/InstallCreatePage';

/**
 * Issue 69 — Admin Install-create UI. Presentation-only surface over the Issue 33 backend
 * (`POST /api/install`, `POST /api/install/upload`). No backend change: the page consumes the
 * existing endpoints and maps their `{code}` / per-row `{line, code, field}` errors to the UI.
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();

const OH: SessionView = { user_id: 'oh', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const ZM: SessionView = { user_id: 'zm', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const SE: SessionView = { user_id: 'se', role: 'SERVICE_ENGINEER', zone_id: 1, acted_as_role: null };

/** Base read stubs (plants + companies for the pickers); create/upload overridden per-test. */
function stubReads(extra?: (url: string, opts?: RequestInit) => Response | undefined) {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const hit = extra?.(u, opts);
    if (hit) return hit;
    if (u.includes('/org/plants'))
      return json([
        { plantId: 5, name: 'Pune Depot', zoneId: 1 },
        { plantId: 6, name: 'Delhi Yard', zoneId: 2 },
      ]);
    if (u.includes('/org/companies'))
      return json([{ companyId: 9, name: 'Acme Logistics', companyTier: 'GOLD', companyPriorityRank: 'B', opsOverride: false }]);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage(session: SessionView = OH) {
  return render(
    <AuthProvider initialSession={session}>
      <InstallCreatePage />
    </AuthProvider>,
  );
}

async function fillSingleForm() {
  await userEvent.type(await screen.findByLabelText(/vehicle no/i), 'MH12AB1234');
  await userEvent.selectOptions(await screen.findByLabelText(/^plant$/i), '5');
  await userEvent.selectOptions(await screen.findByLabelText(/^company$/i), '9');
  await userEvent.type(screen.getByLabelText(/device type/i), 'GT06N');
  await userEvent.type(screen.getByLabelText(/device id/i), '1001');
}

beforeEach(() => {
  sessionStorage.setItem('fsm.accessToken', 'test-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Install-create UI (Issue 69)', () => {
  it('renders the single Install form and the CSV bulk-upload section', async () => {
    stubReads();
    renderPage();
    expect(await screen.findByRole('heading', { name: /install tickets/i })).toBeInTheDocument();
    expect(await screen.findByLabelText(/vehicle no/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/device id/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create install/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/csv/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload csv/i })).toBeInTheDocument();
  });

  it('creates a ticket on valid submit and shows the new ticket id', async () => {
    stubReads((u, opts) => {
      if (u.endsWith('/install') && (opts?.method ?? 'GET') === 'POST') {
        return json({
          ticketId: 'tkt-777',
          workType: 'INSTALL',
          status: 'REQUESTED',
          deviceId: '1001',
          vehicleId: '42',
          plantId: '5',
          companyId: '9',
          installTriggerSource: 'MANUAL_OPERATIONS',
          createdBy: 'oh',
          createdByRole: 'OPERATIONS_HEAD',
          installBatchId: null,
        });
      }
      return undefined;
    });
    renderPage();
    await fillSingleForm();
    await userEvent.click(screen.getByRole('button', { name: /create install/i }));

    expect(await screen.findByText(/tkt-777/)).toBeInTheDocument();
    const posted = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).endsWith('/install') && (opts as RequestInit | undefined)?.method === 'POST',
    );
    expect(posted).toBeTruthy();
    expect(String((posted![1] as RequestInit).body)).toContain('"vehicleNo":"MH12AB1234"');
  });

  it('maps a row-error code to an inline message', async () => {
    stubReads((u, opts) => {
      if (u.endsWith('/install') && (opts?.method ?? 'GET') === 'POST') {
        return json({ code: 'VEHICLE_ALREADY_MAPPED' }, 409);
      }
      return undefined;
    });
    renderPage();
    await fillSingleForm();
    await userEvent.click(screen.getByRole('button', { name: /create install/i }));
    expect(await screen.findByText(/already has an active device/i)).toBeInTheDocument();
  });

  it('uploads CSV and shows the created batch on success', async () => {
    stubReads((u, opts) => {
      if (u.endsWith('/install/upload') && (opts?.method ?? 'GET') === 'POST') {
        return json({ created: ['tkt-1', 'tkt-2'], batchId: 'batch-abc' }, 201);
      }
      return undefined;
    });
    renderPage();
    await userEvent.type(
      await screen.findByLabelText(/csv/i),
      'vehicle_no,plant_id,company_id,device_type,device_id\nMH1,5,9,GT06,1001',
    );
    await userEvent.click(screen.getByRole('button', { name: /upload csv/i }));
    expect(await screen.findByText(/batch-abc/)).toBeInTheDocument();
    expect(screen.getByText(/2/)).toBeInTheDocument();
  });

  it('renders per-row line-numbered errors on CSV validation failure', async () => {
    stubReads((u, opts) => {
      if (u.endsWith('/install/upload') && (opts?.method ?? 'GET') === 'POST') {
        return json(
          { code: 'CSV_VALIDATION_FAILED', errors: [{ line: 3, code: 'DEVICE_NOT_FOUND' }, { line: 5, code: 'ZONE_FORBIDDEN' }] },
          400,
        );
      }
      return undefined;
    });
    renderPage();
    await userEvent.type(await screen.findByLabelText(/csv/i), 'vehicle_no,plant_id,company_id,device_type,device_id\nx,1,1,y,1');
    await userEvent.click(screen.getByRole('button', { name: /upload csv/i }));
    const errors = await screen.findByRole('table', { name: /csv errors/i });
    expect(within(errors).getByText(/line 3/i)).toBeInTheDocument();
    expect(within(errors).getByText(/DEVICE_NOT_FOUND/)).toBeInTheDocument();
    expect(within(errors).getByText(/line 5/i)).toBeInTheDocument();
  });

  it('scopes the plant picker to the ZM own zone and shows all plants for Ops Head', async () => {
    stubReads();
    renderPage(ZM);
    await screen.findByLabelText(/^plant$/i);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/org/plants?zoneId=1'))).toBe(true);
    });

    fetchMock.mockClear();
    renderPage(OH);
    await screen.findAllByLabelText(/^plant$/i);
    await waitFor(() => {
      const plantCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/org/plants'));
      expect(plantCalls.length).toBeGreaterThan(0);
      expect(plantCalls.every(([url]) => !String(url).includes('zoneId='))).toBe(true);
    });
  });
});

describe('Install-create route gating (Issue 69)', () => {
  function renderRoute(path: string, session: SessionView) {
    return render(
      <AuthProvider initialSession={session}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </AuthProvider>,
    );
  }

  it('lets a creator role (Operations Head) reach /install', async () => {
    stubReads();
    renderRoute('/install', OH);
    expect(await screen.findByRole('heading', { name: /install tickets/i })).toBeInTheDocument();
  });

  it('redirects a non-creator role (Service Engineer) away from /install', async () => {
    stubReads();
    renderRoute('/install', SE);
    // RoleRoute bounces a wrong-role user to "/"; the Install form never renders.
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /install tickets/i })).toBeNull();
    });
  });
});
