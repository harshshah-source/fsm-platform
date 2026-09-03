import { useMemo } from 'react';
import type { DispatchTodayView, TodayEngineer } from '../../../api/dispatchToday';
import { apiAssignableTickets, type ZoneEngineer } from '../../../api/schedules';
import { EmptyState, SearchInput } from '../../../components/data';
import { Badge, Button, LoadBadge } from '../../../components/ui';
import { isOverCapacity } from '../../../lib/capacity';
import { cn } from '../../../lib/cn';
import { formatPlantDisplayName } from '../../../lib/plantNames';
import { CandidateColumn } from '../../assign/CandidateColumn';
import { DistributePanel } from '../../assign/DistributePanel';
import { CHIP_FORM, CHIP_MEANING_LABEL, GrammarLegend, chipMeaning } from '../../assign/grammar';
import { LaneHeader, laneCoverage } from '../../assign/LaneCoverage';
import { ReviewCommitScreen } from '../../assign/ReviewCommitScreen';
import { UNPLACED_REASON_TEXT, silentFor } from '../../assign/AssignWorkspace';
import { rowKey, type AssignDraft, type Lane } from '../../assign/useAssignDraft';

/**
 * **Assign mode, composed onto the Console's own three regions** — the composition correction's §10,
 * built 2026-08-31.
 *
 * ## What was wrong, and it was not the semantics
 *
 * Assign mode has been a mode of `/dispatch/today` since Phase 4 (§14 **D2**). What it was *not* was
 * a mode of the same **workspace**: entering it replaced the Console's `Engineers │ Board │ Work` with
 * a foreign three-column page — `Pool │ numbered lanes │ Candidates` — lifted whole from `/assign`.
 * The pool crossed the screen from right to left, the engineer roster disappeared, and the people who
 * were rows a moment ago came back as `Select engineer…` dropdowns on boxes called *Lane 1*. §10 named
 * this before it was built:
 *
 * > It must feel like the same product, which is what the instruction asks and what the current
 * > full-region takeover does not quite deliver.
 *
 * §15's build order never carried an Assign-mode stage, so the board was recomposed and this was not.
 * This file is that stage.
 *
 * ## The mapping (§10's table, one-to-one)
 *
 * | Region | Normal mode | Assign mode |
 * |---|---|---|
 * | **Left** | Engineer roster | The same roster — **and it is the lane-target list** |
 * | **Centre** | Committed board | **Draft lanes**, the same engineer rows holding draft chips |
 * | **Right** | Work Pool | **The assignable pool** — what is not assigned yet |
 * | **Bottom band** | Inspector, on selection | **Candidates**, on the focused plant |
 *
 * The bottom band is the one deliberate deviation from §10 as written, and it follows the Console
 * rather than the plan: §10 put Candidates in the right rail because the correction expected the
 * Inspector there, and the operator's final direction kept the Inspector as the **bottom contextual
 * band** instead (the correction's own header records D12 resolving the other way). Candidates is the
 * same kind of object — contextual detail about the one thing in focus, rendered only when something
 * is in focus — so it belongs in the slot the Inspector actually occupies, not the one it was
 * predicted to.
 *
 * ## What did **not** change, because none of it was the problem
 *
 * The state machine is {@link AssignDraft}, shared verbatim with `/assign` — same pool read, same
 * candidate read, same plant-shaped draft, same `assign-batch` commit, same per-lane results, same
 * `ReviewCommitScreen`. This file receives a draft and draws it. Specifically preserved:
 *
 *  - **Nothing is written until commit** (#272 R2), and the draft dies with the tab (#272 Q2).
 *  - **The commit is per-lane, not atomic** (#272 R8) — and the screen still says so.
 *  - **The mixed-commitment rule** (§3.4) is *strengthened*: draft lanes are `draft-lane-<seId>`,
 *    a vocabulary that cannot collide with the committed board's `lane-<seId>` even by accident. The
 *    rule's structural guarantee is unchanged — Assign mode still replaces the board, so the two are
 *    never on screen together — but the names now say which is which instead of relying on it.
 *  - **Nothing is a gate** (#258 Q2). Over capacity, a crossed tier and no coverage are stated on the
 *    row and never disable anything.
 *  - **Zone scope** (§14 D4) — the pool, its ledger and the roster are all the deck's zone.
 *
 * ## The one thing that is genuinely new, and it is not a feature
 *
 * **Engineers are the lanes.** The draft's `placeOnEngineer` already reused an engineer's existing
 * lane rather than opening a second one — the numbered lane was only ever the *label* of a row the
 * engineer already owned. Naming the row after the person removes the dropdown, removes "+ Add
 * engineer lane", and makes the Console's answer to *who is receiving this?* the same object in both
 * modes: the roster on the left, with the load the recommender enforces against.
 */
