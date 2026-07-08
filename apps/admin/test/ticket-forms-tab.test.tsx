import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/AppRoutes';
import { AuthProvider } from '../src/auth/AuthProvider';

/**
 * FE-09 Forms tab — the Ticket Detail Drawer Forms tab, filled from the Issue 70 read
 * (`GET /api/tickets/:id/forms`). Previously a "coming soon" stub (blocked on the backend read).
 */
const oh: SessionView = { user_id: 'oh', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const TICKET_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const detail = {
  ticketId: TICKET_ID,
  workType: 'TROUBLESHOOT',
  status: 'VERIFICATION_PENDING',
  deviceId: '900',
  vehicleId: '12',
  plantId: '7',
  companyId: '3',
  companyTier: 'GOLD',
  assignmentState: 'UNASSIGNED',
  slaBucket: 'CRITICAL',
  repeatFailure: false,
  failureCycleState: 'SUBMITTED',
  failureCycleId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  createdAt: '2026-06-20T10:00:00.000Z',
  lastStateChangedAt: '2026-06-20T10:00:00.000Z',
  lifecycle: [],
};

const forms = {
  ticketId: TICKET_ID,
  forms: [
    {
      submissionId: 'sub-1',
      submissionType: 'TROUBLESHOOTING_FORM',
      seId: 'se-1',
      clientSubmissionId: 'cli-1',
      rootCauseCategory: 'GPS_ANTENNA_ISSUE',
      rootCauseSubcategory: 'LOOSE_CONNECTOR',
      rootCauseNotes: null,
      actionTakenCategory: 'RESEATED',
      actionTakenNotes: null,
      diagnosisNotes: 'antenna reseated and verified',
      componentUnavailable: false,
      componentUnavailableItem: null,
      photoRefs: [],
      presenceSource: 'FORM_GPS',
      seGpsLat: 12.9,
      seGpsLon: 77.5,
      submittedAt: '2026-06-20T11:00:00.000Z',
    },
  ],
};

function stubFetch(formsBody: unknown = forms) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      let body: unknown = [];
      if (url.includes(`/tickets/${TICKET_ID}/forms`)) body = formsBody;
      else if (url.includes(`/tickets/${TICKET_ID}`)) body = detail;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function renderDrawer() {
  return render(
    <AuthProvider initialSession={oh}>
      <MemoryRouter initialEntries={[`/tickets/${TICKET_ID}`]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('FE-09 Forms tab (Issue 70 read)', () => {
  it('renders the submitted troubleshoot form on the Forms tab', async () => {
    stubFetch();
    renderDrawer();
    const drawer = await screen.findByRole('complementary', { name: /ticket detail/i });
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Forms' }));

    const form = await within(drawer).findByTestId('form-sub-1');
    expect(form).toHaveTextContent(/GPS_ANTENNA_ISSUE/);
    expect(form).toHaveTextContent(/antenna reseated and verified/);
  });

  it('shows an empty state when the ticket has no submitted forms', async () => {
    stubFetch({ ticketId: TICKET_ID, forms: [] });
    renderDrawer();
    const drawer = await screen.findByRole('complementary', { name: /ticket detail/i });
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Forms' }));
    expect(await within(drawer).findByText(/no .*forms/i)).toBeInTheDocument();
  });
});
