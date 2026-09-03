import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchRunsPage } from '../src/pages/dispatch/DispatchRunsPage';
import { IntradayQueuePage } from '../src/pages/schedules/IntradayQueuePage';
import { ScheduleDetailPage } from '../src/pages/schedules/ScheduleDetailPage';
import { SchedulesPage } from '../src/pages/schedules/SchedulesPage';
import { addIsoDays, istIsoDate } from '../src/lib/datetime';

/**
 * #281 AC2/AC3/AC8 (#280 R2/R5/R8/R9) — the dispatch timeline read as one concept from the other
 * three surfaces.
 *
 * Two mechanisms, deliberately distinct:
 *  - every surface **states its own question** in visible copy, and names the other three by the
 *    question they answer rather than by page name (AC2);
 *  - where a surface renders a specific SE or stop, it links to **that record** on its sibling view
 *    (AC8) — the contextual per-record mechanism #280 R8 ruled, not a switcher and not a tab strip.
 *
 * The negative assertions matter as much as the positive ones: #280 R2's hard constraint is that
 * expressing the relationship must not collapse the questions, and a control that made the four look
 * interchangeable would be a worse defect than the fragmentation this issue fixes.
 */
const SE = 'se-uuid-1';

const SCHEDULES = [
  {
    scheduleId: 's-1',
    seId: SE,
    seName: 'Ramesh Kumar',
    zoneId: '1',
    zoneName: 'Rajasthan North',
    dateFrom: '2026-08-24',
    dateTo: '2026-08-24',
    status: 'ACTIVE',
    batchCount: 2,
    ticketCount: 5,
  },
];

const SCHEDULE_DETAIL = {
  scheduleId: 's-1',
  seId: SE,
  seName: 'Ramesh Kumar',
  status: 'AUTO_ASSIGNED',
  dateFrom: '2026-08-24',
  dateTo: '2026-08-24',
  stops: [
    {
      batchId: 'b-900',
      stopSequence: 1,
      plantId: '10',
      plantName: 'ACP-9106',
      status: 'AUTO_ASSIGNED',
      deviceCount: 3,
      tickets: [
        { ticketId: 't-1', sortOrder: 0, slaBucket: 'CRITICAL', companyTier: 'GOLD', partialRecovery: false, reasoning: null },
      ],
    },
  ],
};

const RUNS = [
  {
    runId: '42',
    trigger: 'CRON',
    actorRole: null,
    actorName: null,
    startedAt: '2026-08-24T05:00:00.000Z',
    finishedAt: '2026-08-24T05:00:12.000Z',
    durationMs: 12000,
    status: 'SUCCESS',
    zones: 1,
    schedules: 1,
    batches: 2,
    ticketsDispatched: 5,
    recommended: 5,
    unassignable: 0,
    errorCount: 0,
  },
];

const ENGINEERS = [
  { engineerId: SE, name: 'Ramesh Kumar', coverageType: 'DEDICATED', zoneId: '1', committed: 1, dailyCapacity: 6, isActive: true },
];

/**
 * Both intra-day reads are **paged** since #356 — they answer `{ rows, nextCursor, limit }`, not a
 * bare array. `IntradayQueuePage` reads `.rows`, so a fixture that still returns an array renders
 * `undefined.map` and takes the whole page down. One page, no continuation: these two tests are about
 * cross-view framing and links, not about paging.
 */
const page = <T,>(rows: T[]): { rows: T[]; nextCursor: null; limit: number } => ({
  rows,
  nextCursor: null,
  limit: 50,
});

const INTRADAY_UPDATES = [
  {
    auditId: 'a-1',
    updateType: 'ADD',
    ticketId: 't-1',
    seId: SE,
    seName: 'Ramesh Kumar',
    actorId: 'zm-1',
    createdAt: '2026-08-24T09:30:00.000Z',
  },
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function mock(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => handler(String(url))),
  );
}

const at = (element: HTMLElement) => within(element);

