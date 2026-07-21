import { useEffect, useState } from 'react';
import { apiOperatingMode, type ZoneOperatingMode } from '../../api/operatingMode';
import { useAuth } from '../../auth/AuthProvider';
import { operatingModeCopy, type OperatingModeTone } from '../../utils/operatingModeCopy';
import { Badge, SectionCard, type BadgeTone } from '../ui';

/**
 * Zone operating-mode card (Issue 136 slice 2) — the ZM's own-zone legibility surface. Shows, in plain
 * language, which mode the recommender is running for the manager's zone and why. Read-only: it changes
 * nothing and exposes no knob. ZM-only; OH/CSM see the cross-zone strip (slice 3) instead.
 *
 * All copy comes from `operatingModeCopy` — this component never renders the raw mode enum.
 *
 * NOTE (deferred wiring): mounting this on the ZM dashboard body touches `ZmDashboard`/`ManagerDashboard`,
 * which are mid-flight in a concurrent session; the ~1-line placement lands once those files are free.
 */
const TONE_TO_BADGE: Record<OperatingModeTone, BadgeTone> = {
  attention: 'warning',
  calm: 'success',
};

export function ZoneOperatingModeCard() {
  const { session } = useAuth();
  const isZm = session?.role === 'ZONAL_MANAGER';
  const [row, setRow] = useState<ZoneOperatingMode | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isZm) return;
    apiOperatingMode()
      .then((rows) => {
        setRow(rows[0] ?? null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true)); // stay quiet on a transient error rather than crashing the dashboard
  }, [isZm]);

  if (!isZm || !loaded) return null;

  if (!row) {
    return (
      <div data-testid="zone-operating-mode-card">
        <SectionCard title="Zone operating mode">
          <p className="text-sm text-ink-muted">We don&apos;t have enough data to show your zone&apos;s mode yet.</p>
        </SectionCard>
      </div>
    );
  }

  const copy = operatingModeCopy(row, 'self');
  return (
    <div data-testid="zone-operating-mode-card">
      <SectionCard
        title="Zone operating mode"
        action={<Badge tone={TONE_TO_BADGE[copy.tone]}>{copy.label}</Badge>}
      >
        <p className="text-sm text-ink-strong">{copy.reason}</p>
        <p className="mt-1 text-xs text-ink-muted">{copy.primaryFact}</p>
      </SectionCard>
    </div>
  );
}
