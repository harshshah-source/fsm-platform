import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ScheduleDetailPage } from '../src/pages/schedules/ScheduleDetailPage';

/**
 * #289 AC5 — the impact preview between the override choice and the commit.
 *
 * **Operator ruling, 2026-08-25:** the panel lives on Schedule Detail, not the cockpit. The cockpit
 * carries no override controls — it links out to `/schedules/:engineerId`, which is where a manager
 * actually chooses a move — so building move controls into `/dispatch/today` would duplicate an
 * existing surface, which #282 R5 forbids.
 *
 * The seam under test is the page: what a manager sees after picking a target SE, and what the page
 * asks the backend for. The projection itself is the backend's spec (`override-projection.service`);
 * nothing here re-derives capacity, rank or route.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const ENGINEERS = [
  {
    engineerId: 'se-north-1',
    name: 'Ramesh',
    coverageType: 'MULTI_PLANT',
    zoneId: '1',
    committed: 7,
    dailyCapacity: 8,
    isActive: true,
  },
  {
    engineerId: 'se-north-2',
    name: 'Sneha',
    coverageType: 'MULTI_PLANT',
    zoneId: '1',
    committed: 5,
    dailyCapacity: 6,
    isActive: true,
  },
  {
    engineerId: 'se-north-3',
    name: 'Anil',
    coverageType: 'MULTI_PLANT',
    zoneId: '1',
    committed: 2,
    dailyCapacity: 6,
    isActive: true,
  },
];

/** Every projection request the page made, newest last. */
const previewCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/override/preview'));

/** Every *commit* — the write. `/override/preview` contains `/override`, so it is excluded by name. */
const commitCalls = () =>
  fetchMock.mock.calls.filter(
    ([url]) => String(url).includes('/override') && !String(url).includes('/override/preview'),
  );

const DETAIL = {
  scheduleId: '10',
  seId: 'se-north-1',
  seName: 'Ramesh',
  status: 'AUTO_ASSIGNED',
  dateFrom: '2026-08-25',
  dateTo: '2026-08-25',
  stops: [
    {
      batchId: '100',
      stopSequence: 1,
      plantId: '7',
      plantName: 'Pune Depot',
      status: 'AUTO_ASSIGNED',
      deviceCount: 2,
      tickets: [
        { ticketId: 'tkt-1', sortOrder: 1, slaBucket: null, companyTier: null, partialRecovery: false, reasoning: null },
        { ticketId: 'tkt-2', sortOrder: 2, slaBucket: null, companyTier: null, partialRecovery: false, reasoning: null },
      ],
    },
  ],
};

