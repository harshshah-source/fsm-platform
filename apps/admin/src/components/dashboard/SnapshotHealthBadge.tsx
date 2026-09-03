import { useCallback, useEffect, useState } from 'react';
import { apiSnapshotLatest, type SnapshotLatestView } from '../../api/snapshots';
import { useAuth } from '../../auth/AuthProvider';
import { onIngestionComplete } from '../../pages/dashboard/ingestionEvents';
import { Badge, type BadgeTone } from '../ui';

/**
 * **The dashboard's snapshot verdict — read, not asserted (#351 AC1).**
 *
 * Until this component, three dashboards rendered `<Badge tone="success" dot>Snapshot Healthy</Badge>`
 * as a **literal string** (`ZmDashboard`, `CentralDashboard`, `WarehouseDashboard`). It was green while
 * ingestion was dead, green while the scheduler was switched off, and green while #300's downstream
 * gate held every derivation back — because nothing about it was connected to anything. A pill that
 * says "healthy" because a string says so is worse than no pill, since it actively answers the
 * question an operator came to the page with.
 *
 * The signals it now reads were all computed by #348 and shaped for this read by #349: `overdue`,
 * `schedulerPaused` and `ingestion.silenceMinutes` are on `GET /snapshots/latest`, which #348
 * deliberately left un-`@Roles`'d so every authenticated role — the Warehouse Manager included — can
 * see whether the numbers above it are current.
 *
 * **One vocabulary, not two.** The Integration Health page (#349) already names this exact fact:
 * `Stale` (red) versus `Fresh` (green) against a threshold of twice the configured cadence. The
 * top-of-page banner (#348) names the same verdict `overdue`. This badge uses the page's word —
 * **Stale** — for the bad state and keeps the v2 reference's word — **Healthy** — for the good one,
 * so an operator moving between the dashboard and the health page reads one idea, not two.
 *
 * **Precedence mirrors `SnapshotBanner` deliberately**: failed → stuck → overdue → gated → paused →
 * healthy. Two surfaces on the same screen ranking the same states differently is how a page ends up
 * saying "alert" at the top and "gated" in the middle about one event.
 *
 * The age rides beside the badge rather than inside it, in the slot reference 01/03 give the
 * "Data as of …" chip. "Stale" with no figure is not actionable, and the figure is what separates one
 * missed tick from a dead scheduler.
 */
const STUCK_AFTER_MS = 15 * 60 * 1000;
const POLL_MS = 60 * 1000;

type Verdict = {
  label: string;
  tone: BadgeTone;
  /** Only the good state gets the filled dot — the reference's green "● Snapshot Healthy" pill. */
  dot: boolean;
};

const HEALTHY: Verdict = { label: 'Snapshot Healthy', tone: 'success', dot: true };
const UNAVAILABLE: Verdict = { label: 'Snapshot Unavailable', tone: 'neutral', dot: false };

/** Whole minutes as something an operator reads at a glance — matches `SnapshotBanner` / #349. */
function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function isStuck(view: SnapshotLatestView): boolean {
  const latest = view.latest;
  if (!latest || latest.status !== 'RUNNING') return false;
  return Date.now() - new Date(latest.startedAt).getTime() > STUCK_AFTER_MS;
}

/**
 * The verdict, in the banner's own precedence order.
 *
 * Every read is defensive against a partial payload: this badge sits in the header of the manager's
 * front door, and an older backend must cost it its verdict, never the page.
 */
export function snapshotVerdict(view: SnapshotLatestView | null): Verdict {
  if (!view) return UNAVAILABLE;
  const ingestion = view.ingestion;
  if (view.latest?.status === 'FAILED') return { label: 'Snapshot Failed', tone: 'critical', dot: false };
  if (isStuck(view)) return { label: 'Snapshot Stuck', tone: 'critical', dot: false };
  if (view.overdue === true || ingestion?.overdue === true) {
    return { label: 'Snapshot Stale', tone: 'critical', dot: false };
  }
  if (ingestion?.alert === true || ingestion?.downstreamGated === true) {
    return { label: 'Snapshot Gated', tone: 'warning', dot: false };
  }
  if (view.schedulerPaused === true || ingestion?.schedulerPaused === true) {
    return { label: 'Ingestion Paused', tone: 'warning', dot: false };
  }
  return HEALTHY;
}

export function SnapshotHealthBadge() {
  const { session } = useAuth();
  const [view, setView] = useState<SnapshotLatestView | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    apiSnapshotLatest()
      .then((next) => {
        setView(next);
        setLoaded(true);
      })
      .catch(() => {
        // Stated, not swallowed (#348). A read that fails after a good one keeps the last verdict —
        // the badge is allowed to be a minute behind, it is not allowed to invent a green pill.
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    if (!session) return;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    // A manual "Run Ingestion Now" changes the answer immediately — same subscription the banner uses.
    const off = onIngestionComplete(refresh);
    return () => {
      clearInterval(id);
      off();
    };
  }, [session, refresh]);

  // Nothing at all until the first read resolves: a placeholder verdict is the defect this closes.
  if (!session || !loaded) return null;

  const verdict = snapshotVerdict(view);
  const silence = view?.ingestion?.silenceMinutes;
  const dataAsOf = view?.dataAsOf ?? null;

  return (
    <span className="inline-flex items-center gap-2">
      <span data-testid="snapshot-health-badge" className="inline-flex">
        <Badge tone={verdict.tone} dot={verdict.dot}>
          {verdict.label}
        </Badge>
      </span>
      <span data-testid="snapshot-health-age" className="text-xs text-ink-muted">
        {dataAsOf ? (
          <>
            Data as of <time dateTime={dataAsOf}>{new Date(dataAsOf).toLocaleString()}</time>
            {typeof silence === 'number' && <span className="tabular-nums"> · {formatAge(silence)} old</span>}
          </>
        ) : (
          'No successful snapshot yet'
        )}
      </span>
    </span>
  );
}
