import { useEffect, useState } from 'react';
import { apiOperatingMode, type ZoneOperatingMode } from '../../api/operatingMode';
import { useAuth } from '../../auth/AuthProvider';
import { operatingModeCopy, type OperatingModeTone } from '../../utils/operatingModeCopy';
import { Badge, SectionCard, type BadgeTone } from '../ui';

/**
 * Cross-zone operating-mode strip (Issue 136 slice 3) — the OH/CSM legibility surface: every zone's
 * current recommender mode at a glance, so an operator sees which zones are in "Catch-up" without
 * opening each. Read-only; ZMs see their own-zone card instead.
 *
 * All copy comes from `operatingModeCopy` (third-person "other" voice) — the raw enum is never rendered.
 * Rows are intentionally non-interactive: there is no existing per-zone OH route to deep-link into, and
 * the issue says reuse existing navigation rather than invent a drill-down.
 *
 * NOTE (deferred wiring): mounting on the OH/CSM dashboard body touches `OpsHeadDashboard`/`ManagerDashboard`,
 * mid-flight in a concurrent session; the ~1-line placement lands once those files are free.
 */
const TONE_TO_BADGE: Record<OperatingModeTone, BadgeTone> = {
  attention: 'warning',
  calm: 'success',
};

export function ZoneOperatingModeStrip() {
  const { session } = useAuth();
  const canSee = session?.role === 'OPERATIONS_HEAD' || session?.role === 'CENTRAL_SERVICE_MANAGER';
  const [rows, setRows] = useState<ZoneOperatingMode[] | null>(null);

  useEffect(() => {
    if (!canSee) return;
    apiOperatingMode()
      .then(setRows)
      .catch(() => setRows([])); // stay quiet on a transient error rather than crashing the dashboard
  }, [canSee]);

  if (!canSee || rows === null) return null;

  return (
    <div data-testid="zone-operating-mode-strip">
      <SectionCard title="Zones — operating mode">
        {rows.length === 0 ? (
          <p className="text-sm text-ink-muted">No zones to show yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((row) => {
              const copy = operatingModeCopy(row, 'other');
              return (
                <li
                  key={row.zoneId}
                  data-testid={`zone-mode-row-${row.zoneId}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                >
                  <span className="text-sm font-medium text-ink-strong">{row.zoneName}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-ink-muted">{copy.primaryFact}</span>
                    <Badge tone={TONE_TO_BADGE[copy.tone]}>{copy.label}</Badge>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
