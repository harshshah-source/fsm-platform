import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { VerificationReviewPage } from '../src/pages/verification/VerificationReviewPage';

/**
 * Issue 19 — the ZM GPS Verification Review page (`/verification`). Rows render by type (PARTIAL_RECOVERY
 * ping count + countdown, FAILED fraud distance chip, no-pings, CLOSED); fraud rows escalate with a
 * mandatory reason; recoverable rows mark auto-recovery; a row click deep-links to the ticket
 * Verification tab. Zone scope is enforced server-side.
 *
 * #358 completes it against what #357 landed: the Fraud-flagged queue comes from the scoped
 * `fraud-flags` endpoint (nothing here called it), a window the sweep cannot expire reads "stalled"
 * instead of "overdue", both destructive doors take a reason AND a confirm, and an escalation raised in
 * error can be reversed.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

/** The watermark every fixture row was answered against — global, so identical on each row. */
const TELEMETRY_AS_OF = '2026-06-23T05:00:00Z';

const row = (over: Record<string, unknown>) => ({
  ticketId: 't-x', deviceId: '900', companyName: 'Acme', zoneId: '1', zoneName: 'NORTH',
  outcome: null, phase: 'PENDING', pingsReceivedCount: 0, fraudFlag: false,
  firstPingDistanceMeters: null, startedAt: '2026-06-23T06:00:00Z', rowType: 'PENDING',
  partialDeadline: null, ticketStatus: 'VERIFICATION_PENDING', escalationReason: null,
  telemetryAsOf: TELEMETRY_AS_OF, stalled: false,
  ...over,
});

const baseRows = [
  row({
    ticketId: 't-fraud', deviceId: '900', companyName: 'Acme',
    outcome: 'FAILED_VERIFICATION', pingsReceivedCount: 3, fraudFlag: true,
    firstPingDistanceMeters: 54213, rowType: 'FAILED_FRAUD', ticketStatus: 'FAILED_VERIFICATION',
  }),
  row({
    ticketId: 't-partial', deviceId: '901', companyName: 'Beta', pingsReceivedCount: 1,
    rowType: 'PARTIAL_RECOVERY', partialDeadline: new Date(Date.now() + 5 * 3_600_000).toISOString(),
  }),
  // Window past its 24 h deadline with telemetry FLOWING — the sweep simply has not run yet. Still
  // overdue, and must stay overdue: this is the row the stall chip must not swallow.
  row({
    ticketId: 't-overdue', deviceId: '902', companyName: 'Gamma', pingsReceivedCount: 2,
    rowType: 'PARTIAL_RECOVERY', partialDeadline: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  }),
  // Same clock, stalled pipeline — the sweep's guard will never expire this one.
  row({
    ticketId: 't-stalled', deviceId: '903', companyName: 'Delta', pingsReceivedCount: 2,
    rowType: 'PARTIAL_RECOVERY', partialDeadline: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    stalled: true,
  }),
  row({
    ticketId: 't-escalated', deviceId: '904', companyName: 'Epsilon',
    outcome: 'FAILED_VERIFICATION', pingsReceivedCount: 3, fraudFlag: true,
    firstPingDistanceMeters: 9000, rowType: 'FAILED_FRAUD',
    ticketStatus: 'ESCALATED', escalationReason: 'SE GPS 54 km from the device',
  }),
];

/**
 * The scoped `fraud-flags` payload. `t-foreign` exists ONLY here — it is deliberately absent from the
 * review payload, so a Fraud-flagged tab that merely filtered the rows already on the page cannot
 * render it. That is the whole of AC1.
 */
