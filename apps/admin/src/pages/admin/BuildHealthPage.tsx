import { useCallback, useEffect, useState } from 'react';
import {
  apiIntegrationHealth,
  type FreshnessHealth,
  type IngestionAlertHealth,
  type IntegrationHealthView,
  type IntegrationSourceHealth,
  type LifecycleHealth,
  type LifecycleRunEntry,
  type RecomputeLedgerEntry,
} from '../../api/integrationHealth';
import { apiSnapshotRuns, type SnapshotRunView } from '../../api/snapshots';
import { DataTable, ErrorState, FilterSelect, PageHeader, type Column } from '../../components/data';
import { Badge, Button, SectionCard } from '../../components/ui';

/**
 * #131 — the routed drill-down for #130's L3 run attribution + L5 semantic canary. Superset of what
 * `BuildHealthNotice` (the global-banner summary alert) already flags: the current build high-water
 * mark, per-freshness `staleBuild` flags, and the last-N `device_state_recomputes` history with the
 * canary's swing rows highlighted — so an operator can spot the run-65-shaped anomaly (a large
 * eligible-count swing under a stale build) at a glance, not just be told "something's off".
 *
 * #349 — and the four sections it dropped. The backend has always returned source connectivity, both
 * freshness ages, reconciliation and the #218 lifecycle check; this page modelled four fields of that
 * payload and drew three cards, so the one question it exists for — *is the pipeline working right
 * now, and if not, since when* — was answerable only from data already on the wire and never drawn.
 * `GET /snapshots/runs` had no consumer at all until the run-history table below.
 *
 * The page is an EXTENSION of #131, not a redraw (there is no v2 reference for it — the page is the
 * authority). The three original cards are untouched; the new sections sit above them because "is it
 * running" outranks "which build ran it", and every one of them self-gates on an absent payload
 * section so an older backend degrades to the previous page rather than a white screen.
 *
 * Display-only, per the #130 Slice 2 boundary, with the one exception #129's health AC needed: the
 * per-run departure churn had to be derived server-side, because nothing read `entity_stats` or
 * `cancelled_tickets_count` back out.
 *
 * Role is unchanged: OPERATIONS_HEAD only, gated at the nav (`shell/nav.ts`) and at the two routes.
 */

/** Rows per page of the snapshot run history. The route returns no total, so a short page is the end. */
const RUNS_PAGE_SIZE = 20;

