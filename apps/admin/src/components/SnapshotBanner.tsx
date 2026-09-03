import { useCallback, useEffect, useState } from 'react';
import { apiSnapshotLatest, type IngestionAlertHealth, type SnapshotLatestView } from '../api/snapshots';
import { useAuth } from '../auth/AuthProvider';
import { onIngestionComplete } from '../pages/dashboard/ingestionEvents';
import { BuildHealthNotice } from './BuildHealthNotice';

/**
 * The Snapshot freshness banner (Issue 04 AC#5/#6). Rides the top of every admin page: it shows
 * the data-as-of timestamp from the last successful Snapshot, and flips to a red alert when the
 * most recent run FAILED or is stuck RUNNING past the expected window.
 *
 * A snapshot targets <10 min (AC#7); a run still RUNNING past STUCK_AFTER_MS is treated as stuck.
 *
 * Live (Issue 122b): the banner re-reads on a poll AND immediately after a manual "Run Ingestion
 * Now" completes — previously it fetched once on mount, so a recovered (or newly failed) run kept
 * showing the stale verdict until a full page reload.
 *
 * #300 — a PARTIAL run used to render here as the ordinary grey "data as of …" line, which is the
 * exact reading an operator must not get: PARTIAL means the #230 gate skipped device-state
 * derivation, auto-recovery and ticket creation, so the number on screen describes a fleet nothing
 * has re-derived. The banner now states the gate whenever it is closed, and reports the partial
 * watermark under its own name rather than as freshness. The wedge DETAIL (which chunk, which error,
 * how many rows were dropped) belongs on the OH Build Health page; this line's job is to make sure
 * nobody reads a frozen pipeline as a healthy one.
 *
 * #348 — three states this line could not express, all of which rendered as the quiet grey timestamp:
 *
 *  - **Overdue.** Nothing here judged the AGE of `dataAsOf`. `isStuck` below flags only a run still
 *    RUNNING past 15 minutes, so a snapshot that succeeded 21 hours ago and a snapshot two minutes
 *    old drew exactly the same line. The backend now decides this (`overdue`, from the configured
 *    cron cadence) and the banner states it in red.
 *  - **Paused.** The scheduler master switch can be off on purpose. That must not raise an alarm —
 *    and must not read as "fresh" either, so it gets its own amber "Ingestion paused" line (AC4).
 *  - **Unreadable.** The fetch error was caught and dropped on the floor, which is precisely how the
 *    `/snapshots/latest` 403 for WM and SE sessions stayed invisible: the banner just did not appear,
 *    and nobody could tell that from a healthy pipeline. A failed read is now stated — quietly,
 *    because an unreachable API is evidence about the API, not about ingestion.
 */
const STUCK_AFTER_MS = 15 * 60 * 1000;
const POLL_MS = 60 * 1000;

/**
 * #348 — the freshness fields, declared locally.
 *
 * `api/snapshots.ts` still types the #300 payload; these are additive on the wire and optional here
 * so a new FE against a not-yet-deployed BE degrades to the previous behaviour rather than crashing
 * the one component that rides every page. Folding them into the shared `SnapshotLatestView` /
 * `IngestionAlertHealth` types is left to the slice that also teaches the health card to read them
 * (#349/#351) — this file does not own that module.
 */
type IngestionFreshness = IngestionAlertHealth & {
  /** Whole minutes since the newest SUCCESS run; null when none is on record. */
  silenceMinutes?: number | null;
  /** The age at which silence becomes `overdue` — twice the configured cron cadence. */
  overdueAfterMinutes?: number;
  expectedCadenceMinutes?: number;
  schedulerPaused?: boolean;
  overdue?: boolean;
};

type SnapshotFreshnessView = SnapshotLatestView & {
  ingestion?: IngestionFreshness;
  /** No SUCCESS run inside twice the configured cadence, while the scheduler is meant to be running. */
  overdue?: boolean;
  /** The scheduler is switched off — ingestion is stopped on purpose. */
  schedulerPaused?: boolean;
};

