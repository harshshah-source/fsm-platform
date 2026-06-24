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
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const baseRows = [
  {
    ticketId: 't-fraud', deviceId: '900', companyName: 'Acme', zoneId: '1', zoneName: 'NORTH',
    outcome: 'FAILED_VERIFICATION', phase: 'PENDING', pingsReceivedCount: 3, fraudFlag: true,
    firstPingDistanceMeters: 54213, startedAt: '2026-06-23T06:00:00Z', rowType: 'FAILED_FRAUD', partialDeadline: null,
  },
  {
    ticketId: 't-partial', deviceId: '901', companyName: 'Beta', zoneId: '1', zoneName: 'NORTH',
    outcome: null, phase: 'PENDING', pingsReceivedCount: 1, fraudFlag: false,
    firstPingDistanceMeters: null, startedAt: '2026-06-23T06:00:00Z', rowType: 'PARTIAL_RECOVERY',
    partialDeadline: new Date(Date.now() + 5 * 3_600_000).toISOString(),
  },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

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

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string) => {
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

  it('escalates a fraud row with a mandatory reason', async () => {
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

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([u, o]) => String(u).includes('/verification/t-fraud/escalate') && (o as RequestInit | undefined)?.method === 'POST',
      );
      expect(calls.length).toBe(1);
      expect(String((calls[0][1] as RequestInit).body)).toContain('SE GPS 54km from device');
    });
  });

  it('marks a partial row as auto-recovery', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /verification review/i });

    await user.click(within(screen.getByTestId('vr-row-t-partial')).getByRole('button', { name: /mark auto-recovery/i }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([u, o]) => String(u).includes('/verification/t-partial/mark-auto-recovery') && (o as RequestInit | undefined)?.method === 'POST',
      );
      expect(calls.length).toBe(1);
    });
  });

  it('deep-links a row click to the ticket Verification tab', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /verification review/i });
    await user.click(within(screen.getByTestId('vr-row-t-fraud')).getByText('Acme'));
    expect(await screen.findByText(/ticket drawer stub/i)).toBeInTheDocument();
  });
});