export function BuildHealthPage() {
  const [health, setHealth] = useState<IntegrationHealthView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    apiIntegrationHealth()
      .then(setHealth)
      .catch(() => setError('Failed to load build health'));
  };
  useEffect(load, []);

  const columns: Column<RecomputeLedgerEntry>[] = [
    { key: 'computedAt', header: 'Computed At', render: (r) => new Date(r.computedAt).toLocaleString() },
    { key: 'eligible', header: 'Eligible', align: 'right', render: (r) => r.eligibleCount.toLocaleString() },
    { key: 'inactive', header: 'Inactive', align: 'right', render: (r) => r.inactiveCount.toLocaleString() },
    { key: 'departed', header: 'Departed', align: 'right', render: (r) => r.departedCount.toLocaleString() },
    { key: 'total', header: 'Total', align: 'right', render: (r) => r.totalCount.toLocaleString() },
    { key: 'trigger', header: 'Trigger', render: (r) => <Badge tone="neutral">{r.trigger}</Badge> },
    {
      key: 'build',
      header: 'Build',
      render: (r) => (
        <span className="flex items-center gap-1.5 font-mono text-xs">
          {r.buildFingerprint ?? '—'}
          {r.staleBuild && (
            <Badge tone="warning" title="Below the current runtime-lock version">
              stale
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: 'swing',
      header: 'Swing',
      align: 'right',
      render: (r) =>
        r.swingPct == null ? (
          <span className="text-ink-muted">—</span>
        ) : (
          <span className={r.swing ? 'font-semibold text-critical' : 'text-ink-muted'}>
            {r.swingPct > 0 ? '+' : ''}
            {r.swingPct.toFixed(1)}%
          </span>
        ),
    },
  ];

  return (
    <section>
      {/* Titled to match its nav entry, not to the issue's name for it: renaming the H1 to
          "Integration Health" while `shell/nav.ts` still reads "Build Health" would leave the
          operator's landmark and the page disagreeing, and the nav label is not this slice's to
          change. The subtitle carries the widened scope instead. */}
      <PageHeader
        title="Build Health"
        subtitle="Integration health for the AutoPlant pipeline — source connectivity, freshness, deployment lifecycle and run history — and which build produced each run (#130)."
      />

      {error && <ErrorState message={error} onRetry={load} />}

      {health && (
        <>
          <IngestionAlertCard ingestion={health.ingestion} />

          <SourceCard source={health.source} />

          <FreshnessCard
            masterSync={health.masterSync}
            snapshot={health.snapshot}
            schedulerEnabled={health.schedulerEnabled}
          />

          <LifecycleCard lifecycle={health.lifecycle} />

          <SnapshotRunHistoryCard />

          <SectionCard title="Current build" className="mb-4">
            <p className="text-sm text-ink">
              Runtime lock: <span className="font-mono font-semibold">v{health.runtimeLock.version ?? '—'}</span>{' '}
              <span className="font-mono text-ink-muted">({health.runtimeLock.fingerprint ?? 'unstamped'})</span>
            </p>
            <div className="mt-3 flex flex-wrap gap-4 text-sm">
              <div data-testid="build-health-master-sync" className="flex items-center gap-2">
                <span className="text-ink-muted">Master sync:</span>
                <FreshnessBuildBadge build={health.masterSync.build} />
              </div>
              <div data-testid="build-health-snapshot" className="flex items-center gap-2">
                <span className="text-ink-muted">Snapshot:</span>
                <FreshnessBuildBadge build={health.snapshot.build} />
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Recompute history (last 10)">
            <DataTable
              columns={columns}
              rows={health.recomputes}
              rowKey={(r) => r.recomputeId}
              rowTestId={(r) => `recompute-row-${r.recomputeId}`}
              ariaLabel="Recompute history"
              rowActive={(r) => r.swing}
              activeVariant="danger"
              empty={<p className="py-6 text-center text-sm text-ink-muted">No recompute history yet.</p>}
            />
          </SectionCard>
        </>
      )}
    </section>
  );
}

/**
 * #300 — the wedged-ingestion card. Renders only when the pipeline is actually gated, so the page
 * stays quiet in the steady state (the same self-gating posture as `BuildHealthNotice`); tone goes
 * from amber to red once the streak crosses the alert threshold.
 *
 * It names the four things an operator needs before they can act, none of which were anywhere on
 * screen before: how long the pipeline has been stuck, WHICH chunk and error keeps killing it, what
 * the run threw away on the way through (#299's rejected/repaired tallies), and which downstream
 * stages the #230 gate has been skipping the whole time.
 */
function IngestionAlertCard({ ingestion }: { ingestion: IngestionAlertHealth | undefined }) {
  // Defensive against an older payload — an absent section must render nothing, never crash the page.
  if (!ingestion || !ingestion.downstreamGated) return null;

  const critical = ingestion.alert;
  const rejected = Object.entries(ingestion.rejected ?? {});
  const repaired = Object.entries(ingestion.repaired ?? {});

  return (
    <SectionCard title="Telemetry ingestion" className="mb-4">
      <div
        role="alert"
        data-testid="ingestion-alert"
        className={
          critical
            ? 'rounded border border-red-200 bg-red-50 p-4 text-sm text-red-900'
            : 'rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900'
        }
      >
        <p className="font-semibold">
          {ingestion.streak > 1
            ? `${ingestion.streak} consecutive telemetry runs did not complete`
            : 'The last telemetry run did not complete'}
          {ingestion.latestStatus ? ` (latest: ${ingestion.latestStatus})` : ''}
          {critical && ingestion.streak >= ingestion.threshold ? ` — over the alert threshold of ${ingestion.threshold}` : ''}
        </p>

        <p className="mt-2" data-testid="ingestion-gated-stages">
          Gated off since then: <span className="font-medium">{ingestion.gatedStages.join(', ')}</span>. No Failure
          Cycle is opened on evidence these runs did not read.
        </p>

        {ingestion.failingChunk ? (
          <p className="mt-2" data-testid="ingestion-failing-chunk">
            Failing chunk: run <span className="font-mono">{ingestion.failingChunk.runId}</span>, chunk{' '}
            <span className="font-mono">#{ingestion.failingChunk.chunkNo}</span> after{' '}
            {ingestion.failingChunk.retryCount} retr{ingestion.failingChunk.retryCount === 1 ? 'y' : 'ies'} —{' '}
            <span className="font-mono">{ingestion.failingChunk.error ?? 'no error recorded'}</span>
            {ingestion.repeatingFailure && (
              <Badge tone="warning" className="ml-2">
                same error every run
              </Badge>
            )}
          </p>
        ) : (
          <p className="mt-2 opacity-80">
            No chunk write failed — the source read itself stopped part-way, so the runs finished on
            whatever had already landed.
          </p>
        )}

        {(rejected.length > 0 || repaired.length > 0) && (
          <p className="mt-2" data-testid="ingestion-rejections">
            {rejected.length > 0 && (
              <>
                Rows dropped: {rejected.map(([reason, n]) => `${reason} ×${n}`).join(', ')} — each is a device with
                no ping in these runs.{' '}
              </>
            )}
            {repaired.length > 0 && (
              <>Fields repaired: {repaired.map(([reason, n]) => `${reason} ×${n}`).join(', ')} (rows kept).</>
            )}
          </p>
        )}
      </div>
    </SectionCard>
  );
}

function FreshnessBuildBadge({ build }: { build: IntegrationHealthView['masterSync']['build'] }) {
  if (!build) return <span className="text-ink-muted">—</span>;
  return build.staleBuild ? (
    <Badge tone="warning">stale (v{build.buildVersion})</Badge>
  ) : (
    <Badge tone="success">current</Badge>
  );
}

/** Whole minutes as something an operator reads at a glance — "45 min", "21 h", "2 h 10 min". */
function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

const formatWhen = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * #349 — source connectivity. `IntegrationSourceHealth` has been on the payload since the endpoint
 * existed and was never rendered, which left the page unable to distinguish the two states an
 * operator most needs apart: the pipeline is broken, versus the VPN to AutoPlant is down and the
 * pipeline is fine. `configured` separates a dev/test box with the env unset from a live outage —
 * without it "not connected" reads as an incident on every developer's machine.
 */
function SourceCard({ source }: { source: IntegrationSourceHealth | undefined }) {
  if (!source) return null;

  const tone = source.connected ? 'success' : source.configured ? 'critical' : 'neutral';
  const label = source.connected ? 'Connected' : source.configured ? 'Not reachable' : 'Not configured';

  return (
    <SectionCard title="Source connectivity" className="mb-4">
      <div data-testid="integration-source" className="text-sm text-ink">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-ink-muted">AutoPlant MySQL:</span>
          <Badge tone={tone}>{label}</Badge>
          {source.vehicleRows !== undefined && (
            <span className="text-ink-muted">
              probe read <span className="font-semibold tabular-nums text-ink">{source.vehicleRows.toLocaleString()}</span>{' '}
              vehicle rows
            </span>
          )}
        </div>
        {source.error && (
          <p className="mt-2 font-mono text-xs text-ink-muted" data-testid="integration-source-error">
            {source.error}
          </p>
        )}
        {!source.connected && source.configured && (
          <p className="mt-2 text-xs text-ink-muted">
            Freshness, lifecycle and run history below are derived inside FSM and stay truthful while the
            source is unreachable — only the source-vs-FSM reconciliation stops being computable.
          </p>
        )}
      </div>
    </SectionCard>
  );
}

/**
 * #349 / #348 — how old each feed is, and the threshold that age is judged against.
 *
 * `ageMinutes` was computed by the backend from the first day and compared with nothing anywhere, so
 * a 21-hour-old snapshot and a two-minute-old one drew the same line on every surface. The verdict
 * (`stale`) and its yardstick (`staleAfterMinutes`, twice the feed's own configured cron cadence) are
 * both shown: "stale" with no figure is not something an operator can act on, and the figure is what
 * says whether this is one missed tick or a dead scheduler.
 */
function FreshnessCard({
  masterSync,
  snapshot,
  schedulerEnabled,
}: {
  masterSync: FreshnessHealth | undefined;
  snapshot: FreshnessHealth | undefined;
  schedulerEnabled: boolean | undefined;
}) {
  // An older payload carries `build` but no verdict — render nothing rather than an empty card.
  if (typeof masterSync?.staleAfterMinutes !== 'number' && typeof snapshot?.staleAfterMinutes !== 'number') {
    return null;
  }

  return (
    <SectionCard title="Data freshness" className="mb-4">
      {schedulerEnabled === false && (
        <p
          role="status"
          data-testid="scheduler-paused"
          className="mb-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          Ingestion is <span className="font-semibold">paused</span> — the scheduler master switch is off, so
          the crons are dormant by choice. Nothing below is overdue; nothing below is fresh either.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <FreshnessRow testId="freshness-masterSync" label="Master sync" feed={masterSync} />
        <FreshnessRow testId="freshness-snapshot" label="Telemetry snapshot" feed={snapshot} />
      </div>
    </SectionCard>
  );
}

function FreshnessRow({
  testId,
  label,
  feed,
}: {
  testId: string;
  label: string;
  feed: FreshnessHealth | undefined;
}) {
  if (!feed || typeof feed.staleAfterMinutes !== 'number') return null;

  return (
    <div data-testid={testId} className="rounded-md border border-line bg-surface-sunken px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</span>
        {feed.stale ? <Badge tone="critical">Stale</Badge> : <Badge tone="success">Fresh</Badge>}
      </div>
      <p className="mt-1 text-lg font-semibold text-ink-strong">
        {feed.ageMinutes === null ? 'No successful run on record' : formatAge(feed.ageMinutes)}
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        Data as of {formatWhen(feed.lastAt)}
        {feed.lastStatus && <> · last run {feed.lastStatus}</>}
      </p>
      {/* The yardstick, deliberately not spelled with the word "stale": the badge is the verdict, this
          is the number it was measured against. */}
      <p className="mt-1 text-xs text-ink-muted">Threshold {formatAge(feed.staleAfterMinutes)} (2× cadence)</p>
    </div>
  );
}

/**
 * #349 / #224 / #218 — the lifecycle check finally reaches a screen.
 *
 * `drift` is a CONTRADICTION, not a measurement: `vehicles.status` and `device_states.is_departed`
 * are written from the same master-sync read, so its correct value is exactly 0 and any non-zero is a
 * defect by construction. It is worded as such and given no tolerance band, per #224 — a number that
 * reads like a tolerable metric is a number nobody chases.
 *
 * `missingFromSource` sits BESIDE it and is never folded in (218a's whole point: the excluded
 * population is surfaced, not hidden). Neither joins the KPI strip — those tiles count devices by
 * lifecycle state, while these count a disagreement *about* it, and putting them together invites
 * subtraction between non-commensurable numbers.
 */
function LifecycleCard({ lifecycle }: { lifecycle: LifecycleHealth | undefined }) {
  if (!lifecycle) return null;

  const runs = Array.isArray(lifecycle.runs) ? lifecycle.runs : [];

  const columns: Column<LifecycleRunEntry>[] = [
    { key: 'run', header: 'Run', render: (r) => <span className="font-mono text-xs">{r.runId}</span> },
    { key: 'when', header: 'Finished', render: (r) => formatWhen(r.finishedAt ?? r.startedAt) },
    { key: 'status', header: 'Status', render: (r) => <Badge tone="neutral">{r.status}</Badge> },
    { key: 'departed', header: 'Departed', align: 'right', render: (r) => r.departed.toLocaleString() },
    { key: 'restored', header: 'Restored', align: 'right', render: (r) => r.restored.toLocaleString() },
    {
      key: 'autoClosed',
      header: 'Tickets auto-closed',
      align: 'right',
      render: (r) => r.ticketsAutoClosed.toLocaleString(),
    },
    {
      key: 'note',
      header: '',
      render: (r) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {r.quiet && (
            <Badge tone="warning" title="The lifecycle pass ran and moved nothing">
              quiet
            </Badge>
          )}
          {Object.entries(r.skippedByReason ?? {}).map(([reason, n]) => (
            <Badge key={reason} tone="critical">
              {reason} ×{n}
            </Badge>
          ))}
        </span>
      ),
      exportable: false,
    },
  ];

  return (
    <SectionCard title="Deployment lifecycle" className="mb-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div
          data-testid="lifecycle-drift"
          className={
            lifecycle.drift === 0
              ? 'rounded-md border border-line bg-surface-sunken px-3 py-2'
              : 'rounded-md border border-red-200 bg-red-50 px-3 py-2'
          }
        >
          <div className="text-xs uppercase tracking-wide text-ink-muted">Contradicting devices</div>
          <div className={`text-lg font-semibold ${lifecycle.drift === 0 ? 'text-ink-strong' : 'text-critical'}`}>
            {lifecycle.drift.toLocaleString()}
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            Source status and departure flag contradict each other. The correct value is 0 — this is a
            defect count, not a tolerance.
          </p>
        </div>

        <div data-testid="lifecycle-missing-from-source" className="rounded-md border border-line bg-surface-sunken px-3 py-2">
          <div className="text-xs uppercase tracking-wide text-ink-muted">Missing from source</div>
          <div className="text-lg font-semibold text-ink-strong">{lifecycle.missingFromSource.toLocaleString()}</div>
          <p className="mt-1 text-xs text-ink-muted">
            Departed because their source row vanished — the mirror is frozen by design, so they are
            excluded from the contradiction count and reported here instead.
          </p>
        </div>

        <div
          data-testid="lifecycle-quiet-runs"
          className={
            lifecycle.quietRunsAlert
              ? 'rounded-md border border-red-200 bg-red-50 px-3 py-2'
              : 'rounded-md border border-line bg-surface-sunken px-3 py-2'
          }
        >
          <div className="text-xs uppercase tracking-wide text-ink-muted">Quiet syncs</div>
          <div className={`text-lg font-semibold ${lifecycle.quietRunsAlert ? 'text-critical' : 'text-ink-strong'}`}>
            {lifecycle.quietRuns.toLocaleString()}
            <span className="ml-1 text-xs font-normal text-ink-muted">
              / {lifecycle.quietRunsThreshold.toLocaleString()} tolerated
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            {lifecycle.quietRunsAlert
              ? 'Consecutive syncs that moved no device either way — on a churning fleet that means the lifecycle pass is not executing.'
              : 'Consecutive syncs that recorded neither a departure nor a restore.'}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <DataTable
          columns={columns}
          rows={runs}
          rowKey={(r) => r.runId}
          rowTestId={(r) => `lifecycle-run-${r.runId}`}
          ariaLabel="Lifecycle churn per master sync"
          rowActive={(r) => r.quiet}
          toolbarTitle="Per-run churn"
          empty={<p className="py-6 text-center text-sm text-ink-muted">No master sync has run yet.</p>}
        />
      </div>
    </SectionCard>
  );
}

const RUN_STATUSES = ['SUCCESS', 'PARTIAL', 'FAILED', 'RUNNING'] as const;

/**
 * #349 AC2 — the snapshot run history: the first consumer `GET /snapshots/runs` has ever had.
 *
 * The route has been guarded, paged and filterable since Issue 04 slice 7, and every telemetry
 * failure an operator was asked about ("since when has this been broken?") had to be answered from
 * logs. It returns a bare array with no total, so paging is honest about what it can know: a full
 * page means there may be more, a short page is the end.
 */
function SnapshotRunHistoryCard() {
  const [rows, setRows] = useState<SnapshotRunView[]>([]);
  const [status, setStatus] = useState<string>('');
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiSnapshotRuns({ limit: RUNS_PAGE_SIZE, offset, status: status || undefined })
      .then(setRows)
      .catch(() => setError('Failed to load run history'))
      .finally(() => setLoading(false));
  }, [offset, status]);
  useEffect(load, [load]);

  const columns: Column<SnapshotRunView>[] = [
    { key: 'run', header: 'Run', render: (r) => <span className="font-mono text-xs">{r.runId}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <Badge tone={r.status === 'SUCCESS' ? 'success' : r.status === 'RUNNING' ? 'info' : 'critical'}>
          {r.status}
        </Badge>
      ),
    },
    { key: 'started', header: 'Started', render: (r) => formatWhen(r.startedAt) },
    { key: 'finished', header: 'Finished', render: (r) => formatWhen(r.finishedAt) },
    { key: 'asOf', header: 'Data as of', render: (r) => formatWhen(r.dataAsOf) },
    {
      key: 'error',
      header: 'Reason',
      // #348 — `ORPHANED_RUN_ERROR` is the reaper closing a run whose process died. Without it a
      // restart and a real ingestion failure are the same bare FAILED row.
      render: (r) =>
        r.error ? <span className="font-mono text-xs text-critical">{r.error}</span> : <span className="text-ink-muted">—</span>,
    },
  ];

  // The route returns no total, so "there may be more" is exactly "this page came back full".
  const hasMore = rows.length === RUNS_PAGE_SIZE;

  return (
    <SectionCard title="Snapshot run history" className="mb-4">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.runId}
        rowTestId={(r) => `snapshot-run-${r.runId}`}
        ariaLabel="Snapshot run history"
        snoOffset={offset}
        loading={loading && rows.length === 0}
        error={error}
        onRetry={load}
        toolbar={
          <FilterSelect
            aria-label="Run status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              // A new filter is a new result set; keeping the offset would land on a blank page.
              setOffset(0);
            }}
          >
            <option value="">All statuses</option>
            {RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </FilterSelect>
        }
        empty={<p className="py-6 text-center text-sm text-ink-muted">No snapshot runs for this filter.</p>}
      />
      <nav aria-label="Snapshot run history pages" className="mt-3 flex items-center justify-between gap-3">
        <Button
          size="sm"
          variant="secondary"
          data-testid="snapshot-runs-prev"
          disabled={offset === 0}
          onClick={() => setOffset((o) => Math.max(0, o - RUNS_PAGE_SIZE))}
        >
          ‹ Prev
        </Button>
        <span className="text-xs text-ink-muted tabular-nums">
          Runs {rows.length === 0 ? 0 : offset + 1}–{offset + rows.length}
        </span>
        <Button
          size="sm"
          variant="secondary"
          data-testid="snapshot-runs-next"
          disabled={!hasMore}
          onClick={() => setOffset((o) => o + RUNS_PAGE_SIZE)}
        >
          Next ›
        </Button>
      </nav>
    </SectionCard>
  );
}
