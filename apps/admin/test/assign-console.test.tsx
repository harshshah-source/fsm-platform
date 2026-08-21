import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { SidebarProvider } from '../src/components/shell/SidebarContext';
import { ThemeProvider } from '../src/components/shell/ThemeContext';
import { TopBar } from '../src/components/shell/TopBar';
import { AssignConsolePage } from '../src/pages/assign/AssignConsolePage';

/**
 * #273 — the Assign Work Console, slice 1: the work pool, the running ledger, and a commit.
 *
 * **What was wrong.** Seven surfaces in this codebase could move work to an engineer and **not one
 * showed a count** — the volume arrived afterwards, in a toast. Every one of them is shaped N→1 (many
 * tickets, one engineer, written immediately, no preview and no residual) while a dispatcher's job is
 * M→N. The console is the M→N surface, and the ledger across its top is the answer to the question
 * none of the seven could answer: *how much is left?*
 *
 * **Nothing is written until commit (#272 R2)** — which is exactly what makes the residual live rather
 * than retrospective, and what lets these tests assert the arithmetic without touching a write.
 *
 * **Selection is plant-shaped in S1, deliberately.** The only write available here is `assignPlants`,
 * which takes plant ids and moves *all* of a plant's assignable work; ticket-level chips arrive with
 * #275's `assign-batch`. The consequence is load-bearing and is asserted below: at a site serving more
 * than one company, drafting one company's row draws in the whole plant, because that is what the
 * commit will do. A ledger that counted only the row the operator ticked would under-report the write
 * — the precise failure #272 R3 exists to prevent, reappearing one layer up.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const engineers = [
  { engineerId: 'se-a', name: 'Amit Yadav', coverageType: 'DEDICATED', zoneId: '1', committed: 5, dailyCapacity: 12, isActive: true },
  { engineerId: 'se-b', name: 'Karan Singh', coverageType: 'FLOATING', zoneId: '1', committed: 6, dailyCapacity: 8, isActive: true },
];

/**
 * Two companies. `Shared Works` (plant 30) is on **both** — the multi-company site that makes the
 * plant-shaped commit observable.
 */
