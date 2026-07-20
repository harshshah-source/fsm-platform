import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiIntegrationHealth, type IntegrationHealthView } from '../api/integrationHealth';
import { useAuth } from '../auth/AuthProvider';
import { onIngestionComplete } from '../pages/dashboard/ingestionEvents';

/**
 * #130 L3/L5 parity — an Operations-Head build-health alert. Rides the global banner and warns when
 * either (a) a recent pipeline run was produced by a build below the current runtime-lock high-water
 * mark (a stale process may be writing — the 2026-07-19 incident signature), or (b) the latest
 * device-state recompute's eligibility swung beyond the semantic-canary threshold. Warns only —
 * it never blocks; healthy state renders nothing so the banner stays quiet.
 *
 * Stays as the quick summary alert (per #131's own AC, kept rather than superseded) with a link into
 * the routed Build Health page (#131) for the full last-N recompute history + per-run detail.
 */
export function BuildHealthNotice() {
  const { session } = useAuth();
  const isOpsHead = session?.role === 'OPERATIONS_HEAD';
  const [health, setHealth] = useState<IntegrationHealthView | null>(null);

  useEffect(() => {
    if (!isOpsHead) return;
    const refresh = () => {
      apiIntegrationHealth()
        .then(setHealth)
        .catch(() => {
          /* stay silent on a transient fetch error rather than blocking the page */
        });
    };
    refresh();
    // A completed manual ingestion run changes the verdict now — re-read immediately.
    return onIngestionComplete(refresh);
  }, [isOpsHead]);

  if (!isOpsHead || !health) return null;

  // Defensive against a malformed/partial payload — this rides the global banner and must never crash it.
  const staleRun = Boolean(health.masterSync?.build?.staleBuild || health.snapshot?.build?.staleBuild);
  const swung = Array.isArray(health.recomputes) && health.recomputes.some((r) => r.swing);
  if (!staleRun && !swung) return null;

  return (
    <div
      role="alert"
      aria-label="Build health"
      className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900"
    >
      <span className="font-semibold">Build health:</span>
      {staleRun && (
        <span>
          a recent pipeline run ran under a build older than the current one
          {health.runtimeLock.version ? ` (v${health.runtimeLock.version})` : ''} — a stale process may be writing.
        </span>
      )}
      {swung && (
        <span>
          the latest device-state recompute&apos;s eligibility swung beyond the canary threshold — verify no stale
          build or config change before trusting it.
        </span>
      )}
      <Link to="/build-health" className="font-semibold underline hover:no-underline">
        View details →
      </Link>
    </div>
  );
}
