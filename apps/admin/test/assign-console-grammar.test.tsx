import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { AssignConsolePage } from '../src/pages/assign/AssignConsolePage';

/**
 * #290 — the Assign Work Console's approved visual grammar, actually built.
 *
 * #272 calls its grammar table **non-negotiable** and it was never implemented, so `/assign` shipped
 * with two colour collisions that make the board unreadable exactly where it matters most:
 * over-capacity rendered crimson (the reserved *critical* colour) and a tier crossing rendered amber
 * (the reserved *over-capacity* colour). An operator scanning the lanes could not tell "this engineer
 * is past their cap" from "this work is critical", which is the one distinction the board exists to
 * make.
 *
 * | Meaning | Form |
 * |---|---|
 * | Assignment inside the engineer's own coverage | solid border + dot |
 * | A human crossed a coverage tier | dashed border, violet |
 * | Critical work | heavy crimson border + flag |
 * | Over capacity | amber lane treatment — a state, never a barrier |
 *
 * **Never the same shape for two meanings**, and every meaning has to survive grayscale — which is
 * why the assertions below are on *border style and weight*, not only on colour.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const engineers = [
  { engineerId: 'se-a', name: 'Amit Yadav', coverageType: 'DEDICATED', zoneId: '1', committed: 5, dailyCapacity: 12, isActive: true },
  { engineerId: 'se-b', name: 'Karan Singh', coverageType: 'FLOATING', zoneId: '1', committed: 6, dailyCapacity: 8, isActive: true },
  { engineerId: 'se-c', name: 'Deepak Verma', coverageType: 'MULTI_PLANT', zoneId: '1', committed: 7, dailyCapacity: 10, isActive: true },
  // Already past their cap before this draft adds anything — the only way to exercise `LoadBadge`'s
  // over-capacity branch, which reads `committed`, not the draft's `after`.
  { engineerId: 'se-d', name: 'Sneha Pillai', coverageType: 'MULTI_PLANT', zoneId: '1', committed: 11, dailyCapacity: 9, isActive: true },
];

/** Sirohi carries critical work; Pali carries none — so a chip row can show the split. */
const pool = {
  date: '2026-06-22',
  totals: { openUnassigned: 18, criticalCount: 4, heldCount: 0, plants: 2 },
  companies: [
    {
      companyId: '10',
      companyName: 'UltraTech Rajasthan',
      plants: [
        { plantId: '20', plantName: 'Sirohi Works', zoneId: '1', openUnassigned: 12, totalDevices: 29, criticalCount: 4, oldestInactivityHours: 26, heldCount: 0 },
        { plantId: '21', plantName: 'Pali Works', zoneId: '1', openUnassigned: 6, totalDevices: 44, criticalCount: 0, oldestInactivityHours: 88, heldCount: 0 },
      ],
    },
  ],
};

/**
 * Pali has a passing DEDICATED candidate, so a FLOATING engineer taking Pali **is** a crossing.
 * Sirohi's only passing candidate is FLOATING, so the same engineer taking Sirohi is **not** — the
 * distinction #272 R6 requires and the reason a crossing marking means anything at all.
 */
const candidates = {
  date: '2026-06-22',
  plants: [
    {
      plantId: '20',
      plantName: 'Sirohi Works',
      zoneId: '1',
      candidates: [
        { seId: 'se-b', name: 'Karan Singh', coverageType: 'FLOATING', tierRank: 3, verdict: 'PASSED', dropReason: null, committed: 6, dailyCapacity: 8, availabilityStatus: 'AVAILABLE', kitComplete: true, missingKit: [] },
      ],
    },
    {
      plantId: '21',
      plantName: 'Pali Works',
      zoneId: '1',
      candidates: [
        { seId: 'se-a', name: 'Amit Yadav', coverageType: 'DEDICATED', tierRank: 1, verdict: 'PASSED', dropReason: null, committed: 5, dailyCapacity: 12, availabilityStatus: 'AVAILABLE', kitComplete: true, missingKit: [] },
        { seId: 'se-b', name: 'Karan Singh', coverageType: 'FLOATING', tierRank: 3, verdict: 'PASSED', dropReason: null, committed: 6, dailyCapacity: 8, availabilityStatus: 'AVAILABLE', kitComplete: true, missingKit: [] },
      ],
    },
  ],
};

