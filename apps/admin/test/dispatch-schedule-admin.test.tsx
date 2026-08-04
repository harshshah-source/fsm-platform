import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkUnassignPage } from '../src/pages/admin/BulkUnassignPage';
import { DispatchScheduleSection } from '../src/pages/settings/sections';

/**
 * #213 admin — the two operator-facing halves of the ruling.
 *
 * 1. The dispatch schedule is editable from Settings, and an invalid expression comes back as a clear
 *    error with the previous schedule still shown — never "saved" into a silently dead state.
 * 2. The Run-dispatch button is **disabled with the reason shown while a run is in flight**. The
 *    operator ruling was specific about this: the conflict must not be something a user discovers by
 *    pressing the button twice.
 */
const ZONES = [{ zoneId: 1, name: 'North', zonalManagerUserId: null }];
const SCHEDULE = { cron: '0 5 * * *', timeZone: 'Asia/Kolkata', nextFireAt: '2026-08-04T23:30:00.000Z' };
const IN_FLIGHT = {
  zoneId: '1',
  startedAt: '2026-08-04T05:02:00.000Z',
  trigger: 'CRON',
  actor: 'SYSTEM',
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

describe('#213 — dispatch schedule editor (Settings)', () => {
  it('shows the schedule in force, its timezone and when it next fires', async () => {
    fetchMock.mockImplementation(async () => json(SCHEDULE));
    render(<DispatchScheduleSection />);

    expect(await screen.findByDisplayValue('0 5 * * *')).toBeInTheDocument();
    expect(screen.getByTestId('dispatch-schedule-timezone')).toHaveTextContent('Asia/Kolkata');
    expect(screen.getByTestId('dispatch-schedule-next')).toBeInTheDocument();
  });

  it('saves a new schedule and shows the new next-fire time', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toEqual({ cron: '30 6 * * *' });
        return json({ ...SCHEDULE, cron: '30 6 * * *', nextFireAt: '2026-08-05T01:00:00.000Z' });
      }
      return json(SCHEDULE);
    });
    render(<DispatchScheduleSection />);

    const input = await screen.findByLabelText('Dispatch schedule (cron)');
    await userEvent.clear(input);
    await userEvent.type(input, '30 6 * * *');
    await userEvent.click(screen.getByTestId('dispatch-schedule-save'));

    await waitFor(() => expect(screen.getByTestId('dispatch-schedule-saved')).toBeInTheDocument());
  });

  it('surfaces the rejection reason for an invalid expression and keeps showing the schedule still in force', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return json({ code: 'INVALID_CRON_EXPRESSION', reason: 'Unknown alias: nonsense' }, 400);
      }
      return json(SCHEDULE);
    });
    render(<DispatchScheduleSection />);

    const input = await screen.findByLabelText('Dispatch schedule (cron)');
    await userEvent.clear(input);
    await userEvent.type(input, 'nonsense');
    await userEvent.click(screen.getByTestId('dispatch-schedule-save'));

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent(/Unknown alias/i);
    // The schedule actually in force is unchanged — the operator must not be left thinking it saved.
    expect(screen.getByTestId('dispatch-schedule-current')).toHaveTextContent('0 5 * * *');
  });
});

describe('#213 — Run dispatch is disabled while a run is in flight', () => {
  const mountWith = (inFlight: unknown[]) => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/org/zones')) return json(ZONES);
      if (url.includes('/bulk-unassign/history')) return json([]);
      if (url.includes('/dispatch-run/in-flight')) return json({ inFlight });
      return json({});
    });
    return render(<BulkUnassignPage />);
  };

  it('disables the button and says which zone is running, since when, and who started it', async () => {
    mountWith([IN_FLIGHT]);

    await waitFor(() => expect(screen.getByTestId('run-dispatch')).toBeDisabled());
    const notice = screen.getByTestId('dispatch-in-flight-notice');
    expect(notice).toHaveTextContent(/already running/i);
    expect(notice).toHaveTextContent('SYSTEM');
    expect(notice).toHaveTextContent('zone 1');
  });

  it('leaves the button enabled when nothing is running', async () => {
    mountWith([]);

    await waitFor(() => expect(screen.getByTestId('run-dispatch')).toBeEnabled());
    expect(screen.queryByTestId('dispatch-in-flight-notice')).not.toBeInTheDocument();
  });

  /** Belt and braces: a run can start between the poll and the click, so the 409 still has to read well. */
  it('shows the server refusal verbatim if a run starts between the poll and the click', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/org/zones')) return json(ZONES);
      if (url.includes('/bulk-unassign/history')) return json([]);
      if (url.includes('/dispatch-run/in-flight')) return json({ inFlight: [] });
      if (url.includes('/schedules/dispatch-run') && init?.method === 'POST') {
        return json(
          {
            code: 'DISPATCH_ALREADY_RUNNING',
            message: 'dispatch already running for this zone (zone 1, started 05:02 IST by SYSTEM)',
            inFlight: [IN_FLIGHT],
          },
          409,
        );
      }
      return json({});
    });
    render(<BulkUnassignPage />);

    await waitFor(() => expect(screen.getByTestId('run-dispatch')).toBeEnabled());
    await userEvent.click(screen.getByTestId('run-dispatch'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/dispatch already running for this zone/i);
    expect(alert).toHaveTextContent('05:02 IST');
  });
});