describe('#281 AC2 — every dispatch surface states which question it answers', () => {
  it('Schedules answers the present tense and names its siblings by their questions', async () => {
    mock((url) => (url.includes('/schedules/engineers') ? json([]) : json(SCHEDULES)));
    render(
      <MemoryRouter>
        <SchedulesPage />
      </MemoryRouter>,
    );

    const note = at(await screen.findByTestId('dispatch-timeline-note'));
    expect(screen.getByTestId('dispatch-timeline-tense').textContent).toMatch(/present/i);
    expect(note.getByRole('link', { name: /what the next run would do/i })).toHaveAttribute(
      'href',
      '/schedules/preview',
    );
    expect(note.getByRole('link', { name: /what past runs did/i })).toHaveAttribute('href', '/dispatch-runs');
    // AC3 — the sibling is offered as a different question, never as another tab of this one.
    expect(note.queryByRole('tab')).toBeNull();
    // The current view is never one of the choices — that is what a tab strip would do.
    expect(note.queryByRole('link', { name: /what is committed today/i })).toBeNull();
  });

  it('Dispatch Runs answers the past tense and says it is read-only (AC5)', async () => {
    mock(() => json(RUNS));
    render(
      <MemoryRouter>
        <DispatchRunsPage />
      </MemoryRouter>,
    );

    await screen.findByTestId('dispatch-run-42');
    expect(screen.getByTestId('dispatch-timeline-tense').textContent).toMatch(/past/i);
    expect(screen.getByTestId('dispatch-timeline-note').textContent).toMatch(/read-only/i);
  });

  it("Intra-day carries R9's framing — changes to today's plan, not a fourth tense", async () => {
    mock((url) => (url.includes('intraday-insertions') ? json(page([])) : json(page(INTRADAY_UPDATES))));
    render(
      <MemoryRouter>
        <IntradayQueuePage />
      </MemoryRouter>,
    );

    await screen.findByTestId('dispatch-timeline-note');
    const tense = screen.getByTestId('dispatch-timeline-tense').textContent ?? '';
    expect(tense).toMatch(/changes to today/i);
    // Not future / present / past — #280 R9: it hangs off Schedules rather than standing beside them.
    expect(tense).not.toMatch(/^(future|present|past)$/i);
    expect(screen.getByTestId('dispatch-timeline-note').textContent).toMatch(/not a run of its own/i);
  });
});

describe('#281 AC8 — contextual, per-record cross-view links', () => {
  it('Schedules offers each SE their projected next run, not a bare page link', async () => {
    mock((url) => (url.includes('/schedules/engineers') ? json([]) : json(SCHEDULES)));
    render(
      <MemoryRouter>
        <SchedulesPage />
      </MemoryRouter>,
    );

    const link = await screen.findByTestId(`schedule-to-preview-${SE}`);
    const tomorrow = addIsoDays(istIsoDate(new Date()), 1);
    // The record travels with the link: this SE, on the projection for the next run.
    expect(link).toHaveAttribute('href', `/schedules/preview?date=${tomorrow}&se=${SE}`);
    expect(link.textContent).toMatch(/would/i);
  });

  it("a day plan's stops reach the dispatch record that produced them", async () => {
    mock((url) => (url.includes('/schedules/engineers') ? json([]) : json(SCHEDULE_DETAIL)));
    render(
      <MemoryRouter initialEntries={[`/schedules/${SE}`]}>
        <Routes>
          <Route path="/schedules/:engineerId" element={<ScheduleDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const link = await screen.findByTestId('stop-to-batch-b-900');
    expect(link).toHaveAttribute('href', '/batches/b-900');
    expect(link.textContent).toMatch(/dispatch|assigned|chose/i);
  });

  it('an intra-day change reaches the day plan it changed', async () => {
    mock((url) => {
      if (url.includes('/schedules/engineers')) return json(ENGINEERS);
      return url.includes('intraday-insertions') ? json(page([])) : json(page(INTRADAY_UPDATES));
    });
    render(
      <MemoryRouter>
        <IntradayQueuePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('iq-row-a-1').textContent).toContain('Ramesh Kumar'));
    const row = at(screen.getByTestId('iq-row-a-1'));
    expect(row.getByRole('link', { name: /Ramesh Kumar/ })).toHaveAttribute('href', `/schedules/${SE}`);
  });
});