const fetchMock = vi.fn();
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function stubReads() {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/schedules/assignable-work')) return json(pool);
    if (u.includes('/schedules/engineers')) return json(engineers);
    if (u.includes('/schedules/candidates')) {
      const asked = new URL(u, 'http://x').searchParams.get('plantIds')?.split(',') ?? [];
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

describe('#290 — the assign console visual grammar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReads();
  });

  const draft = async (user: ReturnType<typeof userEvent.setup>, plantName: string, seId: string) => {
    await user.click(screen.getByRole('button', { name: new RegExp(`candidates for ${plantName}`, 'i') }));
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent(plantName));
    await user.click(within(screen.getByTestId(`candidate-${seId}`)).getByRole('button', { name: /assign/i }));
  };

  /**
   * AC2, first half — the collision that mattered most. Over capacity is a **state**, not a failure
   * (#258 Q2 makes manual overload an administrative right), and rendering it in the colour reserved
   * for critical work said the opposite of what the ruling means.
   */
  it('AC2 — an over-capacity load is amber, never crimson', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await draft(user, 'Sirohi Works', 'se-b'); // 6 committed + 12 = 18, cap 8

    const load = within(screen.getByTestId('lane-1')).getByTestId('lane-load-se-b');
    expect(load).toHaveAttribute('data-over-capacity', 'true');
    expect(load.className).toContain('text-warning');
    expect(load.className).not.toContain('text-critical');
  });

  /** AC2, second half — and the over-capacity **lane** treatment the design draws and the code omitted. */
  it('AC2 — an over-capacity lane is marked as a lane, not only as a number', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await draft(user, 'Sirohi Works', 'se-b');

    const lane = screen.getByTestId('lane-1');
    expect(lane).toHaveAttribute('data-over-capacity', 'true');
    expect(lane.className).toContain('warning');
    expect(lane.className).not.toContain('critical');
  });

  /**
   * AC1 — the violet exists for exactly one meaning. Amber here would say "over capacity" about an
   * engineer who may be well under it, which is how a grammar stops being read at all.
   */
  it('AC1 — a tier crossing is violet and dashed, never amber', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await draft(user, 'Pali Works', 'se-b'); // FLOATING where a DEDICATED candidate passes

    const badge = within(screen.getByTestId('lane-1')).getByTestId('coverage-se-b-21');
    expect(badge).toHaveAttribute('data-tier-crossing', 'true');
    expect(badge.className).toContain('tier-cross');
    expect(badge.className).toContain('dashed');
    expect(badge.className).not.toContain('warning');
  });

  /**
   * AC3 — critical work is split out at chip level.
   *
   * The design draws two chips for one plant (`Kotputli Works ×3 crit` beside `Kotputli Works ×1`)
   * because they are different work: one is on a clock the other is not. A single chip totalling both
   * hides the only number an operator triages by.
   */
  it('AC3 — a plant with critical work renders a separate heavy-crimson critical chip', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await draft(user, 'Sirohi Works', 'se-b');

    const lane = screen.getByTestId('lane-1');
    const crit = within(lane).getByTestId('chip-1-20-critical');
    const rest = within(lane).getByTestId('chip-1-20');
    expect(crit).toHaveTextContent('4');
    expect(crit.className).toContain('border-2');
    expect(crit.className).toContain('critical');
    // 12 open unassigned, 4 of them critical — the remainder is its own chip, not a total.
    expect(rest).toHaveTextContent('8');
    expect(rest.className).not.toContain('border-2');
  });

  it('AC3 — a plant with no critical work renders one chip, not an empty critical one', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await draft(user, 'Pali Works', 'se-a');

    const lane = screen.getByTestId('lane-1');
    expect(within(lane).queryByTestId('chip-1-21-critical')).toBeNull();
    expect(within(lane).getByTestId('chip-1-21')).toHaveTextContent('6');
  });

  /** AC3 — the human-crossed-a-tier treatment reaches the chip, not only the coverage badge. */
  it('AC3 — a chip on a crossed tier is dashed violet', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await draft(user, 'Pali Works', 'se-b');

    const chip = within(screen.getByTestId('lane-1')).getByTestId('chip-1-21');
    expect(chip).toHaveAttribute('data-tier-crossing', 'true');
    expect(chip.className).toContain('dashed');
    expect(chip.className).toContain('tier-cross');
  });

  /** AC4 — the legend the design puts under the lanes, and which was rendered nowhere. */
  it('AC4 — the legend renders its three swatches', async () => {
    renderConsole();
    const legend = await screen.findByTestId('grammar-legend');

    expect(within(legend).getByTestId('swatch-own')).toBeInTheDocument();
    expect(within(legend).getByTestId('swatch-crossing')).toBeInTheDocument();
    expect(within(legend).getByTestId('swatch-critical')).toBeInTheDocument();
    expect(legend).toHaveTextContent(/own coverage/i);
    expect(legend).toHaveTextContent(/crossed a coverage tier/i);
    expect(legend).toHaveTextContent(/critical/i);
  });

  /**
   * AC6 — the grayscale test, stated as the property rather than as a colour.
   *
   * Three meanings, three *shapes*: solid 1px, dashed, solid 2px. If two of them ever collapse to the
   * same border the grammar is colour-only, and an operator with deuteranopia — or a printed board —
   * loses the distinction entirely.
   */
  it('AC6 — the three swatches differ by border, not only by colour', async () => {
    renderConsole();
    const legend = await screen.findByTestId('grammar-legend');

    const shape = (id: string) => {
      const cls = within(legend).getByTestId(id).className;
      return [cls.includes('border-2') ? 'heavy' : 'thin', cls.includes('dashed') ? 'dashed' : 'solid'].join('-');
    };
    const shapes = [shape('swatch-own'), shape('swatch-crossing'), shape('swatch-critical')];
    expect(new Set(shapes).size).toBe(3);
  });

  /**
   * AC5 — the ledger's fifth cell. The four numbers beside it answer "how much work"; this one answers
   * "what should worry you about this draft", and it was missing entirely.
   */
  it('AC5 — the ledger summary cell counts over-capacity lanes, crossings and no-coverage plants', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await draft(user, 'Sirohi Works', 'se-b'); // takes se-b to 18 / 8 — over capacity
    await draft(user, 'Pali Works', 'se-b'); // FLOATING under a passing DEDICATED — a crossing

    const tags = screen.getByTestId('ledger-summary');
    expect(tags).toHaveTextContent(/1 engineer over capacity/i);
    expect(tags).toHaveTextContent(/1 tier crossing/i);
  });

  it('AC5 — the summary cell says nothing when a draft is clean', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await draft(user, 'Pali Works', 'se-a'); // DEDICATED, 5 + 6 = 11 of 12 — under cap, no crossing

    const tags = screen.getByTestId('ledger-summary');
    expect(tags).not.toHaveTextContent(/over capacity/i);
    expect(tags).not.toHaveTextContent(/tier crossing/i);
  });

  /**
   * AC2 — the same collision lived in `LoadBadge`, which is the console's own lane-header load **and**
   * the badge six other surfaces use. Amber there too: one grammar, or the operator has to learn which
   * screen they are on before they can read a colour.
   */
  it('AC2 — the shared load badge marks over capacity in amber, not crimson', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await user.selectOptions(screen.getByLabelText(/engineer for lane 1/i), 'se-d'); // 11 of 9

    const wrapper = screen.getByTestId('load-se-d');
    expect(wrapper).toHaveAttribute('data-over-capacity', 'true');
    const badge = within(wrapper).getByText(/11/);
    expect(badge.className).toContain('warning');
    expect(badge.className).not.toContain('critical');
  });

  /**
   * AC1 — and the review screen, which is the last thing an operator reads before writing. It carried
   * the amber crossing too; a grammar that changes at the moment of commitment is not a grammar.
   */
  it('AC1 — the review screen renders a crossing in violet, not amber', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await draft(user, 'Pali Works', 'se-b');
    await user.click(screen.getByRole('button', { name: /review.*commit/i }));

    const crossing = await screen.findByText(/tier crossed/i);
    const badge = crossing.closest('span');
    expect(badge?.className).toContain('tier-cross');
    expect(badge?.className).not.toContain('warning');
  });

  /** AC7 — visual only. Nothing about the grammar may change who can do what, or gate a commit. */
  it('AC7 — an over-capacity, tier-crossing draft is still fully committable', async () => {
    const user = userEvent.setup();
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('candidate-plant')).toHaveTextContent('Sirohi Works'));

    await draft(user, 'Sirohi Works', 'se-b');
    await draft(user, 'Pali Works', 'se-b');

    expect(screen.getByRole('button', { name: /review.*commit/i })).toBeEnabled();
  });
});