const fraudRows = [
  {
    ticketId: 't-fraud', deviceId: '900', firstPingDistanceMeters: 54213,
    outcome: 'FAILED_VERIFICATION', outcomeAt: '2026-06-24T07:00:00Z',
    zoneId: '1', zoneName: 'NORTH', escalationReason: null, ticketStatus: 'FAILED_VERIFICATION',
  },
  {
    ticketId: 't-escalated', deviceId: '904', firstPingDistanceMeters: 9000,
    outcome: 'FAILED_VERIFICATION', outcomeAt: '2026-06-24T08:00:00Z',
    zoneId: '1', zoneName: 'NORTH', escalationReason: 'SE GPS 54 km from the device',
    ticketStatus: 'ESCALATED',
  },
  {
    ticketId: 't-foreign', deviceId: '905', firstPingDistanceMeters: 12000,
    outcome: 'FAILED_VERIFICATION', outcomeAt: '2026-06-24T09:00:00Z',
    zoneId: '1', zoneName: 'NORTH', escalationReason: null, ticketStatus: 'FAILED_VERIFICATION',
  },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

const postsTo = (fragment: string) =>
  fetchMock.mock.calls.filter(
    ([u, o]) => String(u).includes(fragment) && (o as RequestInit | undefined)?.method === 'POST',
  );

function renderPage() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={['/verification']}>
        <Routes>
          <Route path="/verification" element={<VerificationReviewPage />} />
          <Route path="/tickets/:id" element={<div>Ticket drawer stub</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

/** Open the Fraud-flagged tab and hand back its table. */
async function fraudTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: /fraud flagged/i }));
  return within(await screen.findByRole('table', { name: /fraud flagged/i }));
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/verification/fraud-flags')) return json(fraudRows);
    if (String(url).includes('/verification/review')) return json(baseRows);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Verification Review page (Issue 19)', () => {
  it('renders row types: fraud distance chip and partial ping-count + countdown', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /verification review/i }));
    // Fraud row shows the distance delta (~54213 m → "54213 m off").
    expect(table.getByText(/54213 m off/i)).toBeInTheDocument();
    // Partial row shows N/3 pings and an hours-left countdown.
    expect(table.getByText(/1\/3 pings/i)).toBeInTheDocument();
    expect(table.getByText(/h left/i)).toBeInTheDocument();
  });

  it('escalates a fraud row with a mandatory reason and a confirm', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /verification review/i });

    await user.click(within(screen.getByTestId('vr-row-t-fraud')).getByRole('button', { name: /escalate/i }));
    const dialog = within(await screen.findByRole('dialog', { name: /escalate verification/i }));
    // Escalate is disabled until a reason is typed.
    const submit = dialog.getByRole('button', { name: /^escalate$/i });
    expect(submit).toBeDisabled();
    await user.type(dialog.getByLabelText(/escalation reason/i), 'SE GPS 54km from device');
    await user.click(submit);
    await user.click(await screen.findByRole('button', { name: /confirm escalate/i }));

    await waitFor(() => {
      const calls = postsTo('/verification/t-fraud/escalate');
      expect(calls.length).toBe(1);
      expect(String((calls[0][1] as RequestInit).body)).toContain('SE GPS 54km from device');
    });
  });

  /**
   * #357 made the reason mandatory on this door — marking a ticket CLOSED_AUTO_RECOVERY overrides a
   * verification verdict, and the backend now 400s an empty body. #358 AC3 adds the confirm step: the
   * assertion that nothing reaches the wire until Confirm is clicked is the whole point of it — a
   * reason box alone still fires the override on one stray click.
   */
  it('AC3 — mark auto-recovery needs a reason AND a confirm before anything is sent', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /verification review/i });

    await user.click(within(screen.getByTestId('vr-row-t-partial')).getByRole('button', { name: /mark auto-recovery/i }));

    const panel = await screen.findByRole('dialog', { name: /mark auto-recovery/i });
    await user.type(within(panel).getByLabelText(/auto-recovery reason/i), 'device pinged again overnight');
    await user.click(within(panel).getByRole('button', { name: /^mark auto-recovery$/i }));

    // Reason given, action pressed — and still nothing has been sent.
    expect(postsTo('/verification/t-partial/mark-auto-recovery')).toHaveLength(0);

    await user.click(await screen.findByRole('button', { name: /confirm mark auto-recovery/i }));

    await waitFor(() => {
      const calls = postsTo('/verification/t-partial/mark-auto-recovery');
      expect(calls.length).toBe(1);
      expect(String((calls[0][1] as RequestInit).body)).toContain('device pinged again overnight');
    });
  });

  it('AC3 — cancelling the confirm step sends nothing', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /verification review/i });

    await user.click(within(screen.getByTestId('vr-row-t-partial')).getByRole('button', { name: /mark auto-recovery/i }));
    const panel = await screen.findByRole('dialog', { name: /mark auto-recovery/i });
    await user.type(within(panel).getByLabelText(/auto-recovery reason/i), 'device pinged again overnight');
    await user.click(within(panel).getByRole('button', { name: /^mark auto-recovery$/i }));
    await user.click(await screen.findByRole('button', { name: /^back$/i }));

    expect(postsTo('/verification/t-partial/mark-auto-recovery')).toHaveLength(0);
  });

  it('deep-links a row click to the ticket Verification tab', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /verification review/i });
    await user.click(within(screen.getByTestId('vr-row-t-fraud')).getByText('Acme'));
    expect(await screen.findByText(/ticket drawer stub/i)).toBeInTheDocument();
  });
});

