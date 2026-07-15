import { useMemo } from 'react';
import type { ConfigSnapshot } from '../../api/dispatch-runs';
import { SectionCard } from '../../components/ui';
import { componentLabel, humanizeCron } from './format';

/**
 * The configuration that actually applied to a run — frozen at run start, so a later config/capacity
 * edit never rewrites this history. Rendered in plain language (Issue 123): priority weighting, engineer
 * capacity, same-plant clustering, eligibility, and the automatic-dispatch schedule. When the run used
 * code defaults (no DB override captured), the relevant row says "Default (not overridden)" rather than
 * inventing numbers — the effective-config capture is the #124 follow-up.
 */
export function ConfigInEffectPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const capacity = useMemo(() => {
    const entries = Object.values(snapshot.capacity ?? {});
    const active = entries.filter((e) => e.isActive);
    const caps = active.map((e) => e.dailyCapacity).filter((c): c is number => typeof c === 'number');
    return {
      total: entries.length,
      active: active.length,
      min: caps.length ? Math.min(...caps) : null,
      max: caps.length ? Math.max(...caps) : null,
    };
  }, [snapshot.capacity]);

  const rules = snapshot.priorityRules ?? [];
  const maxWeight = rules.reduce((m, r) => Math.max(m, Math.abs(r.weight)), 0) || 1;
  const clusterMult = snapshot.settings?.plant_cluster_multiplier;
  const eligibility = snapshot.settings?.eligibility_mode;
  const sweepsOn = snapshot.scheduler?.businessSweepsEnabled;

  return (
    <SectionCard title="Configuration in effect" className="mb-5">
      <p className="mb-4 text-xs text-ink-muted">
        Frozen when this run executed — later changes don't affect past runs.
      </p>

      <dl data-testid="config-in-effect" className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div>
          <dt className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-caps">Priority weighting</dt>
          <dd>
            {rules.length === 0 ? (
              <p className="text-sm text-ink-muted">Default weighting (not overridden)</p>
            ) : (
              <ul className="space-y-1.5">
                {rules.map((r, i) => (
                  <li key={`${r.weightSetRef}-${r.component}-${i}`} className="flex items-center gap-3">
                    <span className="w-40 shrink-0 text-sm text-ink">{componentLabel(r.component)}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                      <span
                        className="block h-full rounded-full bg-brand-600"
                        style={{ width: `${Math.round((Math.abs(r.weight) / maxWeight) * 100)}%` }}
                      />
                    </span>
                    <span className="w-10 shrink-0 text-right text-xs tabular-nums text-ink-muted">{r.weight}</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>

        <div className="space-y-4">
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">Engineer capacity</dt>
            <dd className="mt-1 text-sm text-ink">
              {capacity.total === 0 ? (
                <span className="text-ink-muted">No engineers captured</span>
              ) : (
                <>
                  {capacity.active} active of {capacity.total} engineers
                  {capacity.min != null && (
                    <span className="text-ink-muted">
                      {' '}
                      · daily capacity {capacity.min === capacity.max ? capacity.min : `${capacity.min}–${capacity.max}`} jobs
                    </span>
                  )}
                </>
              )}
            </dd>
          </div>

          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">Same-plant clustering</dt>
            <dd className="mt-1 text-sm text-ink">
              {clusterMult ? (
                <>Extra weight ×{clusterMult} for stacking jobs at a plant already being visited</>
              ) : (
                <span className="text-ink-muted">Default ×1.25 (not overridden)</span>
              )}
            </dd>
          </div>

          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">Engineer eligibility</dt>
            <dd className="mt-1 text-sm text-ink">
              {eligibility ?? <span className="text-ink-muted">Default (not overridden)</span>}
            </dd>
          </div>

          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">Automatic dispatch</dt>
            <dd className="mt-1 text-sm text-ink">
              {sweepsOn ? 'On' : 'Off'}
              {snapshot.scheduler?.dispatchCron && (
                <span className="text-ink-muted"> · {humanizeCron(snapshot.scheduler.dispatchCron)}</span>
              )}
            </dd>
          </div>
        </div>
      </dl>
    </SectionCard>
  );
}
