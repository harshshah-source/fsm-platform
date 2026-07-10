import type { SessionView } from '@fsm/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/AppRoutes';
import { AuthProvider } from '../src/auth/AuthProvider';
import { CrossZonePage } from '../src/pages/cross-zone/CrossZonePage';

/**
 * Issue 78 — Admin Cross-Zone page (`/cross-zone`). Presentation-only over the Issue 32 backend
 * (`/api/cross-zone`): the Auto-Escalations (Platinum) vs Manual (Gold/Silver) split + decider
 * Approve / Deny / Defer row actions + the sweep trigger. No backend change.
 */
const OH: SessionView = { user_id: 'oh', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const ZM: SessionView = { user_id: 'zm', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const SE: SessionView = { user_id: 'se', role: 'SERVICE_ENGINEER', zone_id: 1, acted_as_role: null };

const AUTO = {
  escalationId: '10',
  ticketId: 't-auto0001',
  homeZoneId: '1',
  companyId: '900',
  companyTier: 'PLATINUM',
  escalationType: 'AUTO_PLATINUM',
  status: 'PENDING',
  triggerBucket: 'CRITICAL',
  flagReason: null,
  decisionReason: null,
  reviewDate: null,
  targetZoneId: null,
  assignedSeId: null,
  raisedByRole: null,
  createdAt: '2026-06-30T00:00:00.000Z',
};
const MANUAL = {
  escalationId: '11',
  ticketId: 't-man00001',
  homeZoneId: '2',
  companyId: '901',
  companyTier: 'GOLD',
  escalationType: 'MANUAL_FLAG',
  status: 'PENDING',
  triggerBucket: null,
  flagReason: 'need cross-zone help',
  decisionReason: null,
  reviewDate: null,
  targetZoneId: null,
  assignedSeId: null,
  raisedByRole: 'ZONAL_MANAGER',
  createdAt: '2026-06-30T00:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function stub(extra?: (url: string, opts?: RequestInit) => Response | undefined) {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const hit = extra?.(u, opts);
    if (hit) return hit;
    if (u.endsWith('/cross-zone')) return json([AUTO, MANUAL]);
    // The mounted dashboard fans out to several /dashboard/* reads, all array-typed; return [] so the
    // KPI strip and zone/company/critical tables render during the route-gating assertion (#114 fold-in).
    if (u.includes('/dashboard/')) return json([]);
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage(session: SessionView = OH) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter>
        <CrossZonePage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  sessionStorage.setItem('fsm.accessToken', 'tok');
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Cross-Zone page (Issue 78)', () => {
  it('splits escalations into Auto (Platinum) and Manual (Gold/Silver) sections', async () => {
    stub();
    renderPage(OH);
    const auto = within(await screen.findByRole('table', { name: /auto-escalations/i }));
    expect(auto.getByTestId('cz-row-10')).toHaveTextContent(/PLATINUM/i);
    const manual = within(await screen.findByRole('table', { name: /manual flags/i }));
    expect(manual.getByTestId('cz-row-11')).toHaveTextContent(/GOLD/i);
  });

  it('lets a decider approve a pending escalation with a target zone + SE', async () => {
    stub((u, opts) => {
      if (u.endsWith('/cross-zone/10/approve') && opts?.method === 'POST') {
        return json({ result: 'OK', escalationId: '10', status: 'APPROVED' });
      }
      return undefined;
    });
    vi.stubGlobal('prompt', vi.fn().mockReturnValueOnce('3').mockReturnValueOnce('se-9'));
    renderPage(OH);
    await screen.findByTestId('cz-row-10');
    fireEvent.click(screen.getByTestId('cz-approve-10'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/cross-zone/10/approve'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/cross-zone/10/approve'));
    expect(String((call![1] as RequestInit).body)).toContain('"targetZoneId":3');
    expect(String((call![1] as RequestInit).body)).toContain('"seId":"se-9"');
  });

  it('lets a decider deny a pending escalation with a reason', async () => {
    stub((u, opts) => {
      if (u.endsWith('/cross-zone/11/deny') && opts?.method === 'POST') return json({ result: 'OK', status: 'DENIED' });
      return undefined;
    });
    vi.stubGlobal('prompt', () => 'not our capacity');
    renderPage(OH);
    await screen.findByTestId('cz-row-11');
    fireEvent.click(screen.getByTestId('cz-deny-11'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/cross-zone/11/deny'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('lets a decider defer a pending escalation with a review date + reason', async () => {
    stub((u, opts) => {
      if (u.endsWith('/cross-zone/10/defer') && opts?.method === 'POST') return json({ result: 'OK', status: 'DEFERRED' });
      return undefined;
    });
    vi.stubGlobal('prompt', vi.fn().mockReturnValueOnce('2026-07-05').mockReturnValueOnce('revisit next week'));
    renderPage(OH);
    await screen.findByTestId('cz-row-10');
    fireEvent.click(screen.getByTestId('cz-defer-10'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/cross-zone/10/defer'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/cross-zone/10/defer'));
    expect(String((call![1] as RequestInit).body)).toContain('"reviewDate":"2026-07-05"');
  });

  it('does not show decider actions to a Zonal Manager (read-only queue)', async () => {
    stub();
    renderPage(ZM);
    await screen.findByTestId('cz-row-10');
    expect(screen.queryByTestId('cz-approve-10')).toBeNull();
    expect(screen.queryByTestId('cz-deny-10')).toBeNull();
  });

  it('lets a decider run the auto-escalation sweep', async () => {
    stub((u, opts) => {
      if (u.endsWith('/cross-zone/sweep') && opts?.method === 'POST') return json({ escalated: 2 });
      return undefined;
    });
    renderPage(OH);
    fireEvent.click(await screen.findByTestId('cz-sweep'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/cross-zone/sweep'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});

describe('Cross-Zone route gating (Issue 78)', () => {
  function renderRoute(session: SessionView) {
    return render(
      <AuthProvider initialSession={session}>
        <MemoryRouter initialEntries={['/cross-zone']}>
          <AppRoutes />
        </MemoryRouter>
      </AuthProvider>,
    );
  }

  it('lets a manager reach /cross-zone', async () => {
    stub();
    renderRoute(OH);
    expect(await screen.findByRole('heading', { name: /cross-zone escalations/i })).toBeInTheDocument();
  });

  it('redirects a Service Engineer away from /cross-zone', async () => {
    stub();
    renderRoute(SE);
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /cross-zone escalations/i })).toBeNull();
    });
  });
});