/** The backend's `OverrideImpact` for a one-ticket Ramesh → Sneha move; the design's step-3 example. */
function impact(over: Partial<Record<string, unknown>> = {}) {
  return {
    result: 'OK',
    action: 'REASSIGN',
    batchId: '100',
    plantId: '7',
    plantName: 'Pune Depot',
    ticketIds: ['tkt-1'],
    from: { seId: 'se-north-1', seName: 'Ramesh', committed: 7, after: 6, dailyCapacity: 8, overCapacity: false },
    to: { seId: 'se-north-2', seName: 'Sneha', committed: 5, after: 6, dailyCapacity: 6, overCapacity: true },
    rank: {
      ticketId: 'tkt-1',
      runId: '900',
      processingRank: 3,
      chosenSeId: 'se-north-1',
      targetPrecedenceRank: 2,
      targetVerdict: 'PASSED',
      targetDropReason: null,
    },
    route: { targetScheduleId: '11', appendedAsStop: 3, joinsExistingStop: false, reordersExistingStops: false },
    conflicts: { onSite: [], deferred: [] },
    ...over,
  };
}

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Preview is matched *before* the commit route — `/override/preview` also contains `/override`. */
function stub(preview: () => Response = () => json(impact())) {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    if (u.includes('/schedules/engineers')) return json(ENGINEERS);
    if (u.includes('/override/preview')) return preview();
    if (u.includes('/override')) {
      return json({ result: 'OK', batchId: '100', scheduleId: '10', seId: 'se-north-1', status: 'OVERRIDDEN' });
    }
    return json(DETAIL);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={['/schedules/se-north-1']}>
        <Routes>
          <Route path="/schedules/:engineerId" element={<ScheduleDetailPage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

/** Open the per-ticket Reassign panel and pick the target — the impact is a function of the target. */
async function openReassign(target = 'se-north-2') {
  const row = within(await screen.findByTestId('ticket-row-tkt-1'));
  await userEvent.click(row.getByRole('button', { name: /^reassign$/i }));
  await userEvent.selectOptions(await row.findByLabelText(/target se/i), target);
  return row;
}

beforeEach(() => stub());

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('#289 — capacity impact, both lanes', () => {
  it('shows each engineer committed → after against their cap once a target is chosen', async () => {
    renderPage();
    await openReassign();

    const panel = within(await screen.findByTestId('override-impact'));
    expect(panel.getByTestId('impact-lane-se-north-1')).toHaveTextContent('Ramesh');
    expect(panel.getByTestId('impact-lane-se-north-1')).toHaveTextContent('7/8 → 6/8');
    expect(panel.getByTestId('impact-lane-se-north-2')).toHaveTextContent('Sneha');
    expect(panel.getByTestId('impact-lane-se-north-2')).toHaveTextContent('5/6 → 6/6');
  });
});

describe('#289 — over capacity is stated, never a barrier (#258 Q2 · #290)', () => {
  it('marks the lane the move fills without disabling Confirm', async () => {
    renderPage();
    const row = await openReassign();

    const lane = await screen.findByTestId('impact-lane-se-north-2');
    // Marked as state, and not by colour alone — a tone-only treatment tells a screen reader nothing.
    expect(lane).toHaveAttribute('data-over-capacity', 'true');
    expect(within(lane).getByTitle(/still allowed/i)).toBeInTheDocument();
    // The lane the work leaves is not marked: the move empties it.
    expect(screen.getByTestId('impact-lane-se-north-1')).toHaveAttribute('data-over-capacity', 'false');

    // #258 Q2 — manual overload is an administrative right. The preview reports it and stops there.
    await userEvent.type(row.getByLabelText(/reason/i), 'closer se');
    expect(row.getByRole('button', { name: /confirm reassign/i })).toBeEnabled();
  });
});

describe('#289 — system view: where the run ranked the target', () => {
  it("states the target's rank in the run that placed the ticket, and links to that run", async () => {
    renderPage();
    await openReassign();

    const view = await screen.findByTestId('impact-rank');
    expect(view).toHaveTextContent(/Sneha ranked #2/i);
    expect(within(view).getByRole('link', { name: /run 900/i })).toHaveAttribute('href', '/dispatch-runs/900');
  });

  it('says nothing at all when the run recorded no rank for the target — unknown is not "unranked"', async () => {
    stub(() =>
      json(
        impact({
          rank: {
            ticketId: 'tkt-1',
            runId: '900',
            processingRank: null,
            chosenSeId: 'se-north-1',
            targetPrecedenceRank: null,
            targetVerdict: null,
            targetDropReason: null,
          },
        }),
      ),
    );
    renderPage();
    await openReassign();

    await screen.findByTestId('override-impact');
    expect(screen.queryByTestId('impact-rank')).toBeNull();
    expect(screen.queryByText(/unranked|not ranked|#0/i)).toBeNull();
  });

  it('says nothing when the ticket has no run behind it at all', async () => {
    stub(() => json(impact({ rank: null })));
    renderPage();
    await openReassign();

    await screen.findByTestId('override-impact');
    expect(screen.queryByTestId('impact-rank')).toBeNull();
  });
});

describe('#289 — route effect', () => {
  it('states which stop the work lands on, and that existing stops keep their order', async () => {
    renderPage();
    await openReassign();

    const route = await screen.findByTestId('impact-route');
    expect(route).toHaveTextContent(/stop 3/i);
    expect(route).toHaveTextContent(/not reordered/i);
  });

  it('says the work joins a stop the target already makes, rather than adding one', async () => {
    stub(() =>
      json(
        impact({
          route: { targetScheduleId: '11', appendedAsStop: 2, joinsExistingStop: true, reordersExistingStops: false },
        }),
      ),
    );
    renderPage();
    await openReassign();

    const route = await screen.findByTestId('impact-route');
    expect(route).toHaveTextContent(/joins/i);
    expect(route).toHaveTextContent(/stop 2/i);
    expect(route).toHaveTextContent(/Pune Depot/);
  });

  it('says the move opens the target a day plan when they have none', async () => {
    stub(() =>
      json(
        impact({
          route: { targetScheduleId: null, appendedAsStop: 1, joinsExistingStop: false, reordersExistingStops: false },
        }),
      ),
    );
    renderPage();
    await openReassign();

    expect(await screen.findByTestId('impact-route')).toHaveTextContent(/opens a new day plan/i);
  });
});

describe('#289 — conflicts the confirm will gate on', () => {
  it('says plainly when there are none', async () => {
    renderPage();
    await openReassign();

    expect(await screen.findByTestId('impact-conflicts')).toHaveTextContent(/none/i);
  });

  it('names the tickets held to a return date, and still leaves the move available', async () => {
    stub(() => json(impact({ conflicts: { onSite: [], deferred: ['tkt-1'] } })));
    renderPage();
    const row = await openReassign();

    const conflicts = await screen.findByTestId('impact-conflicts');
    expect(conflicts).toHaveTextContent(/return-date hold/i);
    expect(conflicts).toHaveTextContent('tkt-1');
    // Reported, not enforced: both gates are confirm-and-reason on the write, never refusals.
    await userEvent.type(row.getByLabelText(/reason/i), 'vehicle back early');
    expect(row.getByRole('button', { name: /confirm reassign/i })).toBeEnabled();
  });

  it('names on-site work when the backend reports it', async () => {
    stub(() => json(impact({ conflicts: { onSite: ['tkt-1'], deferred: [] } })));
    renderPage();
    await openReassign();

    const conflicts = await screen.findByTestId('impact-conflicts');
    expect(conflicts).toHaveTextContent(/on[- ]site/i);
    expect(conflicts).toHaveTextContent('tkt-1');
  });
});

describe('#289 — the preview is a function of the target', () => {
  it('asks for nothing until a target SE is chosen', async () => {
    renderPage();
    const row = within(await screen.findByTestId('ticket-row-tkt-1'));
    await userEvent.click(row.getByRole('button', { name: /^reassign$/i }));

    await row.findByLabelText(/target se/i);
    expect(previewCalls()).toHaveLength(0);
    expect(screen.queryByTestId('override-impact')).toBeNull();
  });

  it('sends the identical body the confirm takes, to the batch being moved', async () => {
    renderPage();
    await openReassign();
    await screen.findByTestId('override-impact');

    expect(previewCalls()).toHaveLength(1);
    const [url, opts] = previewCalls()[0];
    expect(String(url)).toContain('/batches/100/override/preview');
    expect((opts as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((opts as RequestInit).body))).toEqual({
      action: 'REASSIGN',
      ticketId: 'tkt-1',
      newSeId: 'se-north-2',
      reasonCode: '',
    });
    // A preview is not a write: nothing was committed by opening one.
    expect(commitCalls()).toHaveLength(0);
  });

  it('re-projects when the target changes, and not when the reason is typed', async () => {
    renderPage();
    const row = await openReassign();
    await screen.findByTestId('override-impact');

    await userEvent.type(row.getByLabelText(/reason/i), 'closer se');
    expect(previewCalls()).toHaveLength(1);

    await userEvent.selectOptions(row.getByLabelText(/target se/i), 'se-north-3');
    await waitFor(() => expect(previewCalls()).toHaveLength(2));
    expect(JSON.parse(String((previewCalls()[1][1] as RequestInit).body))).toMatchObject({
      newSeId: 'se-north-3',
    });
  });
});

describe('#289 — the same preview on all three move panels', () => {
  it('projects a whole-batch Swap SE', async () => {
    renderPage();
    const stop = within((await screen.findAllByTestId('schedule-stop'))[0]);
    await userEvent.click(stop.getByRole('button', { name: /swap se/i }));
    await userEvent.selectOptions(await stop.findByLabelText(/target se/i), 'se-north-2');

    await screen.findByTestId('override-impact');
    expect(JSON.parse(String((previewCalls()[0][1] as RequestInit).body))).toEqual({
      action: 'SWAP_SE',
      newSeId: 'se-north-2',
      reasonCode: '',
    });
    expect(commitCalls()).toHaveLength(0);
  });

  it('projects a Split only once there is work to move, and re-projects when the selection changes', async () => {
    renderPage();
    const stop = within((await screen.findAllByTestId('schedule-stop'))[0]);
    await userEvent.click(stop.getByRole('button', { name: /split batch/i }));

    // A target with no tickets ticked moves nothing — there is nothing to project.
    await userEvent.selectOptions(await stop.findByLabelText(/target se/i), 'se-north-2');
    expect(previewCalls()).toHaveLength(0);

    await userEvent.click(within(stop.getByTestId('ticket-row-tkt-2')).getByRole('checkbox'));
    await screen.findByTestId('override-impact');
    expect(JSON.parse(String((previewCalls()[0][1] as RequestInit).body))).toEqual({
      action: 'SPLIT_BATCH',
      ticketIds: ['tkt-2'],
      newSeId: 'se-north-2',
      reasonCode: '',
    });

    // Which work moves is as much the projection's input as who it moves to.
    await userEvent.click(within(stop.getByTestId('ticket-row-tkt-1')).getByRole('checkbox'));
    await waitFor(() => expect(previewCalls()).toHaveLength(2));
    expect(JSON.parse(String((previewCalls()[1][1] as RequestInit).body))).toMatchObject({
      ticketIds: ['tkt-2', 'tkt-1'],
    });
  });

  it('never projects the one-lane actions — Remove and Defer move no work between engineers', async () => {
    renderPage();
    const row = within(await screen.findByTestId('ticket-row-tkt-1'));

    await userEvent.click(row.getByRole('button', { name: /^remove$/i }));
    await userEvent.click(row.getByRole('button', { name: /^defer$/i }));

    expect(previewCalls()).toHaveLength(0);
    expect(screen.queryByTestId('override-impact')).toBeNull();
  });
});

describe('#289 — the preview is an aid, never a gate (AC4)', () => {
  it('leaves the move available when the projection itself fails', async () => {
    stub(() => json({ code: 'INTERNAL' }, 500));
    renderPage();
    const row = await openReassign();
    await userEvent.type(row.getByLabelText(/reason/i), 'closer se');

    // No panel, no error surface, and no lost Confirm: a manager whose projection failed is not
    // thereby forbidden a move they are entitled to make.
    expect(screen.queryByTestId('override-impact')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(row.getByRole('button', { name: /confirm reassign/i })).toBeEnabled();

    await userEvent.click(row.getByRole('button', { name: /confirm reassign/i }));
    await waitFor(() => expect(commitCalls()).toHaveLength(1));
  });

  it('still re-presents a lost race as the clean conflict banner, not an error page', async () => {
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      const u = String(url);
      if (u.includes('/schedules/engineers')) return json(ENGINEERS);
      if (u.includes('/override/preview')) return json(impact());
      if (u.includes('/override')) {
        const body = JSON.parse(String(opts?.body)) as { confirm?: boolean };
        if (!body.confirm) {
          return json(
            {
              code: 'OVERRIDE_ON_SITE_CONFLICT',
              message: 'SE holds ON_SITE on affected work — resend with confirm=true and a reason code.',
              ticketIds: ['tkt-1'],
            },
            409,
          );
        }
        return json({ result: 'OK', batchId: '100', scheduleId: '10', seId: 'se-north-1', status: 'OVERRIDDEN' });
      }
      return json(DETAIL);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    const row = await openReassign();
    await screen.findByTestId('override-impact');
    await userEvent.type(row.getByLabelText(/reason/i), 'closer se');
    await userEvent.click(row.getByRole('button', { name: /confirm reassign/i }));

    const banner = await screen.findByTestId('onsite-conflict-banner');
    expect(banner).toHaveTextContent('tkt-1');
    // The conflict is the commit's, and it is answered on the commit — the preview took no part in it.
    await userEvent.click(within(banner).getByRole('button', { name: /confirm override/i }));
    await waitFor(() =>
      expect(commitCalls().some(([, o]) => String((o as RequestInit).body).includes('"confirm":true'))).toBe(true),
    );
  });
});

describe('#289 — the panel names the move it is projecting', () => {
  it('states which work moves, between whom, and that it will be recorded as a human decision', async () => {
    renderPage();
    await openReassign();

    const header = within(await screen.findByTestId('impact-header'));
    expect(header.getByText(/Ramesh → Sneha/)).toBeInTheDocument();
    expect(header.getByText(/1 ticket/i)).toBeInTheDocument();
    // #283's grammar — a human decision never looks like a system one, and the panel says so before
    // the write, not only after it.
    expect(header.getByText(/human override/i)).toBeInTheDocument();
  });
});
