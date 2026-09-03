import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { DashboardHome } from '../src/pages/dashboard/DashboardHome';

/**
 * Issue 27 — acting as ZM has to change the DATA, not just which body renders. The dashboard client
 * sends `X-Acting-As-Zone`, and the backend resolves it into the read scope (`resolveManagerScope`).
 * Both halves were missing: the dashboard/report clients used a local bearer-only header builder, and
 * the effect that loads the aggregations had an empty dependency list — so an Operations Head who
 * entered acting mode got the Zone Operations layout over pan-India numbers, and no refetch at all.
 */
const opsHead: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

function headerOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('X-Acting-As-Zone');
}

function stubFetch() {
  const calls: { url: string; actingZone: string | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, actingZone: headerOf(init) });
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('acting-as-ZM request scope', () => {
  it('sends the acting zone on the dashboard aggregation reads', async () => {
    sessionStorage.setItem('fsm.actingZone', '3');
    const calls = stubFetch();

    render(
      <AuthProvider initialSession={opsHead}>
        <MemoryRouter>
          <DashboardHome />
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() => expect(calls.some((c) => c.url.includes('dashboard/zone-overview'))).toBe(true));

    const dashboardCalls = calls.filter((c) => c.url.includes('/dashboard/'));
    expect(dashboardCalls.length).toBeGreaterThan(0);
    for (const call of dashboardCalls) {
      expect(call.actingZone, call.url).toBe('3');
    }
    // The Fleet Uptime hero KPI comes from the reports client — it must follow acting mode too.
    const uptime = calls.find((c) => c.url.includes('reports/fleet-uptime'));
    expect(uptime?.actingZone).toBe('3');
  });

  it('omits the header when not acting', async () => {
    const calls = stubFetch();

    render(
      <AuthProvider initialSession={opsHead}>
        <MemoryRouter>
          <DashboardHome />
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() => expect(calls.some((c) => c.url.includes('dashboard/zone-overview'))).toBe(true));
    expect(calls.filter((c) => c.url.includes('/dashboard/')).every((c) => c.actingZone === null)).toBe(true);
    expect(await screen.findByText('Pan-India Fleet Command')).toBeInTheDocument();
  });
});
