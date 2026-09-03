import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnavailabilityRow } from '../src/api/roleUnavailability';
import { ManagerAvailabilitySection } from '../src/pages/settings/ManagerAvailabilitySection';

/**
 * #339 AC4 — manager availability, the screen the acting gate depends on.
 *
 * `POST /role-unavailability` has existed since Issue 27 and **no screen ever called it**. Nothing
 * could read a window back, and nothing could end one. That is why the CSM acting gate could not be
 * switched on before this: the rule "a CSM may act only while that zone's ZM is out" is unusable if
 * no operator can say that a ZM is out, see that they are, or say that they are back.
 *
 * So what this asserts is the loop, not the layout: open a window, see it listed as in force, end it,
 * and see that it is no longer in force. The zone is shown by **name**, for the same reason the
 * acting banner shows one — the id is the part of the row an operator cannot check.
 */
const ZONES = [
  { zoneId: 3, name: 'WEST', zonalManagerUserId: null },
  { zoneId: 4, name: 'EAST', zonalManagerUserId: null },
];

const OPEN_WINDOW: UnavailabilityRow = {
  id: '11',
  role: 'ZONAL_MANAGER',
  zoneId: '3',
  zoneName: 'WEST',
  userId: null,
  windowStart: '2026-09-03T04:00:00.000Z',
  windowEnd: null,
  reason: 'Annual leave',
  createdByRole: 'OPERATIONS_HEAD',
  open: true,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

/** Routes the section's three calls; `windows` is the mutable list the server would return. */
function server(windows: UnavailabilityRow[]) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url.includes('/org/zones')) return json(ZONES);
    if (url.includes('/role-unavailability') && method === 'POST') return json({ result: 'OK', id: '12' });
    if (url.includes('/role-unavailability/') && method === 'DELETE') return json({ result: 'OK' });
    if (url.includes('/role-unavailability')) return json(windows);
    return json([]);
  });
}

describe('#339 — Manager availability', () => {
  it('lists an open window by zone name, and says it is in force', async () => {
    server([OPEN_WINDOW]);
    render(<ManagerAvailabilitySection />);

    const row = await screen.findByRole('row', { name: /west/i });
    expect(within(row).getByText(/zonal manager/i)).toBeInTheDocument();
    expect(within(row).getByText(/in force/i)).toBeInTheDocument();
    expect(within(row).getByText(/annual leave/i)).toBeInTheDocument();
  });

  it('opens a window for a zone the operator picked by name', async () => {
    const user = userEvent.setup();
    server([]);
    render(<ManagerAvailabilitySection />);

    await screen.findByRole('combobox', { name: /zone/i });
    await user.selectOptions(screen.getByRole('combobox', { name: /zone/i }), '3');
    await user.type(screen.getByLabelText(/reason/i), 'Annual leave');
    await user.click(screen.getByRole('button', { name: /mark manager unavailable/i }));

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posted).toBeDefined();
      const body = JSON.parse((posted![1] as RequestInit).body as string);
      expect(body).toMatchObject({ role: 'ZONAL_MANAGER', zoneId: 3, reason: 'Annual leave' });
      // The window has to start immediately, or the cover it authorises would not exist yet — the
      // operator pressed the button because the manager is out *now*.
      expect(typeof body.windowStart).toBe('string');
      expect(body.windowEnd ?? null).toBeNull();
    });
  });

  it('ends a window, and stops showing it as in force', async () => {
    const user = userEvent.setup();
    const windows = [OPEN_WINDOW];
    server(windows);
    render(<ManagerAvailabilitySection />);

    const row = await screen.findByRole('row', { name: /west/i });
    // After the DELETE the section re-reads; the server now reports the window closed.
    windows[0] = { ...OPEN_WINDOW, open: false, windowEnd: '2026-09-03T09:00:00.000Z' };
    await user.click(within(row).getByRole('button', { name: /end/i }));

    await waitFor(() => {
      const deleted = fetchMock.mock.calls.find(
        ([url, init]) =>
          (init as RequestInit | undefined)?.method === 'DELETE' && String(url).includes('/role-unavailability/11'),
      );
      expect(deleted).toBeDefined();
    });
    await waitFor(() => {
      expect(screen.queryByText(/in force/i)).not.toBeInTheDocument();
    });
  });

  it('says so plainly when nobody is marked unavailable', async () => {
    server([]);
    render(<ManagerAvailabilitySection />);
    expect(await screen.findByText(/no manager is marked unavailable/i)).toBeInTheDocument();
  });
});