function isStuck(view: SnapshotFreshnessView): boolean {
  const latest = view.latest;
  if (!latest || latest.status !== 'RUNNING') return false;
  return Date.now() - new Date(latest.startedAt).getTime() > STUCK_AFTER_MS;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Whole minutes as something an operator reads at a glance — "45 min", "21 h", "2 h 10 min". */
function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Plain-language "why it stopped advancing" — the sentence the freshness line was missing. */
function gatedSummary(ingestion: IngestionAlertHealth): string {
  const runs =
    ingestion.streak > 1 ? `The last ${ingestion.streak} telemetry runs` : 'The last telemetry run';
  const stages =
    ingestion.gatedStages.length > 0 ? ingestion.gatedStages.join(', ') : 'downstream processing';
  return `${runs} did not complete, so ${stages} are paused.`;
}

/**
 * #348 — the silence sentence. It names the failure ("nothing has succeeded") rather than hedging
 * about staleness, and it carries the number: "old" without a figure is not something anyone can act
 * on, and it is the figure that tells an operator whether this is a missed tick or a dead scheduler.
 */
function silenceSummary(ingestion: IngestionFreshness | undefined): string {
  const age = ingestion?.silenceMinutes;
  return typeof age === 'number'
    ? `No successful telemetry run in ${formatAge(age)} — ingestion has stopped.`
    : 'No successful telemetry run on record — ingestion has stopped.';
}

export function SnapshotBanner() {
  const { session } = useAuth();
  const [view, setView] = useState<SnapshotFreshnessView | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(() => {
    apiSnapshotLatest()
      .then((next) => {
        setView(next as SnapshotFreshnessView);
        setUnavailable(false);
      })
      .catch(() => {
        // #348 — stated, not swallowed. The page is never blocked, but "we could not read freshness"
        // and "freshness is fine" stop being the same rendering.
        setUnavailable(true);
      });
  }, []);

  useEffect(() => {
    if (!session) return;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    // A completed manual ingestion run changes the verdict right now — re-read immediately.
    const off = onIngestionComplete(refresh);
    return () => {
      clearInterval(id);
      off();
    };
  }, [session, refresh]);

  // Hidden when logged out (e.g. the login page). The OpsHead build-health notice self-gates and
  // only renders on a real warning, so it rides alongside the snapshot line without disturbing it.
  if (!session) return null;

  const failed = view?.latest?.status === 'FAILED';
  const stuck = view ? isStuck(view) : false;
  // Defensive against an older/partial payload — this rides every page and must never crash it.
  const ingestion = view?.ingestion;
  const gated = ingestion?.downstreamGated === true;
  const wedged = ingestion?.alert === true;
  const partialAsOf = view?.partialDataAsOf ?? null;
  // #348 — read from either level: the top-level verdict is the one the banner is entitled to trust,
  // the nested copy is what the OH health card reads, and they are written from one derivation.
  const overdue = view?.overdue === true || ingestion?.overdue === true;
  const paused = view?.schedulerPaused === true || ingestion?.schedulerPaused === true;

  // A wedged pipeline is alert-grade in its own right: the individual runs may each be "only" PARTIAL,
  // but a streak of them is the state that silently froze the fleet's derivation. So is silence — the
  // one state where there is no run to look at at all.
  const critical = failed || stuck || wedged || overdue;

  const asOfLine = (tone: string) =>
    view?.dataAsOf ? (
      <span className={tone}>
        Showing data as of <time dateTime={view.dataAsOf}>{formatTimestamp(view.dataAsOf)}</time> — may be stale.
      </span>
    ) : (
      <span className={tone}>No successful snapshot yet.</span>
    );

  return (
    <>
      <BuildHealthNotice />
      {!view && unavailable && (
        // Only when we have NEVER had a payload. A failing poll after a good read keeps showing the
        // last known verdict, which is more useful than blanking it — the freshness line is allowed to
        // be a moment behind, but it is not allowed to be absent.
        //
        // Quiet on purpose: an unreadable endpoint is not evidence that ingestion is broken, so this
        // states the gap without claiming a verdict it does not have.
        <div
          role="status"
          aria-label="Snapshot status"
          data-testid="snapshot-banner-unavailable"
          className="flex items-center gap-2 border-b border-line bg-surface-raised px-6 py-2 text-sm text-ink-muted"
        >
          <span className="font-medium text-slate-700">Snapshot:</span>
          <span>freshness unavailable — could not read ingestion status.</span>
        </div>
      )}
      {view &&
        (critical || gated ? (
          <div
            role="alert"
            aria-label="Snapshot status"
            data-testid="snapshot-banner-gated"
            className={
              critical
                ? 'flex flex-wrap items-center gap-2 border-b border-red-200 bg-red-50 px-6 py-2 text-sm text-red-800'
                : 'flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900'
            }
          >
            <span className="font-semibold">Snapshot alert:</span>
            {failed ? (
              <span>last run failed.</span>
            ) : stuck ? (
              <span>last run is stuck / overdue.</span>
            ) : overdue ? (
              <span>{silenceSummary(ingestion)}</span>
            ) : (
              <span>{gatedSummary(ingestion as IngestionAlertHealth)}</span>
            )}
            {asOfLine(critical ? 'text-red-700' : 'text-amber-800')}
            {partialAsOf && (
              // F10 — the PARTIAL watermark is real and is reported, but never as "data as of".
              <span data-testid="snapshot-partial-asof" className={critical ? 'text-red-700' : 'text-amber-800'}>
                Partial data through <time dateTime={partialAsOf}>{formatTimestamp(partialAsOf)}</time>.
              </span>
            )}
          </div>
        ) : paused ? (
          // #348 AC4 — a switch somebody threw on purpose. Not an alert (nothing is wrong), not the
          // grey line either (nothing is arriving): its own state, so "paused" can never be misread
          // as "current".
          <div
            role="status"
            aria-label="Snapshot status"
            data-testid="snapshot-banner-paused"
            className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900"
          >
            <span className="font-semibold">Ingestion paused:</span>
            <span>the telemetry scheduler is switched off, so this figure will not advance.</span>
            {view.dataAsOf ? (
              <span className="text-amber-800">
                Data as of <time dateTime={view.dataAsOf}>{formatTimestamp(view.dataAsOf)}</time>.
              </span>
            ) : (
              <span className="text-amber-800">No successful snapshot yet.</span>
            )}
          </div>
        ) : (
          <div
            role="status"
            aria-label="Snapshot status"
            className="flex items-center gap-2 border-b border-line bg-surface-raised px-6 py-2 text-sm text-ink-muted"
          >
            <span className="font-medium text-slate-700">Snapshot:</span>
            {view.dataAsOf ? (
              <span>
                data as of <time dateTime={view.dataAsOf}>{formatTimestamp(view.dataAsOf)}</time>
              </span>
            ) : (
              <span>no successful snapshot yet</span>
            )}
          </div>
        ))}
    </>
  );
}
