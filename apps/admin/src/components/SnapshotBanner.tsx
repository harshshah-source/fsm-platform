import { useEffect, useState } from 'react';
import { apiSnapshotLatest, type SnapshotLatestView } from '../api/snapshots';
import { useAuth } from '../auth/AuthProvider';

/**
 * The Snapshot freshness banner (Issue 04 AC#5/#6). Rides the top of every admin page: it shows
 * the data-as-of timestamp from the last successful Snapshot, and flips to a red alert when the
 * most recent run FAILED or is stuck RUNNING past the expected window.
 *
 * A snapshot targets <10 min (AC#7); a run still RUNNING past STUCK_AFTER_MS is treated as stuck.
 */
const STUCK_AFTER_MS = 15 * 60 * 1000;

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

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    apiSnapshotLatest()
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch(() => {
        /* banner stays silent on a transient fetch error rather than blocking the page */
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Hidden when logged out (e.g. the login page) or before the first read resolves.
  if (!session || !view) return null;

  const failed = view.latest?.status === 'FAILED';
  const stuck = isStuck(view);

  if (failed || stuck) {
    const reason = failed ? 'last run failed' : 'last run is stuck / overdue';
    return (
      <div
        role="alert"
        aria-label="Snapshot status"
        className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-6 py-2 text-sm text-red-800"
      >
        <span className="font-semibold">Snapshot alert:</span>
        <span>{reason}.</span>
        {view.dataAsOf && (
          <span className="text-red-700">
            Showing data as of <time dateTime={view.dataAsOf}>{formatTimestamp(view.dataAsOf)}</time>{' '}
            — may be stale.
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-label="Snapshot status"
      className="flex items-center gap-2 border-b bg-slate-50 px-6 py-2 text-sm text-slate-600"
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
  );
}
