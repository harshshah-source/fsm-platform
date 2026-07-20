import { useEffect, useState } from 'react';
import { apiIntegrationHealth, type IntegrationHealthView, type RecomputeLedgerEntry } from '../../api/integrationHealth';
import { DataTable, ErrorState, PageHeader, type Column } from '../../components/data';
import { Badge, SectionCard } from '../../components/ui';

/**
 * #131 — the routed drill-down for #130's L3 run attribution + L5 semantic canary. Superset of what
 * `BuildHealthNotice` (the global-banner summary alert) already flags: the current build high-water
 * mark, per-freshness `staleBuild` flags, and the last-N `device_state_recomputes` history with the
 * canary's swing rows highlighted — so an operator can spot the run-65-shaped anomaly (a large
 * eligible-count swing under a stale build) at a glance, not just be told "something's off".
 *
 * Display-only, per the #130 Slice 2 boundary: reads the same `/api/integration/health` the alert
 * already calls, no new backend computation.
 */
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
      <PageHeader
        title="Build Health"
        subtitle="Which build produced each run and recompute, and whether a build-stale run left an anomalous eligibility swing behind (#130)."
      />

      {error && <ErrorState message={error} onRetry={load} />}

      {health && (
        <>
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

function FreshnessBuildBadge({ build }: { build: IntegrationHealthView['masterSync']['build'] }) {
  if (!build) return <span className="text-ink-muted">—</span>;
  return build.staleBuild ? (
    <Badge tone="warning">stale (v{build.buildVersion})</Badge>
  ) : (
    <Badge tone="success">current</Badge>
  );
}
