import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { AssignConsolePage } from '../src/pages/assign/AssignConsolePage';

/**
 * #274 — the Assign Work Console's candidate column, the coverage badges on lanes, and the load the
 * draft is about to add.
 *
 * **What was wrong.** Every manual picker in this app shows a name and nothing else, and the one that
 * shows coverage shows the engineer's *global* `engineer_master.coverage_type` — which for a
 * MULTI_PLANT engineer says nothing at all about whether they cover the plants being assigned. The
 * per-pair answer (`se_coverage`) and the engine's own ordered eligibility list
 * (`orderedCandidatesForPlant`) existed the whole time; no admin surface could reach either.
 * `dailyCapacity` shipped on two row types and was rendered in exactly zero places until #269.
 *
 * **Three things this column must not do**, each pinned below: re-sort the engine's order into
 * something friendlier, hide the candidates the hard filters dropped, or turn a capacity marking into
 * a gate. The first teaches a false model of dispatch; the second answers "why not them?" with
 * silence; the third contradicts #258 Q2, which rules manual overload an administrative right.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

// `committed` / `dailyCapacity` are identical to the candidate payload's on purpose: both come from
// #269's single `committedDayLoad` definition on the backend, and the console would be showing two
// different answers to one question if they ever diverged (pinned backend-side by AC-4's spec).
const engineers = [
  { engineerId: 'se-a', name: 'Amit Yadav', coverageType: 'DEDICATED', zoneId: '1', committed: 5, dailyCapacity: 12, isActive: true },
  { engineerId: 'se-b', name: 'Karan Singh', coverageType: 'FLOATING', zoneId: '1', committed: 12, dailyCapacity: 8, isActive: true },
  { engineerId: 'se-c', name: 'Deepak Verma', coverageType: 'MULTI_PLANT', zoneId: '1', committed: 7, dailyCapacity: 10, isActive: true },
  { engineerId: 'se-d', name: 'Sneha Pillai', coverageType: 'MULTI_PLANT', zoneId: '1', committed: 11, dailyCapacity: 9, isActive: true },
];

/** Two sites, so the column has somewhere to move focus to and a lane can span differing tiers. */
const pool = {
  date: '2026-06-22',
  totals: { openUnassigned: 18, criticalCount: 3, heldCount: 0, plants: 2 },
  companies: [
    {
      companyId: '10',
      companyName: 'UltraTech Rajasthan',
      plants: [
        { plantId: '20', plantName: 'Sirohi Works', zoneId: '1', openUnassigned: 12, totalDevices: 29, criticalCount: 2, oldestInactivityHours: 26, heldCount: 0 },
        { plantId: '21', plantName: 'Pali Works', zoneId: '1', openUnassigned: 6, totalDevices: 44, criticalCount: 1, oldestInactivityHours: 88, heldCount: 0 },
      ],
    },
  ],
};

/**
 * Sirohi has no dedicated engineer, a dropped multi-plant one, and three floating candidates — the
 * exact shape the approved design draws, because it is the shape that makes every rule visible at
 * once: an empty tier, a drop with a reason, an over-capacity candidate, and a passing one.
 *
 * Pali is deliberately covered by `se-c` at a **stronger** tier than Sirohi is, so a lane holding
 * both plants must show two different badges.
 */
