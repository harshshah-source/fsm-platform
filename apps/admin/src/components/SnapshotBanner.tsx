import { useCallback, useEffect, useState } from 'react';
import { apiSnapshotLatest, type SnapshotLatestView } from '../api/snapshots';
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

  return (
    <>
      <BuildHealthNotice />
      {view &&
        (failed || stuck ? (
          <div
            role="alert"
            aria-label="Snapshot status"
            className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-6 py-2 text-sm text-red-800"
          >
            <span className="font-semibold">Snapshot alert:</span>
            <span>{failed ? 'last run failed' : 'last run is stuck / overdue'}.</span>
            {view.dataAsOf && (
              <span className="text-red-700">
                Showing data as of <time dateTime={view.dataAsOf}>{formatTimestamp(view.dataAsOf)}</time> — may be
                stale.
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
