import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { AdminShell } from '../src/components/AdminShell';
import { buildNav, DISPATCH_HEADING } from '../src/components/shell/nav';

/**
 * #281 AC1/AC2/AC12 — the dispatch surfaces are one named cluster in the sidebar, ranked in timeline
 * order, each carrying the question it answers; Intra-day Queue is subordinate to Schedules
 * (#280 R9) rather than a flat fourth peer; and no role's reach changes (#280 R6).
 *
 * **Amended by #285 (decision #282 R1).** The cluster gained `Today's Dispatch` as its primary row.
 * That is the surface #280 believed could not be justified — its R8 ruled cross-links only, on the
 * recorded premise that "no wireframe exists for this screen set", which turned out to be false: the
 * Crew Deck was designed 2026-08-20 and lost outside the repo. #282 R1 supersedes R8 and nothing
 * else, so every other assertion in this file still holds and is deliberately left standing: the
 * four original surfaces keep their routes, their order, their hints and their role gating, and
 * Intra-day stays subordinate to Schedules. The four are now supporting rows beneath the cockpit
 * rather than the whole cluster.
 *
 * The nav assertions run against `buildNav` directly — it is a pure function of role, which is what
 * makes "who can reach what" testable without a shell. The one rendered case pins that the grouping
 * actually reaches the operator's screen, since a heading that exists only in the data model would
 * satisfy every unit assertion here and still leave the audit's finding (F6) live.
 */
const MANAGERS = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'];
const NON_MANAGERS = ['SERVICE_ENGINEER', 'WAREHOUSE_MANAGER'];

/** The cockpit (#285) plus the four surfaces #281 grouped, in the order they now appear. */
const DISPATCH_ROUTES = ['/dispatch/today', '/schedules/preview', '/schedules', '/intraday', '/dispatch-runs'];
/** The four #281 delivered — still present, still ranked, now beneath the cockpit. */
const TIMELINE_ROUTES = ['/schedules/preview', '/schedules', '/intraday', '/dispatch-runs'];

const dispatchGroup = (role: string) => buildNav(role).find((g) => g.heading === DISPATCH_HEADING);
const allLinks = (role: string) => buildNav(role).flatMap((g) => g.items);

describe('#281 AC1 — the Dispatch cluster', () => {
  it('groups the dispatch surfaces under one named heading for every manager role', () => {
    for (const role of MANAGERS) {
      const group = dispatchGroup(role);
      expect(group, role).toBeDefined();
      expect(group!.items.map((i) => i.to)).toEqual(DISPATCH_ROUTES);
    }
  });

  it('#285 — leads the cluster with the cockpit, and keeps the four timeline surfaces beneath it', () => {
    const items = dispatchGroup('ZONAL_MANAGER')!.items;

    // The one surface that answers "what is happening now". The four below answer what *will*
    // happen, what was committed, what changed, and what already ran — none of which is the same
    // question, which is why #280 R2's no-merging constraint is untouched by adding this row.
    expect(items[0].to).toBe('/dispatch/today');
    expect(items[0].hint).toMatch(/now/i);
    expect(items[0].indent).toBeFalsy();

    // Nothing #281 delivered was removed.
    for (const to of TIMELINE_ROUTES) {
      expect(items.some((i) => i.to === to), to).toBe(true);
    }
  });

  it('no longer leaves them as adjacent flat rows inside Operations', () => {
    for (const role of MANAGERS) {
      const operations = buildNav(role).find((g) => g.heading === 'Operations');
      expect(operations, role).toBeDefined();
      for (const to of DISPATCH_ROUTES) {
        expect(operations!.items.some((i) => i.to === to), `${role} ${to}`).toBe(false);
      }
    }
  });

  it('ranks the cluster future → present → past, with Intra-day subordinate to Schedules (#280 R9)', () => {
    const items = dispatchGroup('ZONAL_MANAGER')!.items;
    const at = (to: string) => items.findIndex((i) => i.to === to);

    // Timeline order: the projection first, the committed plan next, the ledger last.
    expect(at('/schedules/preview')).toBeLessThan(at('/schedules'));
    expect(at('/schedules')).toBeLessThan(at('/dispatch-runs'));

    // Intra-day is not a fourth tense standing beside them — it hangs off Schedules, and says so
    // both by position (immediately after) and by the one presentational treatment #280 R9 allows.
    // R9 is untouched by #282, so this still holds; what changed is that Schedules is itself now
    // indented beneath the cockpit, so the assertion is about their relationship, not absolute depth.
    expect(at('/intraday')).toBe(at('/schedules') + 1);
    expect(items.find((i) => i.to === '/intraday')!.indent).toBe(true);
  });
});

describe('#281 AC2 — each surface carries the question it answers', () => {
  it('gives every dispatch link a tense hint a new ZM can rank without opening it', () => {
    const items = dispatchGroup('CENTRAL_SERVICE_MANAGER')!.items;
    const hint = (to: string) => items.find((i) => i.to === to)!.hint ?? '';

    expect(hint('/schedules/preview')).toMatch(/next run/i);
    // "Committed day plans", no longer "today's": the read behind this page is not date-scoped, and
    // the cockpit is now the row that legitimately claims today. Promising a scope the query does not
    // apply is the mismatch the forensic investigation recorded (#284 AC10 fixes the read itself).
    expect(hint('/schedules')).toMatch(/committed/i);
    expect(hint('/dispatch-runs')).toMatch(/past|already ran|history/i);
    // R9's own framing, verbatim in spirit: changes to today's plan, not a tense of its own.
    expect(hint('/intraday')).toMatch(/changes to today/i);
  });

  it('never labels the projection as a commitment (#280 R2/R3)', () => {
    const items = dispatchGroup('OPERATIONS_HEAD')!.items;
    const preview = items.find((i) => i.to === '/schedules/preview')!;
    expect(preview.hint).toMatch(/would|project/i);
    expect(preview.hint).not.toMatch(/committed|dispatched|assigned/i);
  });
});

describe('#281 AC12 — no role reach changes', () => {
  it('keeps every dispatch route manager-only and hidden from everyone else', () => {
    for (const role of MANAGERS) {
      const links = allLinks(role).map((l) => l.to);
      for (const to of DISPATCH_ROUTES) expect(links, `${role} ${to}`).toContain(to);
    }
    for (const role of NON_MANAGERS) {
      const links = allLinks(role).map((l) => l.to);
      for (const to of DISPATCH_ROUTES) expect(links, `${role} ${to}`).not.toContain(to);
      expect(dispatchGroup(role)).toBeUndefined();
    }
  });
});

describe('#281 AC1 — the cluster reaches the screen', () => {
  it('renders the Dispatch heading and its four links in the sidebar', () => {
    const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
    render(
      <AuthProvider initialSession={zm}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AdminShell />}>
              <Route index element={<div>home</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );

    const nav = within(screen.getByRole('navigation', { name: /primary/i }));
    expect(nav.getByText(DISPATCH_HEADING)).toBeInTheDocument();
    expect(nav.getByRole('link', { name: /scheduler preview/i })).toHaveAttribute('href', '/schedules/preview');
    expect(nav.getByRole('link', { name: /intra-day queue/i })).toHaveAttribute('href', '/intraday');
    // The hint is visible copy, not a tooltip — a new ZM must be able to rank the nouns by reading.
    expect(nav.getByText(/changes to today/i)).toBeInTheDocument();
  });
});
