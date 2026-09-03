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
 */
const STUCK_AFTER_MS = 15 * 60 * 1000;
const POLL_MS = 60 * 1000;

function isStuck(view: SnapshotLatestView): boolean {
  const latest = view.latest;
  if (!latest || latest.status !== 'RUNNING') return false;
  return Date.now() - new Date(latest.startedAt).getTime() > STUCK_AFTER_MS;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Plain-language "why it stopped advancing" — the sentence the freshness line was missing. */
function gatedSummary(ingestion: IngestionAlertHealth): string {
  const runs =
    ingestion.streak > 1 ? `The last ${ingestion.streak} telemetry runs` : 'The last telemetry run';
  const stages =
    ingestion.gatedStages.length > 0 ? ingestion.gatedStages.join(', ') : 'downstream processing';
  return `${runs} did not complete, so ${stages} are paused.`;
}

export function SnapshotBanner() {
  const { session } = useAuth();
  const [view, setView] = useState<SnapshotLatestView | null>(null);

  const refresh = useCallback(() => {
    apiSnapshotLatest()
      .then(setView)
      .catch(() => {
        /* banner stays silent on a transient fetch error rather than blocking the page */
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

  // A wedged pipeline is alert-grade in its own right: the individual runs may each be "only" PARTIAL,
  // but a streak of them is the state that silently froze the fleet's derivation.
  const critical = failed || stuck || wedged;

  return (
    <>
      <BuildHealthNotice />
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
            ) : (
              <span>{gatedSummary(ingestion as IngestionAlertHealth)}</span>
            )}
            {view.dataAsOf ? (
              <span className={critical ? 'text-red-700' : 'text-amber-800'}>
                Showing data as of <time dateTime={view.dataAsOf}>{formatTimestamp(view.dataAsOf)}</time> — may be
                stale.
              </span>
            ) : (
              <span className={critical ? 'text-red-700' : 'text-amber-800'}>No successful snapshot yet.</span>
            )}
            {partialAsOf && (
              // F10 — the PARTIAL watermark is real and is reported, but never as "data as of".
              <span data-testid="snapshot-partial-asof" className={critical ? 'text-red-700' : 'text-amber-800'}>
                Partial data through <time dateTime={partialAsOf}>{formatTimestamp(partialAsOf)}</time>.
              </span>
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
