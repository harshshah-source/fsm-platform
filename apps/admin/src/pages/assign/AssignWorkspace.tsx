import type { ReactNode } from 'react';
import type { AssignablePlantRow } from '../../api/assignWork';
import { apiAssignableTickets, type DistributeUnplaced } from '../../api/schedules';
import { MetricStrip, SearchInput, type Metric } from '../../components/data';
import { Badge, Button, LoadBadge } from '../../components/ui';
import { engineerOptionLabel, isOverCapacity } from '../../lib/capacity';
import { cn } from '../../lib/cn';
import { formatPlantDisplayName } from '../../lib/plantNames';
import { CandidateColumn } from './CandidateColumn';
import { DistributePanel } from './DistributePanel';
import { CHIP_FORM, CHIP_MEANING_LABEL, GrammarLegend, chipMeaning } from './grammar';
import { LaneHeader, laneCoverage } from './LaneCoverage';
import { ReviewCommitScreen } from './ReviewCommitScreen';
import { rowKey, useAssignDraft, type UseAssignDraftOptions } from './useAssignDraft';

/**
 * **The assign workspace** — pool → draft lanes → distribute → review → commit (#273, approved
 * direction #272; the authoritative design is
 * `docs/ui/desktop/approved-designs/assign-work-console.html`).
 *
 * **This is the layout, not the machine.** The draft state machine lives in {@link useAssignDraft}
 * and is shared with the Scheduler Console's Assign mode (`console/AssignBoard`), which renders the
 * *same* draft in the Console's own three-region composition (composition correction §10). Two
 * layouts, one machine — a second copy of a state machine whose entire contract is "nothing is
 * written until commit" is the one duplication this programme cannot afford.
 *
 * **This layout is the standalone `/assign` page's** — three columns of pool, draft lanes and
 * candidates, keyed to a pan-India pool for a CSM or Operations Head (§14 **D4**). It is unchanged
 * from the #273–#290 build; the extraction underneath it moved no behaviour.
 *
 * Seven surfaces in this app could already move work to an engineer and **not one showed a count**:
 * the volume arrived afterwards, in a toast. Each is shaped N→1 — many tickets, one engineer, written
 * immediately, no preview and no residual — while a dispatcher's job is M→N. This is the M→N surface,
 * and the ledger across the top is the answer none of the seven could give: *how much is left?*
 *
 * **Nothing is written until commit (#272 R2).** That is what makes the residual live rather than
 * retrospective, and it is why the draft is client state and the ledger is arithmetic rather than a
 * second read.
 *
 * **The draft is session-local (#272 Q2, ruled).** Leaving the page loses it, and the page says so
 * rather than implying a durability it does not have.
 */

/**
 * The two ways Distribute can fail to place work, in the transparency surfaces' own words (#276
 * required-change 4). `NO_COVERAGE` — not one of the chosen engineers covers the plant at any tier.
 * `ALL_DROPPED` — some do, and every one of them failed a hard filter. They are different problems
 * (a coverage gap versus a readiness gap) and the rail must not blur them into "unassignable".
 */
export const UNPLACED_REASON_TEXT: Record<DistributeUnplaced['reason'], string> = {
  NO_COVERAGE: 'no coverage',
  ALL_DROPPED: 'all dropped',
};

/** `61 h silent` / `—` — the age of the oldest thing waiting at a site. */
export function silentFor(hours: number | null): string | null {
  return hours === null ? null : `oldest ${Math.round(hours)} h silent`;
}

export { narrowToZone } from './useAssignDraft';

export interface AssignWorkspaceProps extends UseAssignDraftOptions {
  /** Chrome above the workspace. Drafting and reviewing are two different screens and say so. */
  header?: (stage: 'draft' | 'review') => ReactNode;
}