describe('#358 — the fraud queue, the stall chip and the way back from ESCALATED', () => {
  it('AC1 — the Fraud-flagged tab is fed by the scoped fraud-flags endpoint, not by filtering the review rows', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /verification review/i });

    const table = await fraudTab(user);

    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/verification/fraud-flags'))).toBe(true));
    // `t-foreign` is only in the fraud-flags payload — a filtered review list could not produce it.
    expect(table.getByTestId('vf-row-t-foreign')).toBeInTheDocument();
    expect(table.getByTestId('vf-row-t-fraud')).toBeInTheDocument();
    // ...and a non-fraud row from the review list is not in this queue.
    expect(table.queryByTestId('vf-row-t-partial')).not.toBeInTheDocument();
  });

  it('AC2 — a stalled window says stalled with its telemetry watermark, never overdue', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /verification review/i }));

    const stalled = within(table.getByTestId('vr-row-t-stalled'));
    expect(stalled.getByText(/stalled/i)).toBeInTheDocument();
    expect(stalled.getByText(/telemetry as of/i)).toBeInTheDocument();
    expect(stalled.queryByText(/overdue/i)).not.toBeInTheDocument();
  });

  it('AC2 — an expired window with FLOWING telemetry still reads overdue', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /verification review/i }));

    const overdue = within(table.getByTestId('vr-row-t-overdue'));
    expect(overdue.getByText(/overdue/i)).toBeInTheDocument();
    expect(overdue.queryByText(/stalled/i)).not.toBeInTheDocument();
  });

  it('AC4 — De-escalate is offered on the ESCALATED row and on no other', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /verification review/i }));

    expect(within(table.getByTestId('vr-row-t-escalated')).getByRole('button', { name: /de-escalate/i })).toBeInTheDocument();
    expect(within(table.getByTestId('vr-row-t-fraud')).queryByRole('button', { name: /de-escalate/i })).not.toBeInTheDocument();
    expect(within(table.getByTestId('vr-row-t-partial')).queryByRole('button', { name: /de-escalate/i })).not.toBeInTheDocument();
  });

  it('AC4 — an escalated fraud row is not offered Escalate again', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /verification review/i }));

    expect(within(table.getByTestId('vr-row-t-escalated')).queryByRole('button', { name: /^escalate$/i })).not.toBeInTheDocument();
  });

  it('AC3 + AC4 — de-escalate takes a reason and a confirm, and posts to the #357 route', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /verification review/i });

    await user.click(within(screen.getByTestId('vr-row-t-escalated')).getByRole('button', { name: /de-escalate/i }));
    const panel = await screen.findByRole('dialog', { name: /de-escalate verification/i });
    const submit = within(panel).getByRole('button', { name: /^de-escalate$/i });
    expect(submit).toBeDisabled();

    await user.type(within(panel).getByLabelText(/de-escalation reason/i), 'escalated against a faulty anchor reading');
    await user.click(submit);
    expect(postsTo('/verification/t-escalated/deescalate')).toHaveLength(0);

    await user.click(await screen.findByRole('button', { name: /confirm de-escalate/i }));

    await waitFor(() => {
      const calls = postsTo('/verification/t-escalated/deescalate');
      expect(calls.length).toBe(1);
      expect(String((calls[0][1] as RequestInit).body)).toContain('escalated against a faulty anchor reading');
    });
  });

  it('AC4 — the fraud queue offers De-escalate on its ESCALATED row only', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /verification review/i });

    const table = await fraudTab(user);

    expect(within(table.getByTestId('vf-row-t-escalated')).getByRole('button', { name: /de-escalate/i })).toBeInTheDocument();
    expect(within(table.getByTestId('vf-row-t-fraud')).queryByRole('button', { name: /de-escalate/i })).not.toBeInTheDocument();
  });
});