const pool = {
  date: '2026-06-22',
  totals: { openUnassigned: 34, criticalCount: 9, heldCount: 2, plants: 4 },
  companies: [
    {
      companyId: '10',
      companyName: 'UltraTech Rajasthan',
      plants: [
        { plantId: '20', plantName: 'Kotputli Works', zoneId: '1', openUnassigned: 12, totalDevices: 38, criticalCount: 3, oldestInactivityHours: 61, heldCount: 0 },
        { plantId: '21', plantName: 'Chittorgarh Works', zoneId: '1', openUnassigned: 0, totalDevices: 31, criticalCount: 0, oldestInactivityHours: null, heldCount: 2 },
        { plantId: '30', plantName: 'Shared Works', zoneId: '1', openUnassigned: 4, totalDevices: 12, criticalCount: 1, oldestInactivityHours: 20, heldCount: 0 },
      ],
    },
    {
      companyId: '11',
      companyName: 'Acme Cement',
      plants: [
        { plantId: '22', plantName: 'Pali Works', zoneId: '1', openUnassigned: 12, totalDevices: 44, criticalCount: 4, oldestInactivityHours: 88, heldCount: 0 },
        { plantId: '30', plantName: 'Shared Works', zoneId: '1', openUnassigned: 6, totalDevices: 15, criticalCount: 1, oldestInactivityHours: 33, heldCount: 0 },
      ],
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();

function stubReads() {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/schedules/assignable-work')) return json(pool);
    if (u.includes('/schedules/engineers')) return json(engineers);
    // #274 added a third read to this page. The pool tests do not exercise candidates, but the page
    // legitimately asks for them, so the stub answers in the real shape rather than with a bare array.
    if (u.includes('/schedules/candidates')) return json({ date: pool.date, plants: [] });
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

/** Tick a plant row's checkbox in the work pool. */
async function pick(user: ReturnType<typeof userEvent.setup>, testId: string) {
  await user.click(within(screen.getByTestId(testId)).getByRole('checkbox'));
}

beforeEach(() => {
  stubReads();
  sessionStorage.setItem('fsm.accessToken', 't');
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('#273 — the work pool', () => {
  it('groups plants under their company and shows the counts a dispatcher needs before choosing', async () => {
    renderConsole();

    const row = within(await screen.findByTestId('pool-plant-10-20'));
    expect(row.getByText('Kotputli Works')).toBeInTheDocument();
    // `12 / 38` — the work against the fleet at that site, the reference point a bare 12 never gave.
    expect(row.getByText('12')).toBeInTheDocument();
    expect(row.getByText('/ 38')).toBeInTheDocument();
    expect(row.getByText(/3 crit/i)).toBeInTheDocument();
    expect(row.getByText(/61 h silent/i)).toBeInTheDocument();

    expect(screen.getByText('UltraTech Rajasthan')).toBeInTheDocument();
    expect(screen.getByText('Acme Cement')).toBeInTheDocument();
  });

  /**
   * A plant whose only outstanding work is held still appears, and says so. Left out, the console
   * would show a site as empty when it has work the operator deliberately parked — and the natural
   * next move is to go looking for work that is not missing.
   */
  it('lists a plant with nothing assignable but work held, and names the hold', async () => {
    renderConsole();

    const row = within(await screen.findByTestId('pool-plant-10-21'));
    expect(row.getByText(/2 held/i)).toBeInTheDocument();
    expect(row.getByRole('checkbox')).toBeDisabled(); // nothing to draft
  });
});

describe('#273 — the ledger', () => {
  it('opens with the zone total and nothing drafted', async () => {
    renderConsole();

    await screen.findByTestId('pool-plant-10-20');
    expect(within(screen.getByTestId('ledger-open')).getByText('34')).toBeInTheDocument();
    expect(within(screen.getByTestId('ledger-draft')).getByText('0')).toBeInTheDocument();
    expect(within(screen.getByTestId('ledger-left')).getByText('34')).toBeInTheDocument();
  });

  it('recomputes left-after-commit as work moves into the draft, before anything is written', async () => {
    const user = userEvent.setup();
    renderConsole();
    await screen.findByTestId('pool-plant-10-20');

    await pick(user, 'pool-plant-10-20'); // Kotputli, 12
    await user.click(screen.getByRole('button', { name: /add to draft/i }));

    await waitFor(() => {
      expect(within(screen.getByTestId('ledger-draft')).getByText('12')).toBeInTheDocument();
    });
    expect(within(screen.getByTestId('ledger-left')).getByText('22')).toBeInTheDocument(); // 34 − 12
    expect(within(screen.getByTestId('ledger-critical')).getByText('3')).toBeInTheDocument();

    // Nothing written — R2. The only calls so far are the two opening reads.
    expect(fetchMock.mock.calls.every(([, o]) => ((o as RequestInit | undefined)?.method ?? 'GET') === 'GET')).toBe(true);
  });

  /**
   * The multi-company site. `assignPlants` is plant-shaped, so drafting UltraTech's 4 devices at Shared
   * Works commits Acme's 6 as well. The ledger must say 10, because 10 is what the button will move.
   */
  it('counts a shared plant’s whole assignable set, because that is what the commit moves', async () => {
    const user = userEvent.setup();
    renderConsole();
    await screen.findByTestId('pool-plant-10-30');

    await pick(user, 'pool-plant-10-30'); // UltraTech's row at Shared Works: 4 of the plant's 10
    await user.click(screen.getByRole('button', { name: /add to draft/i }));

    await waitFor(() => {
      expect(within(screen.getByTestId('ledger-draft')).getByText('10')).toBeInTheDocument();
    });
    expect(within(screen.getByTestId('ledger-left')).getByText('24')).toBeInTheDocument(); // 34 − 10
    // And the operator is told why the number is bigger than the row they ticked.
    expect(screen.getByTestId('pool-plant-10-30')).toHaveTextContent(/serves 2 companies/i);
  });
});

describe('#273 — the commit', () => {
  /**
   * AC-7. Two lanes, two results. The **independence** is the point: `assignPlants` is per engineer,
   * so one lane failing says nothing about the other, and reporting a blanket failure would send a
   * dispatcher to re-do work that already landed. #275 formalises this shape with a real per-engineer
   * transaction; the result contract is deliberately already this, so that swap is invisible here.
   */
  it('reports each lane separately, and one failing lane does not condemn the other', async () => {
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      const u = String(url);
      if (u.includes('/schedules/assign-plants')) {
        const body = JSON.parse(String(opts?.body)) as { seId: string; plantIds: string[] };
        if (body.seId === 'se-b') return json({ code: 'BOOM' }, 500);
        return json({ seId: body.seId, assigned: 12, alreadyAssigned: 0, perPlant: [] });
      }
      if (u.includes('/schedules/assignable-work')) return json(pool);
      if (u.includes('/schedules/engineers')) return json(engineers);
      return json([]);
    });

    const user = userEvent.setup();
    renderConsole();
    await screen.findByTestId('pool-plant-10-20');

    // Lane 1 → Amit, Kotputli.
    await user.selectOptions(screen.getByLabelText(/engineer for lane 1/i), 'se-a');
    await pick(user, 'pool-plant-10-20');
    await user.click(within(screen.getByTestId('lane-1')).getByRole('button', { name: /add to draft/i }));

    // Lane 2 → Karan, Pali.
    await user.click(screen.getByRole('button', { name: /add engineer lane/i }));
    await user.selectOptions(screen.getByLabelText(/engineer for lane 2/i), 'se-b');
    await pick(user, 'pool-plant-11-22');
    await user.click(within(screen.getByTestId('lane-2')).getByRole('button', { name: /add to draft/i }));

    await user.click(screen.getByRole('button', { name: /^commit$/i }));

    await waitFor(() => expect(screen.getByTestId('commit-results')).toBeInTheDocument());
    expect(screen.getByTestId('result-se-a')).toHaveTextContent(/assigned 12/i);
    expect(screen.getByTestId('result-se-b')).toHaveTextContent(/failed/i);

    // One POST per lane — the plants of that lane, and no other lane's.
    const posts = fetchMock.mock.calls.filter(
      ([u, o]) => String(u).includes('/schedules/assign-plants') && (o as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(2);
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({ seId: 'se-a', plantIds: ['20'] });
    expect(JSON.parse(String((posts[1][1] as RequestInit).body))).toEqual({ seId: 'se-b', plantIds: ['22'] });
  });
});

/**
 * AC-5 — the regression pin. `Assign SE` in the top bar called `navigate('/')`: a prominent button,
 * on every manager screen, that reloaded the dashboard and opened nothing. It is the entry point to
 * this console, and this test exists so it can never quietly resolve to `/` again.
 */
describe('#273 — the top-bar entry point', () => {
  it('takes Assign SE to the console instead of the dashboard', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={zm}>
        <MemoryRouter initialEntries={['/tickets']}>
          <ThemeProvider>
            <SidebarProvider>
              <TopBar />
              <Routes>
                <Route path="/tickets" element={<p>tickets</p>} />
                <Route path="/" element={<p>dashboard</p>} />
                <Route path="/assign" element={<p>assign console</p>} />
              </Routes>
            </SidebarProvider>
          </ThemeProvider>
        </MemoryRouter>
      </AuthProvider>,
    );

    await user.click(screen.getByRole('button', { name: /assign se/i }));
    expect(await screen.findByText('assign console')).toBeInTheDocument();
    expect(screen.queryByText('dashboard')).toBeNull();
  });
});
