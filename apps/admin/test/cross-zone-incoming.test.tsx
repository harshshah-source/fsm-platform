import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { CrossZonePage } from '../src/pages/cross-zone/CrossZonePage';

/**
 * #354 — the Cross-Zone queue tells a ZM which side of an escalation they are on.
 *
 * `listForScope` used to scope a ZM by `homeZoneId` alone, so an approval that put a ticket on one of
 * *their* engineers appeared in nobody's queue. The row now arrives with a `direction`, and the
 * receiving zone's rows must be distinguishable at a glance from the work the zone sent out —
 * otherwise the widened read just makes the two kinds of row look identical.
 *
 * A separate file from `cross-zone.test.tsx` (the Issue 78 page spec) deliberately: this asserts the
 * #354 badge only, and leaves that file's fixtures untouched.
 */
const ZM: SessionView = { user_id: 'zm', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const row = (over: Record<string, unknown>) => ({
  escalationId: '10',
  ticketId: 't-outgo001',
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
  direction: 'outgoing',
  ...over,
});

const OUTGOING = row({});
const INCOMING = row({
  escalationId: '11',
  ticketId: 't-incom001',
  homeZoneId: '2',
  status: 'APPROVED',
  targetZoneId: '1',
  assignedSeId: 'se-1',
  direction: 'incoming',
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith('/cross-zone') ? json([OUTGOING, INCOMING]) : json({}),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('#354 — Cross-Zone incoming badge', () => {
  it('badges the row assigned into this zone and leaves the zone’s own escalation unbadged', async () => {
    render(
      <AuthProvider initialSession={ZM}>
        <MemoryRouter>
          <CrossZonePage />
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('cz-row-11')).toBeInTheDocument());
    expect(screen.getByTestId('cz-incoming-11')).toHaveTextContent(/incoming/i);
    expect(screen.queryByTestId('cz-incoming-10')).toBeNull();
  });
});