export function AssignWorkspace({ zoneId = null, engineers: engineersProp, header, onCommitted }: AssignWorkspaceProps = {}) {
  const {
    view,
    openTotal,
    totals,
    error,
    search,
    setSearch,
    criticalOnly,
    setCriticalOnly,
    matches: poolMatches,
    selected,
    selectedPlantIds,
    toggle,
    focusedPlantId,
    setFocusedPlantId,
    focusedCandidates,
    candidateView,
    candidatesLoading,
    load,
    engineers,
    lanes,
    readyLanes,
    drafted,
    inDraft,
    draftWarnings,
    laneAfter,
    plantName,
    addToDraft,
    addLane,
    setLaneEngineer,
    removePlant,
    clearDraft,
    assignCandidate,
    distributing,
    setDistributing,
    addDistributeResultToDraft,
    unplacedVisible,
    unplacedGroups,
    reviewLanes,
    reviewing,
    batchResults,
    committing,
    openReview,
    commitBatch,
    backToDraft,
  } = useAssignDraft({ zoneId, engineers: engineersProp, onCommitted });

  const metrics: Metric[] = [
    // "zone scope" was true of every caller when there was only one. It is not true of `/assign`,
    // whose pool is pan-India for a CSM or Operations Head — and a ledger that mislabels its own
    // denominator is the one thing this strip cannot do.
    {
      label: 'Open unassigned',
      value: openTotal,
      hint: view ? `${zoneId === null ? 'your scope' : 'this zone'} · ${view.date}` : '—',
      tone: 'info',
      testId: 'ledger-open',
    },
    { label: 'In this draft', value: inDraft.open, hint: `${drafted.size} plants · ${lanes.length} engineers`, tone: 'brand', testId: 'ledger-draft' },
    {
      label: 'Left after commit',
      value: openTotal - inDraft.open,
      hint: openTotal > 0 ? `${Math.round(((openTotal - inDraft.open) / openTotal) * 100)}% still unassigned` : 'nothing outstanding',
      tone: 'neutral',
      testId: 'ledger-left',
    },
    {
      label: 'Critical+ in draft',
      value: inDraft.critical,
      hint: `of ${view?.totals.criticalCount ?? 0} ${zoneId === null ? 'in scope' : 'in this zone'}`,
      tone: inDraft.critical > 0 ? 'critical' : 'neutral',
      testId: 'ledger-critical',
    },
  ];

  const matches = (company: string, plant: AssignablePlantRow) =>
    poolMatches(company, plant.plantName, plant.criticalCount);

  if (reviewLanes) {
    return (
      <div>
        {header?.('review')}
        {error && (
          <p role="alert" className="mb-4 text-sm text-critical">
            {error}
          </p>
        )}
        <ReviewCommitScreen
          lanes={reviewLanes}
          stillUnassignedAfter={Math.max(0, openTotal - reviewLanes.reduce((n, l) => n + l.ticketIds.length, 0))}
          // #276 — of what is left after this commit, how much nobody in the selection can take. The
          // rail's own live count, so the review screen and the draft cannot disagree about it.
          noEligibleEngineerCount={unplacedVisible.length}
          committing={committing}
          results={batchResults}
          onBack={backToDraft}
          onCommit={commitBatch}
          onTicketResolved={load}
        />
      </div>
    );
  }

  return (
    <div>
      {header?.('draft')}

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <MetricStrip metrics={metrics} />

      {/* #290 AC5 — the ledger's fifth cell. Silent on a clean draft: a row of "0 over capacity ·
          0 crossings" trains the operator to stop reading the one place a real warning will appear. */}
      <div data-testid="ledger-summary" className="flex flex-wrap items-center gap-2 text-[11px]">
        {draftWarnings.overCapacity > 0 && (
          <Badge tone="warning" data-testid="summary-over-capacity">
            {draftWarnings.overCapacity} {draftWarnings.overCapacity === 1 ? 'engineer' : 'engineers'} over capacity
          </Badge>
        )}
        {draftWarnings.crossings > 0 && (
          <Badge tone="tierCross" data-testid="summary-crossings">
            {draftWarnings.crossings} tier {draftWarnings.crossings === 1 ? 'crossing' : 'crossings'}
          </Badge>
        )}
        {draftWarnings.noCoverage > 0 && (
          <Badge tone="critical" data-testid="summary-no-coverage">
            {draftWarnings.noCoverage} no coverage
          </Badge>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ---------------- Work pool ---------------- */}
        <section className="rounded-card border border-line bg-surface-card p-3" aria-label="Work pool">
          <header className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-ink-strong">Work pool</h2>
            <span className="text-xs text-ink-muted">{openTotal} unassigned</span>
          </header>

          <SearchInput
            className="w-full"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company or plant…"
            aria-label="Search the work pool"
          />

          {/* #277 — the Critical+ preset that absorbs the orphaned `CriticalQueue` grouping. */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              data-testid="filter-critical-plus"
              aria-pressed={criticalOnly}
              onClick={() => setCriticalOnly((v) => !v)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                criticalOnly
                  ? 'border-critical bg-critical-bg text-critical'
                  : 'border-line bg-surface-raised text-ink-muted hover:text-ink-strong',
              )}
            >
              Critical+
            </button>
          </div>

          <div className="mt-3 space-y-4">
            {(view?.companies ?? []).map((company) => {
              const plants = company.plants.filter((p) => matches(company.companyName, p));
              if (plants.length === 0) return null;
              return (
                <div key={company.companyId}>
                  <div className="mb-1 flex items-baseline justify-between text-xs">
                    <span className="font-semibold text-ink-strong">{company.companyName}</span>
                    <span className="text-ink-muted">
                      {plants.length} plants · {plants.reduce((n, p) => n + p.openUnassigned, 0)}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {plants.map((p) => {
                      const key = rowKey(company.companyId, p.plantId);
                      const shared = (totals.get(p.plantId)?.companies.size ?? 1) > 1;
                      const already = drafted.has(p.plantId);
                      const silent = silentFor(p.oldestInactivityHours);
                      return (
                        <li
                          key={key}
                          data-testid={`pool-plant-${company.companyId}-${p.plantId}`}
                          className={cn(
                            'flex items-start gap-2 rounded-md border border-line px-2 py-1.5 text-sm',
                            selected.has(key) && 'bg-brand-300/20',
                            already && 'opacity-60',
                          )}
                        >
                          <input
                            type="checkbox"
                            className="mt-1"
                            aria-label={`Select ${p.plantName} for ${company.companyName}`}
                            checked={selected.has(key)}
                            disabled={p.openUnassigned === 0 || already}
                            onChange={() => {
                              toggle(key);
                              setFocusedPlantId(p.plantId);
                            }}
                          />
                          <span className="min-w-0 flex-1">
                            {/* The name is the focus control, kept separate from the checkbox: ticking
                                a row drafts it, clicking its name asks "who can cover this?" — two
                                different questions the dispatcher alternates between. */}
                            <button
                              type="button"
                              aria-label={`Candidates for ${p.plantName}`}
                              onClick={() => setFocusedPlantId(p.plantId)}
                              className={cn(
                                'block w-full truncate text-left font-medium text-ink-strong hover:underline',
                                focusedPlantId === p.plantId && 'underline decoration-brand-600 decoration-2',
                              )}
                            >
                              {formatPlantDisplayName(p.plantName)}
                            </button>
                            <span className="block text-[11px] text-ink-muted">
                              {silent ?? 'age not recorded'}
                              {/* The plant-shaped commit, said out loud on the row it applies to. */}
                              {shared && ' · serves 2 companies — all of its unassigned work moves together'}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5 text-right">
                            <span className="tabular-nums font-semibold text-ink-strong">{p.openUnassigned}</span>
                            <span className="tabular-nums text-[11px] text-ink-muted">/ {p.totalDevices}</span>
                            {p.criticalCount > 0 && <Badge tone="critical">{p.criticalCount} crit</Badge>}
                            {p.heldCount > 0 && <Badge tone="warning">{p.heldCount} held</Badge>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
            {view && view.companies.length === 0 && (
              <p className="text-sm text-ink-muted">Nothing unassigned in your scope right now.</p>
            )}
            {view &&
              view.companies.length > 0 &&
              view.companies.every((c) => c.plants.every((p) => !matches(c.companyName, p))) && (
                <p className="text-sm text-ink-muted">
                  {criticalOnly ? 'No CRITICAL+ work in scope.' : 'Nothing matches this search.'}
                </p>
              )}
          </div>
        </section>

        {/* ---------------- Draft plan ---------------- */}
        <section className="rounded-card border border-line bg-surface-card p-3" aria-label="Draft plan">
          <header className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-ink-strong">Draft plan</h2>
            <span className="text-xs text-ink-muted">{inDraft.open === 0 ? 'nothing written yet' : `${inDraft.open} devices`}</span>
          </header>

          <div className="space-y-2">
            {lanes.map((lane) => {
              const eng = engineers.find((e) => e.engineerId === lane.seId);
              // One computation of the draft's effect on this engineer, shared by the header, the lane
              // treatment and the chips — three renderings of one fact, never three derivations of it.
              // It lives in the hook, so the Console's layout reads the identical number.
              const after = laneAfter(lane);
              const laneOver =
                typeof eng?.dailyCapacity === 'number' &&
                isOverCapacity({ committed: after, dailyCapacity: eng.dailyCapacity });
              const coverageFacts = eng ? laneCoverage(eng.engineerId, lane.plantIds, candidateView, plantName) : [];
              const factFor = (plantId: string) => coverageFacts.find((c) => c.plantId === plantId) ?? null;

              return (
                <div
                  key={lane.id}
                  data-testid={`lane-${lane.id}`}
                  data-over-capacity={String(laneOver)}
                  // #290 — the lane itself carries the over-capacity state, not only the number in its
                  // header. The design draws an amber lane because "this engineer is past their cap" is
                  // a fact about the whole row, and an operator scanning six lanes reads the row before
                  // they read any figure inside it. **A state, never a barrier** (#258 Q2): nothing here
                  // disables anything, and the Review & commit button stays live.
                  className={cn(
                    'rounded-md border p-2',
                    laneOver ? 'border-warning bg-warning-bg/30' : 'border-line',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <select
                      aria-label={`Engineer for lane ${lane.id}`}
                      value={lane.seId}
                      onChange={(e) =>
                        setLaneEngineer(lane.id, e.target.value)
                      }
                      className="min-w-0 flex-1 rounded-md border border-line px-2 py-1 text-xs"
                    >
                      <option value="">Select engineer…</option>
                      {engineers.map((e) => (
                        <option key={e.engineerId} value={e.engineerId}>
                          {engineerOptionLabel(e)}
                        </option>
                      ))}
                    </select>
                    {eng && (
                      <LoadBadge seId={eng.engineerId} committed={eng.committed ?? 0} dailyCapacity={eng.dailyCapacity} />
                    )}
                  </div>

                  {/* #274 — coverage per (engineer, plant) and the load this draft would add. Both are
                      states the dispatcher reads before committing, and neither is a gate. */}
                  {eng && lane.plantIds.length > 0 && (
                    <LaneHeader
                      seId={eng.engineerId}
                      coverage={laneCoverage(eng.engineerId, lane.plantIds, candidateView, plantName)}
                      committed={eng.committed ?? 0}
                      after={after}
                      dailyCapacity={typeof eng.dailyCapacity === 'number' ? eng.dailyCapacity : null}
                    />
                  )}

                  <div className="mt-2 flex flex-wrap gap-1">
                    {lane.plantIds.map((plantId) => {
                      const t = totals.get(plantId);
                      const override = lane.ticketOverrides?.[plantId];
                      const name =
                        view?.companies.flatMap((c) => c.plants).find((p) => p.plantId === plantId)?.plantName ??
                        `Plant ${plantId}`;
                      const fact = factFor(plantId);
                      const placed = override ? override.length : (t?.openUnassigned ?? 0);
                      /**
                       * #290 AC3 — critical work is its **own chip**, as the design draws it
                       * (`Kotputli Works ×3 crit` beside `Kotputli Works ×1`). One chip totalling both
                       * hides the only number a dispatcher triages by: a plant reading `×15` says
                       * nothing about whether any of it is on a clock.
                       *
                       * The split is suppressed when a strategy handed this lane only part of the
                       * plant (#276's `ticketOverrides`): the plant's critical count is a fact about
                       * the *plant*, and asserting it of an arbitrary subset would be a fabricated
                       * number — exactly what #282 R6 forbids.
                       */
                      const critical = override ? 0 : Math.min(t?.criticalCount ?? 0, placed);
                      const remainder = placed - critical;
                      const remove = () => removePlant(lane.id, plantId);
                      /**
                       * The remove control belongs to the **plant**, not to a chip, so exactly one is
                       * rendered even when the plant splits into a critical chip and a remainder. Two
                       * buttons doing the identical thing to the identical object would claim a
                       * granularity the draft does not have — a lane holds plants, and there is no way
                       * to drop "the critical half" of one. (It also produced two controls with the
                       * same accessible name, which is how the suite found this.)
                       */
                      const chip = (opts: {
                        testId: string;
                        meaning: ReturnType<typeof chipMeaning>;
                        qty: string;
                        removable: boolean;
                      }) => (
                        <span
                          key={opts.testId}
                          data-testid={opts.testId}
                          data-tier-crossing={String(fact?.tierCrossing ?? false)}
                          title={`${formatPlantDisplayName(name)} — ${CHIP_MEANING_LABEL[opts.meaning]}`}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-[11px]',
                            CHIP_FORM[opts.meaning],
                          )}
                        >
                          {/* The dot is the grammar's own mark for "inside the engineer's own
                              coverage"; a critical chip carries a flag instead, so the two are
                              distinguishable with the colour removed. */}
                          {opts.meaning === 'CRITICAL' ? (
                            <span aria-hidden>⚑</span>
                          ) : (
                            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                          )}
                          {formatPlantDisplayName(name)}
                          <span className="tabular-nums opacity-80">
                            ×{opts.qty}
                            {/* #276 — a strategy that only handed part of this plant's work here, said out loud. */}
                            {override && ` of ${t?.openUnassigned ?? '?'}`}
                          </span>
                          {opts.removable && (
                            <button
                              type="button"
                              aria-label={`Remove ${name} from lane ${lane.id}`}
                              onClick={remove}
                              className="opacity-70 hover:opacity-100"
                            >
                              ×
                            </button>
                          )}
                        </span>
                      );
                      const base = chipMeaning({
                        critical: false,
                        tierCrossing: fact?.tierCrossing ?? false,
                        noCoverage: fact?.coverageType === null && fact !== null,
                      });
                      const showRemainder = remainder > 0 || critical === 0;
                      return (
                        <span key={plantId} className="contents">
                          {critical > 0 &&
                            chip({
                              testId: `chip-${lane.id}-${plantId}-critical`,
                              meaning: 'CRITICAL',
                              qty: `${critical} crit`,
                              removable: !showRemainder,
                            })}
                          {showRemainder &&
                            chip({
                              testId: `chip-${lane.id}-${plantId}`,
                              meaning: base,
                              qty: String(remainder),
                              removable: true,
                            })}
                        </span>
                      );
                    })}
                    <Button size="sm" variant="ghost" disabled={selected.size === 0} onClick={() => addToDraft(lane.id)}>
                      Add to draft
                    </Button>
                  </div>
                </div>
              );
            })}

            <Button size="sm" variant="ghost" onClick={addLane}>
              + Add engineer lane
            </Button>

            {/* #290 AC4 — the legend the design puts beneath the lanes, drawn from the same `CHIP_FORM`
                table the chips above use, so it can never describe a border they stopped using. */}
            <GrammarLegend />

            {/*
              #276 required-change 4 / the approved design's "No eligible engineer" rail. Work the
              projection could not place sits **in the draft column**, not in the panel that reported
              it — a dispatcher who closes Distribute has not solved the coverage gap, and a console
              that dropped it here would be under-reporting its own residual on the one screen whose
              job is to answer "what is left".

              Dashed, muted and un-actionable by design: these chips are not draggable and carry no
              Assign button, because nothing in this selection *can* take them. The fix is coverage or
              a freed-up engineer, not another click here.
            */}
            {unplacedGroups.length > 0 && (
              <div
                data-testid="unplaced-rail"
                className="rounded-md border border-dashed border-critical/60 bg-surface-card p-2"
              >
                <div
                  data-testid="unplaced-rail-total"
                  className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-critical"
                >
                  No eligible engineer · {unplacedVisible.length} device{unplacedVisible.length === 1 ? '' : 's'}
                </div>
                <div className="flex flex-wrap gap-1">
                  {unplacedGroups.map((g) => (
                    <span
                      key={`${g.plantId}-${g.reason}`}
                      data-testid={`unplaced-${g.plantId}-${g.reason}`}
                      className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-2 py-0.5 text-[11px] text-ink-muted"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          g.reason === 'NO_COVERAGE' ? 'bg-critical' : 'bg-warning',
                        )}
                      />
                      {formatPlantDisplayName(plantName(g.plantId))}
                      <span className="tabular-nums">×{g.count}</span>
                      <span>· {UNPLACED_REASON_TEXT[g.reason]}</span>
                    </span>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-ink-muted">
                  Not in the draft and not committed. “No coverage” means none of the engineers you chose
                  covers that plant; “all dropped” means they do and every one failed a readiness check.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* ---------------- Candidates (#274) ---------------- */}
        <CandidateColumn plant={focusedCandidates} loading={candidatesLoading} onAssign={assignCandidate} />
      </div>

      {distributing && (
        <DistributePanel
          plantIds={selectedPlantIds}
          plantName={plantName}
          engineers={engineers}
          resolveTicketIds={async (ids) => (await apiAssignableTickets(ids)).flatMap((r) => r.ticketIds)}
          onAddToDraft={addDistributeResultToDraft}
          onClose={() => setDistributing(false)}
        />
      )}

      <footer className="mt-4 flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface-card p-3 text-sm">
        <span>
          <b className="text-ink-strong">{inDraft.open} devices</b> → {readyLanes.length} engineers ·{' '}
          {drafted.size} plants
        </span>
        <span className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={selectedPlantIds.length === 0}
            onClick={() => setDistributing(true)}
          >
            Distribute across selected engineers…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={drafted.size === 0 && unplacedVisible.length === 0}
            onClick={clearDraft}
          >
            Clear draft
          </Button>
          <Button size="sm" disabled={readyLanes.length === 0 || reviewing} loading={reviewing} onClick={() => void openReview()}>
            Review &amp; commit
          </Button>
        </span>
      </footer>
    </div>
  );
}