export function AssignBoard({
  view,
  draft,
  filter,
}: {
  view: DispatchTodayView;
  draft: AssignDraft;
  /** The frame's find box (§3.5), applied to the pool as it is to the board and rails. */
  filter: string;
}) {
  const {
    view: pool,
    openTotal,
    totals,
    error,
    search,
    setSearch,
    criticalOnly,
    setCriticalOnly,
    matches,
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
    setLaneEngineer,
    removePlant,
    clearLane,
    clearDraft,
    assignCandidate,
    assignSelectedTo,
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
  } = draft;

  /** The frame's find box and the pool's own search are one predicate — two boxes, one question. */
  const term = (filter.trim() || search.trim()).toLowerCase();
  const rowVisible = (companyName: string, plantName: string, criticalCount: number) => {
    if (criticalOnly && criticalCount === 0) return false;
    if (!term) return true;
    return companyName.toLowerCase().includes(term) || plantName.toLowerCase().includes(term);
  };

  /** Which lane, if any, holds this engineer's draft work — the row's own staged count. */
  const laneOf = useMemo(() => {
    const byEngineer = new Map<string, Lane>();
    for (const l of lanes) if (l.seId) byEngineer.set(l.seId, l);
    return byEngineer;
  }, [lanes]);

  const stagedFor = (seId: string) => {
    const lane = laneOf.get(seId);
    if (!lane) return 0;
    return lane.plantIds.reduce(
      (n, id) => n + (lane.ticketOverrides?.[id]?.length ?? totals.get(id)?.openUnassigned ?? 0),
      0,
    );
  };

  // The review screen is a full-width stage of its own — a diff, not a dialog — and it keeps the
  // Console's frame above it exactly as the draft does.
  if (reviewLanes) {
    return (
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
    );
  }

  const remaining = openTotal - inDraft.open;

  return (
    <div data-testid="assign-board" className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}

      {/* ── THE THREE STATES, AS THREE STEPS ─────────────────────────────────────────────────
          The old banner explained the draft in prose — "this draft lives in this browser tab only" —
          which is implementation vocabulary for a consequence the operator can simply be shown. The
          ledger's own four numbers were already the right three answers; this is those numbers put
          in the order the operator moves through them, and labelled with what they mean rather than
          with what they are. */}
      <StageRibbon
        available={openTotal}
        zoneName={view.zone.name}
        staged={inDraft.open}
        criticalStaged={inDraft.critical}
        engineerCount={readyLanes.length}
        remaining={remaining}
        blocked={unplacedVisible.length}
        warnings={draftWarnings}
      />

      {/* `items-start` and a bounded pool: a zone with 46 sites in the rail would otherwise stretch
          the draft column into a screen-high empty box before the operator has staged anything. The
          rail scrolls inside itself, exactly as the committed board's Work rail does. */}
      <div className="grid items-start gap-3 xl:grid-cols-[15rem_minmax(0,1fr)_20rem]">
        {/* ── LEFT: the roster, which is also the lane-target list ──────────────────────────── */}
        <AssignPeopleRail
          engineers={view.engineers}
          roster={engineers}
          stagedFor={stagedFor}
          laneAfter={(seId) => {
            const lane = laneOf.get(seId);
            const eng = engineers.find((e) => e.engineerId === seId);
            return lane ? laneAfter(lane) : (eng?.committed ?? 0);
          }}
          selectedCount={selectedPlantIds.length}
          onAssignSelected={assignSelectedTo}
        />

        {/* ── CENTRE: the draft, as engineer rows ───────────────────────────────────────────── */}
        <section
          data-testid="assign-draft-region"
          aria-label="Your draft"
          className="flex min-h-[14rem] min-w-0 flex-col gap-2 rounded-lg border border-dashed border-brand-600 bg-brand-300/5 p-2"
        >
          <header className="flex flex-wrap items-baseline justify-between gap-2 px-1">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">
              Your draft — nothing written yet
            </h2>
            <span className="text-[11px] text-ink-muted">
              {inDraft.open === 0
                ? 'nothing selected for assignment'
                : `${inDraft.open} ${inDraft.open === 1 ? 'device' : 'devices'} · ${readyLanes.length} ${readyLanes.length === 1 ? 'engineer' : 'engineers'}`}
            </span>
          </header>

          {drafted.size === 0 && unplacedGroups.length === 0 ? (
            <EmptyState
              message={
                selectedPlantIds.length > 0
                  ? `${selectedPlantIds.length} ${selectedPlantIds.length === 1 ? 'site' : 'sites'} ticked — now choose an engineer on the left to add it to their plan.`
                  : 'Tick work on the right, then choose an engineer on the left. Nothing is written until you commit.'
              }
            />
          ) : (
            <div className="flex flex-col gap-2">
              {lanes
                .filter((l) => l.plantIds.length > 0)
                .map((lane) => (
                  <DraftLane
                    key={lane.id}
                    lane={lane}
                    engineers={engineers}
                    totals={totals}
                    candidateView={candidateView}
                    plantName={plantName}
                    after={laneAfter(lane)}
                    onSetEngineer={(seId) => setLaneEngineer(lane.id, seId)}
                    onRemovePlant={(plantId) => removePlant(lane.id, plantId)}
                    onClear={() => clearLane(lane.id)}
                    onFocusPlant={setFocusedPlantId}
                  />
                ))}

              {/*
                #276 required-change 4 / the approved design's "No eligible engineer" rail. Work the
                projection could not place sits **in the draft region**, not in the panel that reported
                it — a dispatcher who closes Distribute has not solved the coverage gap, and a console
                that dropped it here would be under-reporting its own residual on the one screen whose
                job is to answer "what is left".

                Dashed, muted and un-actionable by design: nothing in this selection *can* take them.
                The fix is coverage or a freed-up engineer, not another click here.
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
                    Nobody can take this · {unplacedVisible.length} device{unplacedVisible.length === 1 ? '' : 's'}
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
                    Not in your draft and not assigned. “No coverage” means none of the engineers you chose
                    covers that plant; “all dropped” means they do and every one failed a readiness check.
                  </p>
                </div>
              )}

              <GrammarLegend />
            </div>
          )}
        </section>

        {/* ── RIGHT: the pool — what is not assigned yet ────────────────────────────────────── */}
        <section
          data-testid="assign-pool-rail"
          aria-label="Not assigned yet"
          className="flex max-h-[calc(100vh-14rem)] flex-col gap-2 rounded-lg border border-line bg-surface p-3"
        >
          <h2 className="flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            Not assigned yet
            <span className="tabular-nums text-ink" data-testid="ledger-open">
              {openTotal}
            </span>
          </h2>

          <SearchInput
            className="w-full"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company or plant…"
            aria-label="Search the work pool"
          />

          {/* #277 — the Critical+ preset that absorbed the orphaned `CriticalQueue` grouping. */}
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              data-testid="filter-critical-plus"
              aria-pressed={criticalOnly}
              onClick={() => setCriticalOnly((v) => !v)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                criticalOnly
                  ? 'border-critical bg-critical-bg text-critical'
                  : 'border-line bg-surface-raised text-ink-muted hover:text-ink-strong',
              )}
            >
              Critical+
            </button>
            {selectedPlantIds.length > 0 && (
              <span
                data-testid="pool-selected-count"
                className="rounded-full bg-brand-300/20 px-2.5 py-1 text-[11px] font-medium text-brand-700"
              >
                {selectedPlantIds.length} ticked — choose an engineer →
              </span>
            )}
          </div>

          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            {(pool?.companies ?? []).map((company) => {
              const plants = company.plants.filter((p) =>
                rowVisible(company.companyName, p.plantName, p.criticalCount),
              );
              if (plants.length === 0) return null;
              return (
                <div key={company.companyId}>
                  <div className="mb-1 flex items-baseline justify-between text-[11px]">
                    <span className="font-semibold text-ink">{company.companyName}</span>
                    <span className="tabular-nums text-ink-muted">
                      {plants.reduce((n, p) => n + p.openUnassigned, 0)}
                    </span>
                  </div>
                  <ul className="flex flex-col gap-1">
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
                            'flex items-start gap-2 rounded-md border px-2 py-1.5 text-[11px]',
                            selected.has(key) ? 'border-brand-600 bg-brand-300/20' : 'border-line',
                            // Already staged is not "gone" — it is the same work, one column over.
                            already && 'opacity-50',
                          )}
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5"
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
                                a row stages it, clicking its name asks "who can cover this?" — two
                                different questions the dispatcher alternates between. */}
                            <button
                              type="button"
                              aria-label={`Candidates for ${p.plantName}`}
                              onClick={() => setFocusedPlantId(p.plantId)}
                              className={cn(
                                'block w-full truncate text-left font-medium text-ink hover:underline',
                                focusedPlantId === p.plantId && 'underline decoration-brand-600 decoration-2',
                              )}
                            >
                              {formatPlantDisplayName(p.plantName)}
                            </button>
                            <span className="block text-[10px] text-ink-muted">
                              {already ? 'in your draft' : (silent ?? 'age not recorded')}
                              {/* The plant-shaped commit, said out loud on the row it applies to. */}
                              {shared && ' · shared site — all of its work moves together'}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1 text-right">
                            <span className="tabular-nums font-semibold text-ink">{p.openUnassigned}</span>
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
            {pool && pool.companies.length === 0 && (
              <p className="text-[11px] text-ink-muted">Nothing unassigned in {view.zone.name} right now.</p>
            )}
            {pool &&
              pool.companies.length > 0 &&
              pool.companies.every((c) =>
                c.plants.every((p) => !rowVisible(c.companyName, p.plantName, p.criticalCount)),
              ) && (
                <p className="text-[11px] text-ink-muted">
                  {criticalOnly ? 'No CRITICAL+ work in this zone.' : 'Nothing matches this search.'}
                </p>
              )}
          </div>
        </section>
      </div>

      {/* ── BOTTOM BAND: Candidates — the Inspector's slot, answering the drafting question ──
          Rendered only while a plant is in focus, exactly as the Inspector is rendered only while
          something is selected. Read from `GET /schedules/candidates` in the engine's own order;
          nothing here re-sorts or re-filters it (#274, and the brief's "do not move scheduler
          intelligence into React"). */}
      {focusedPlantId && (
        <CandidateColumn plant={focusedCandidates} loading={candidatesLoading} onAssign={assignCandidate} />
      )}

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

      {/* ── THE ACT ──────────────────────────────────────────────────────────────────────────
          One primary action, and it is the only thing on this screen that leads to a write. */}
      <footer className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-3 text-[11px]">
        <span className="text-ink-muted">
          {inDraft.open === 0 ? (
            'Nothing to commit yet.'
          ) : (
            <>
              <b className="text-ink">{inDraft.open}</b> {inDraft.open === 1 ? 'device' : 'devices'} will be added to{' '}
              <b className="text-ink">{readyLanes.length}</b> {readyLanes.length === 1 ? "engineer's" : "engineers'"}{' '}
              plan{readyLanes.length === 1 ? '' : 's'} · <b className="text-ink">{remaining}</b> will remain unassigned
            </>
          )}
        </span>
        <span className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={selectedPlantIds.length === 0} onClick={() => setDistributing(true)}>
            Spread across engineers…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={drafted.size === 0 && unplacedVisible.length === 0}
            onClick={clearDraft}
          >
            Discard draft
          </Button>
          <Button
            size="sm"
            data-testid="assign-review"
            disabled={readyLanes.length === 0 || reviewing}
            loading={reviewing}
            onClick={() => void openReview()}
          >
            Review &amp; commit
          </Button>
        </span>
      </footer>
    </div>
  );
}

/**
 * **The three states, as three steps** — the brief's *available → draft → result*, in the operator's
 * vocabulary rather than the implementation's.
 *
 * Every number here is one the draft already computed for the ledger; none is a new claim and none is
 * a second derivation. What changed is the framing: `Open unassigned / In this draft / Left after
 * commit` are three *facts*, and an operator has to assemble the story from them. Numbered steps with
 * consequence labels tell the story and carry the same facts.
 *
 * **Step 3 is a projection and says so.** It is arithmetic over a draft that has written nothing —
 * `available − staged` — which is exactly why the strip is headed by "Nothing has been written yet"
 * and why the step is worded *will remain*, never *remains*.
 */
function StageRibbon({
  available,
  zoneName,
  staged,
  criticalStaged,
  engineerCount,
  remaining,
  blocked,
  warnings,
}: {
  available: number;
  zoneName: string;
  staged: number;
  criticalStaged: number;
  engineerCount: number;
  remaining: number;
  blocked: number;
  warnings: { overCapacity: number; crossings: number; noCoverage: number };
}) {
  return (
    <section
      data-testid="assign-stage-ribbon"
      aria-label="What happens when you commit"
      className="rounded-lg border border-line bg-surface px-3 py-2"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Step
          n={1}
          testId="stage-available"
          label="Not assigned yet"
          value={available}
          detail={`waiting in ${zoneName}`}
        />
        <Step
          n={2}
          testId="stage-staged"
          label="Selected for assignment"
          value={staged}
          detail={
            staged === 0
              ? 'nothing chosen'
              : `going to ${engineerCount} ${engineerCount === 1 ? 'engineer' : 'engineers'}${criticalStaged > 0 ? ` · ${criticalStaged} critical` : ''}`
          }
          tone="brand"
        />
        <Step
          n={3}
          testId="stage-remaining"
          label="Will remain unassigned"
          value={remaining}
          detail={blocked > 0 ? `including ${blocked} nobody can take` : 'after you commit'}
        />
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-line pt-1.5 text-[11px]">
        {/* The safety line. It is a statement about the *system*, not about this screen's storage, and
            it is true at every moment until the operator presses Commit. */}
        <span data-testid="assign-nothing-written" className="font-medium text-ink">
          Nothing has changed in the system yet
        </span>
        <span className="text-ink-muted">— your draft is written only when you commit, one engineer at a time.</span>

        {/* #290 AC5 — silent on a clean draft: a row of "0 over capacity · 0 crossings" trains the
            operator to stop reading the one place a real warning will appear. */}
        <span className="ml-auto flex flex-wrap items-center gap-1.5" data-testid="ledger-summary">
          {warnings.overCapacity > 0 && (
            <Badge tone="warning" data-testid="summary-over-capacity">
              {warnings.overCapacity} {warnings.overCapacity === 1 ? 'engineer' : 'engineers'} over capacity
            </Badge>
          )}
          {warnings.crossings > 0 && (
            <Badge tone="tierCross" data-testid="summary-crossings">
              {warnings.crossings} tier {warnings.crossings === 1 ? 'crossing' : 'crossings'}
            </Badge>
          )}
          {warnings.noCoverage > 0 && (
            <Badge tone="critical" data-testid="summary-no-coverage">
              {warnings.noCoverage} no coverage
            </Badge>
          )}
        </span>
      </div>
    </section>
  );
}

function Step({
  n,
  testId,
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  n: number;
  testId: string;
  label: string;
  value: number;
  detail: string;
  tone?: 'neutral' | 'brand';
}) {
  return (
    <div data-testid={testId} className="flex items-start gap-2">
      <span
        aria-hidden
        className={cn(
          'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold tabular-nums',
          tone === 'brand' ? 'bg-brand-600 text-white' : 'bg-surface-sunken text-ink-muted',
        )}
      >
        {n}
      </span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-1.5">
          <span className={cn('text-lg font-semibold tabular-nums', tone === 'brand' ? 'text-brand-700' : 'text-ink')}>
            {value}
          </span>
          <span className="truncate text-[11px] font-medium text-ink">{label}</span>
        </span>
        <span className="block text-[10px] text-ink-muted">{detail}</span>
      </span>
    </div>
  );
}

/**
 * **The roster as the lane-target list** (§10, left region).
 *
 * The same people, in the same order, showing the same load as the committed board's personnel column —
 * `committed` and `dailyCapacity` from `committedDayPlan`, the definition the recommender enforces
 * against (#269). Two counts of one engineer's day on one screen is the defect that definition exists
 * to prevent, and the Console is the surface most able to show both at once.
 *
 * **The row is the verb.** With work ticked in the pool, every row becomes *"Add 3 →"*; with nothing
 * ticked it is a fact row. That is the whole of "who is receiving it" — no dropdown, no lane numbers,
 * and the answer to *is this a good idea?* (load, coverage, availability) is on the same row as the
 * button that does it.
 *
 * **Nothing is disabled.** An engineer who is over capacity or on leave still takes the work if the
 * operator says so (#258 Q2 — manual overload is an administrative right); the row states the fact
 * and the draft's own warnings count it.
 */
function AssignPeopleRail({
  engineers,
  roster,
  stagedFor,
  laneAfter,
  selectedCount,
  onAssignSelected,
}: {
  engineers: TodayEngineer[];
  roster: ZoneEngineer[];
  stagedFor: (seId: string) => number;
  laneAfter: (seId: string) => number;
  selectedCount: number;
  onAssignSelected: (seId: string) => void;
}) {
  const known = new Set(roster.map((e) => e.engineerId));
  return (
    <section
      data-testid="assign-people-rail"
      aria-label="Engineers"
      className="flex max-h-[calc(100vh-14rem)] flex-col gap-2 rounded-lg border border-line bg-surface p-3"
    >
      <h2 className="flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        {selectedCount > 0 ? 'Add to whose plan?' : 'Engineers'}
        <span className="tabular-nums text-ink">{engineers.length}</span>
      </h2>

      {engineers.length === 0 ? (
        <p className="text-[11px] text-ink-muted">No engineers on this zone's roster yet.</p>
      ) : (
        <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
          {engineers.filter((e) => known.has(e.seId)).map((e) => {
            const staged = stagedFor(e.seId);
            const after = laneAfter(e.seId);
            const over = isOverCapacity({ committed: after, dailyCapacity: e.dailyCapacity });
            const unavailable = e.availability !== 'AVAILABLE';
            const actionable = selectedCount > 0;
            return (
              <li key={e.seId}>
                <button
                  type="button"
                  data-testid={`assign-target-${e.seId}`}
                  aria-label={
                    actionable
                      ? `Add ${selectedCount} selected ${selectedCount === 1 ? 'site' : 'sites'} to ${e.name}'s plan`
                      : e.name
                  }
                  disabled={!actionable}
                  onClick={() => onAssignSelected(e.seId)}
                  className={cn(
                    'w-full rounded-md border px-2 py-1.5 text-left transition-colors',
                    actionable
                      ? 'border-brand-600/50 bg-surface hover:border-brand-600 hover:bg-brand-300/15'
                      : 'cursor-default border-transparent',
                    staged > 0 && 'border-brand-600 bg-brand-300/10',
                  )}
                >
                  <span className="flex items-baseline gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">{e.name}</span>
                    {/* `committed → after` while the draft holds work for them, so the cost of the
                        row's own button is on the row. Never a second read: `after` is the same
                        arithmetic the lane and the review screen use. */}
                    {staged > 0 ? (
                      <span
                        data-testid={`assign-target-load-${e.seId}`}
                        data-over-capacity={String(over)}
                        className={cn('tabular-nums text-[11px]', over ? 'font-semibold text-warning' : 'text-ink-muted')}
                      >
                        {e.committed} → {after} / {e.dailyCapacity}
                      </span>
                    ) : (
                      <LoadBadge committed={e.committed} dailyCapacity={e.dailyCapacity} seId={e.seId} />
                    )}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-ink-muted">
                    <Badge tone="neutral">{e.coverageType.replace(/_/g, ' ')}</Badge>
                    {staged > 0 && (
                      <span data-testid={`assign-target-staged-${e.seId}`} className="font-medium text-brand-700">
                        +{staged} staged
                      </span>
                    )}
                    {unavailable && (
                      <span className="text-warning">{e.availability.replace(/_/g, ' ').toLowerCase()}</span>
                    )}
                    {actionable && <span className="ml-auto font-medium text-brand-700">Add {selectedCount} →</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * **One engineer's draft lane** — the centre region's row, named after the person rather than after a
 * lane number.
 *
 * `data-testid="draft-lane-<seId>"`. The committed board's lanes are `lane-<seId>`; the two are never
 * on screen together (§3.4 is enforced structurally by Assign mode replacing the board), and the
 * distinct prefix means the test suite can assert that without depending on which numbers happen to
 * exist. The collision between `lane-<seId>` and `lane-<n>` is what put the mixed-commitment rule on
 * the record in the first place — this is that lesson applied to the new vocabulary.
 *
 * The chip grammar is `grammar.tsx`'s, unchanged (#290): solid = inside the engineer's own coverage,
 * dashed violet = a human crossed a tier, heavy crimson + flag = critical work, dashed crimson = the
 * engineer covers this plant at no tier. A lane whose draft takes its engineer past capacity is amber
 * — **a state, never a barrier**.
 */
function DraftLane({
  lane,
  engineers,
  totals,
  candidateView,
  plantName,
  after,
  onSetEngineer,
  onRemovePlant,
  onClear,
  onFocusPlant,
}: {
  lane: Lane;
  engineers: ZoneEngineer[];
  totals: Map<string, { openUnassigned: number; criticalCount: number; companies: Set<string> }>;
  candidateView: Parameters<typeof laneCoverage>[2];
  plantName: (plantId: string) => string;
  after: number;
  onSetEngineer: (seId: string) => void;
  onRemovePlant: (plantId: string) => void;
  onClear: () => void;
  onFocusPlant: (plantId: string) => void;
}) {
  const eng = engineers.find((e) => e.engineerId === lane.seId);
  const over =
    typeof eng?.dailyCapacity === 'number' && isOverCapacity({ committed: after, dailyCapacity: eng.dailyCapacity });
  const coverageFacts = eng ? laneCoverage(eng.engineerId, lane.plantIds, candidateView, plantName) : [];
  const factFor = (plantId: string) => coverageFacts.find((c) => c.plantId === plantId) ?? null;
  const staged = lane.plantIds.reduce(
    (n, id) => n + (lane.ticketOverrides?.[id]?.length ?? totals.get(id)?.openUnassigned ?? 0),
    0,
  );

  return (
    <div
      data-testid={eng ? `draft-lane-${eng.engineerId}` : `draft-lane-unassigned-${lane.id}`}
      data-over-capacity={String(over)}
      className={cn('rounded-md border bg-surface p-2', over ? 'border-warning bg-warning-bg/30' : 'border-line')}
    >
      <div className="flex flex-wrap items-center gap-2">
        {eng ? (
          <span className="text-[12px] font-semibold text-ink">
            Will be added to {eng.name}
            <span className="ml-1 font-normal text-ink-muted">— {staged} {staged === 1 ? 'device' : 'devices'}</span>
          </span>
        ) : (
          // Reachable only through a path that staged work without a target (a Distribute lane whose
          // engineer was cleared). Kept because losing the work would be worse than an odd row.
          <select
            aria-label={`Engineer for lane ${lane.id}`}
            value={lane.seId}
            onChange={(e) => onSetEngineer(e.target.value)}
            className="rounded-md border border-line px-2 py-1 text-[11px]"
          >
            <option value="">Choose an engineer…</option>
            {engineers.map((e) => (
              <option key={e.engineerId} value={e.engineerId}>
                {e.name}
              </option>
            ))}
          </select>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
          Take back
        </Button>
      </div>

      {/* #274 — coverage per (engineer, plant) and the load this draft would add. Both are states the
          dispatcher reads before committing, and neither is a gate. */}
      {eng && lane.plantIds.length > 0 && (
        <LaneHeader
          seId={eng.engineerId}
          coverage={coverageFacts}
          committed={eng.committed ?? 0}
          after={after}
          dailyCapacity={typeof eng.dailyCapacity === 'number' ? eng.dailyCapacity : null}
        />
      )}

      <div className="mt-2 flex flex-wrap gap-1">
        {lane.plantIds.map((plantId) => {
          const t = totals.get(plantId);
          const override = lane.ticketOverrides?.[plantId];
          const name = plantName(plantId);
          const fact = factFor(plantId);
          const placed = override ? override.length : (t?.openUnassigned ?? 0);
          /**
           * #290 AC3 — critical work is its **own chip**, as the design draws it. One chip totalling
           * both hides the only number a dispatcher triages by: a plant reading `×15` says nothing
           * about whether any of it is on a clock.
           *
           * Suppressed when a strategy handed this lane only part of the plant (#276's
           * `ticketOverrides`): the plant's critical count is a fact about the *plant*, and asserting
           * it of an arbitrary subset would be a fabricated number (#282 R6).
           */
          const critical = override ? 0 : Math.min(t?.criticalCount ?? 0, placed);
          const remainder = placed - critical;
          /**
           * The remove control belongs to the **plant**, not to a chip, so exactly one is rendered
           * even when the plant splits into a critical chip and a remainder. Two buttons doing the
           * identical thing to the identical object would claim a granularity the draft does not
           * have — a lane holds plants, and there is no way to drop "the critical half" of one.
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
              {/* The dot is the grammar's own mark for "inside the engineer's own coverage"; a
                  critical chip carries a flag instead, so the two are distinguishable with the
                  colour removed. */}
              {opts.meaning === 'CRITICAL' ? (
                <span aria-hidden>⚑</span>
              ) : (
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
              )}
              <button
                type="button"
                aria-label={`Candidates for ${name}`}
                onClick={() => onFocusPlant(plantId)}
                className="hover:underline"
              >
                {formatPlantDisplayName(name)}
              </button>
              <span className="tabular-nums opacity-80">
                ×{opts.qty}
                {/* #276 — a strategy that only handed part of this plant's work here, said out loud. */}
                {override && ` of ${t?.openUnassigned ?? '?'}`}
              </span>
              {opts.removable && (
                <button
                  type="button"
                  aria-label={`Remove ${name} from ${eng?.name ?? `lane ${lane.id}`}`}
                  onClick={() => onRemovePlant(plantId)}
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
      </div>
    </div>
  );
}