const candidates = {
  date: '2026-06-22',
  plants: [
    {
      plantId: '20',
      plantName: 'Sirohi Works',
      zoneId: '1',
      candidates: [
        { seId: 'se-d', name: 'Sneha Pillai', coverageType: 'MULTI_PLANT', tierRank: 2, verdict: 'DROPPED', dropReason: 'SE_UNAVAILABLE', committed: 11, dailyCapacity: 9, availabilityStatus: 'ON_LEAVE', kitComplete: true, missingKit: [] },
        { seId: 'se-b', name: 'Karan Singh', coverageType: 'FLOATING', tierRank: 3, verdict: 'DROPPED', dropReason: 'OVER_CAPACITY', committed: 12, dailyCapacity: 8, availabilityStatus: 'AVAILABLE', kitComplete: true, missingKit: [] },
        { seId: 'se-c', name: 'Deepak Verma', coverageType: 'FLOATING', tierRank: 3, verdict: 'PASSED', dropReason: null, committed: 7, dailyCapacity: 10, availabilityStatus: 'AVAILABLE', kitComplete: false, missingKit: ['SIM', 'Antenna'] },
      ],
    },
    {
      plantId: '21',
      plantName: 'Pali Works',
      zoneId: '1',
      candidates: [
        { seId: 'se-a', name: 'Amit Yadav', coverageType: 'DEDICATED', tierRank: 1, verdict: 'PASSED', dropReason: null, committed: 5, dailyCapacity: 12, availabilityStatus: 'AVAILABLE', kitComplete: true, missingKit: [] },
        { seId: 'se-c', name: 'Deepak Verma', coverageType: 'MULTI_PLANT', tierRank: 2, verdict: 'PASSED', dropReason: null, committed: 7, dailyCapacity: 10, availabilityStatus: 'AVAILABLE', kitComplete: false, missingKit: ['SIM', 'Antenna'] },
        { seId: 'se-b', name: 'Karan Singh', coverageType: 'FLOATING', tierRank: 3, verdict: 'DROPPED', dropReason: 'OVER_CAPACITY', committed: 12, dailyCapacity: 8, availabilityStatus: 'AVAILABLE', kitComplete: true, missingKit: [] },
      ],
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();

/** Records every `plantIds` the page asked for, so a test can assert what it fetched and when. */
const requestedPlantIds: string[][] = [];

function stubReads() {
  requestedPlantIds.length = 0;
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/schedules/assignable-work')) return json(pool);
    if (u.includes('/schedules/engineers')) return json(engineers);
    if (u.includes('/schedules/candidates')) {
      const asked = new URL(u, 'http://x').searchParams.get('plantIds')?.split(',') ?? [];
      requestedPlantIds.push(asked);
      return json({ date: candidates.date, plants: candidates.plants.filter((p) => asked.includes(p.plantId)) });
    }
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderConsole() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter>
        <AssignConsolePage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

const column = () => screen.getByTestId('candidate-column');

describe('#274 — assign console candidate column', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReads();
  });

  /**
   * Slice A1 — the column is the engine's list, tier-grouped, **in the order it arrived**.
   *
   * The order assertion is the load-bearing one. The server publishes
   * `orderedCandidatesForPlant`'s exact sequence (pinned by the backend spec beside this one) and the
   * column's only job is to group it under headings without disturbing it. Sorting by name, or by
   * load, would render a ranking the engine does not use — the false model #266 was sequenced ahead
   * of this issue to prevent.
   *
   * All three tier headings render whether or not they are populated: "no dedicated engineer for this
   * plant" is a fact the operator needs in order to read the floating candidate below it as the
   * fallback it is, and a heading that vanished when empty would leave that fact unsaid.
   */
  it('groups candidates under all three tiers, in the engine order, naming the empty one', async () => {
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    expect(within(column()).getByTestId('tier-DEDICATED')).toHaveTextContent('Dedicated');
    expect(within(column()).getByTestId('tier-DEDICATED')).toHaveTextContent(/no dedicated engineer/i);
    expect(within(column()).getByTestId('tier-MULTI_PLANT')).toHaveTextContent('Sneha Pillai');

    const rendered = within(column())
      .getAllByTestId(/^candidate-se-/)
      .map((el) => el.getAttribute('data-se-id'));
    expect(rendered).toEqual(['se-d', 'se-b', 'se-c']);
  });
  /**
   * Slice A2 — **AC-3 and AC-5.** Dropped candidates are shown with the reason; an over-capacity one
   * is marked *and* still selectable.
   *
   * The two halves belong in one test because together they are the column's whole posture. The
   * engine drops an over-capacity engineer — `applyHardFilters` returns `OVER_CAPACITY` and dispatch
   * will not pick them — while #258 **Q2** rules that a human may. So the row has to say both things
   * at once and let the operator act: the verdict is the engine's, the "still assignable" marking is
   * the operator's permission, and nothing on the row is disabled.
   *
   * A row that hid the drop would answer "why not them?" with silence. A row that dropped the marking
   * would leave the operator to discover the overload after committing. A row that *disabled* itself
   * would be the front-end quietly reinstating the gate Q2 removed — which is why the assertion here
   * is on the click doing something, not merely on an `aria-disabled` attribute.
   */
  it('shows dropped candidates with their reason, and an over-capacity one stays clickable', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    // Dropped, present, and reasoned — the operator's "why not them?" answered on the row.
    const onLeave = within(column()).getByTestId('candidate-se-d');
    expect(onLeave).toHaveAttribute('data-verdict', 'DROPPED');
    expect(onLeave).toHaveTextContent(/dropped/i);
    expect(onLeave).toHaveTextContent(/not available/i);

    // Over capacity: dropped by the engine, marked as still assignable for the human, load shown.
    const over = within(column()).getByTestId('candidate-se-b');
    expect(over).toHaveAttribute('data-verdict', 'DROPPED');
    expect(over).toHaveTextContent(/at or over capacity/i);
    expect(over).toHaveTextContent(/still assignable/i);
    expect(within(over).getByTestId('load-se-b')).toHaveAttribute('data-over-capacity', 'true');

    // A passing candidate short of kit is a warning, not a drop — `commonKitComplete` is only a drop
    // when it is false at filter time, and this one passed, so the count is advice.
    const passing = within(column()).getByTestId('candidate-se-c');
    expect(passing).toHaveAttribute('data-verdict', 'PASSED');
    expect(passing).toHaveTextContent(/kit short .2/i);

    // ...and the over-capacity engineer can actually be chosen. Not a disabled-attribute assertion:
    // the click has to move work, or "selectable" is a claim the screen does not honour.
    await user.click(within(over).getByRole('button', { name: /assign/i }));
    const lane = await screen.findByTestId('lane-1');
    expect(within(lane).getByLabelText(/engineer for lane/i)).toHaveValue('se-b');
    expect(within(lane).getByTestId('chip-1-20')).toBeInTheDocument();
  });

  /**
   * Slice A3 — focus follows the plant the operator is working on (#274 item 2).
   *
   * A column pinned to one plant would answer the wrong question the moment the dispatcher moved on,
   * and — worse — would keep looking authoritative while doing it. Coverage is a *per-plant* fact:
   * the same engineer is dedicated at one site and floating at the next, which is the entire reason
   * `AssignSePanel`'s global `coverage_type` badge is misleading enough to be worth replacing.
   *
   * The request is asserted alongside the render because the column can only be right about a plant
   * it actually asked the server about.
   */
  it('re-answers for the plant the operator focuses', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await user.click(screen.getByRole('button', { name: /candidates for pali works/i }));

    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Pali Works'));
    expect(requestedPlantIds.some((ids) => ids.includes('21'))).toBe(true);
    expect(within(column()).getByTestId('tier-DEDICATED')).toHaveTextContent('Amit Yadav');
    expect(within(column()).queryByTestId('candidate-se-d')).toBeNull();
  });

  /** Focus a plant, then hand it to `seId` from the candidate column — the operator's real path. */
  const draft = async (user: ReturnType<typeof userEvent.setup>, plantName: string, seId: string) => {
    await user.click(screen.getByRole('button', { name: new RegExp(`candidates for ${plantName}`, 'i') }));
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent(plantName));
    await user.click(within(screen.getByTestId(`candidate-${seId}`)).getByRole('button', { name: /assign/i }));
  };

  /**
   * Slice A4 — **AC-6.** Coverage is per (engineer, plant), so a lane spanning two plants shows two
   * badges when the tiers differ.
   *
   * This is decision #272 **R4** and the reason it exists: `AssignSePanel` shows
   * `engineer_master.coverage_type`, one global value, which for a multi-plant engineer answers a
   * question nobody asked. Deepak Verma is *floating* at Sirohi and *multi-plant* at Pali — one lane,
   * one engineer, two different coverage facts — and a single badge would have to be wrong about one
   * of them.
   */
  it('shows a coverage badge per plant on a lane spanning two tiers', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await draft(user, 'Sirohi Works', 'se-c');
    await draft(user, 'Pali Works', 'se-c');

    const lane = screen.getByTestId('lane-1');
    expect(within(lane).getByTestId('coverage-se-c-20')).toHaveTextContent(/floating/i);
    expect(within(lane).getByTestId('coverage-se-c-20')).toHaveTextContent(/sirohi/i);
    expect(within(lane).getByTestId('coverage-se-c-21')).toHaveTextContent(/multi-plant/i);
    expect(within(lane).getByTestId('coverage-se-c-21')).toHaveTextContent(/pali/i);
  });

  /**
   * Slice A5 — **AC-7.** A tier crossing is marked and never blocked.
   *
   * #258 **Q1** rules dedicated → multi-plant → floating inviolable *for the system*; #272 **R6** adds
   * that a human may cross it but must see the tier they are crossing. So the marking is a
   * per-(engineer, plant) comparison against the best tier still **passing** at that plant, not
   * against the tier list in the abstract — and the distinction is what this test turns on.
   *
   * Handing Pali to a floating engineer while Amit Yadav is dedicated and passing is a crossing.
   * Handing Sirohi to the same floating engineer is **not**: the only higher-tier candidate there was
   * dropped, so floating is the top of the reachable list and nothing has been overridden. A naive
   * `tierRank > 1` rule would flag both and teach the operator to ignore the marking.
   */
  it('marks a tier crossing without blocking it, and does not cry crossing when no higher tier passes', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await draft(user, 'Pali Works', 'se-b');
    await draft(user, 'Sirohi Works', 'se-b');

    const lane = screen.getByTestId('lane-1');
    expect(within(lane).getByTestId('coverage-se-b-21')).toHaveAttribute('data-tier-crossing', 'true');
    expect(within(lane).getByTestId('coverage-se-b-20')).toHaveAttribute('data-tier-crossing', 'false');

    // Marked, not barred. The console still lets the operator move to review.
    expect(screen.getByRole('button', { name: /review.*commit/i })).toBeEnabled();
  });

  /**
   * Slice A6 — the load the draft is about to add: `committed → after / capacity`.
   *
   * `dailyCapacity` has been on these rows since Issue 13b and was rendered nowhere until #269 gave it
   * a numerator. What #269 could not give it is the *third* number: an assign surface shows what the
   * engineer carries now, and the one thing the dispatcher needs before committing is what they will
   * carry after. Nothing is written until commit, so the after-figure is arithmetic over the draft.
   *
   * Amber at `after >= capacity`, matching `isOverCapacity` and therefore matching the recommender's
   * own `OVER_CAPACITY` boundary — the same `>=`-not-`>` call #269 recorded, for the same reason: a
   * lane that showed room at exactly `10 / 10` would disagree with the engine it is mirroring.
   */
  it('shows committed to after over capacity on the lane, and marks the overload', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await draft(user, 'Sirohi Works', 'se-c');
    await draft(user, 'Pali Works', 'se-c');

    // 7 committed + 12 at Sirohi + 6 at Pali = 25, against a capacity of 10.
    const load = within(screen.getByTestId('lane-1')).getByTestId('lane-load-se-c');
    expect(load).toHaveTextContent('7');
    expect(load).toHaveTextContent('25');
    expect(load).toHaveTextContent('10');
    expect(load).toHaveAttribute('data-over-capacity', 'true');
  });

});
