import { useEffect, useState } from 'react';
import { apiOperatingMode, type ZoneOperatingMode } from '../../api/operatingMode';
import { useAuth } from '../../auth/AuthProvider';
import { operatingModeCopy, type OperatingModeTone } from '../../utils/operatingModeCopy';
import { Badge, SectionCard, type BadgeTone } from '../ui';
import { IconHelp } from '../ui/icons';

/**
 * Zone operating-mode card (Issue 136 slice 2) — the ZM's own-zone legibility surface. Shows, in plain
 * language, which mode the recommender is running for the manager's zone and why. Read-only: it changes
 * nothing and exposes no knob. ZM-only; OH/CSM see the cross-zone strip (slice 3) instead.
 *
 * All copy comes from `operatingModeCopy` — this component never renders the raw mode enum.
 *
 * **Mounted on `ZmDashboard` by #351**, between the activity trend and the Action Required panel. It
 * was built in August 2026 and rendered nowhere for a month — the wiring was deferred because
 * `ZmDashboard` was mid-flight in a concurrent session, and the note outlived the conflict. A
 * legibility surface nobody can reach explains nothing, so the mount is now part of the component's
 * contract: do not remove it without re-opening #136 slice 2.
 */
const TONE_TO_BADGE: Record<OperatingModeTone, BadgeTone> = {
  attention: 'warning',
  calm: 'success',
};

/** Small accessible "how is this decided?" affordance — reveals `text` on hover/focus. */
function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label="How is this decided?"
        className="inline-flex items-center text-ink-muted hover:text-ink-strong focus-visible:text-ink-strong"
      >
        <IconHelp aria-hidden className="h-3.5 w-3.5" />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-10 mt-1 w-64 -translate-x-1/2 rounded-md border border-line bg-surface-raised px-3 py-2 text-xs font-normal normal-case tracking-normal text-ink-strong opacity-0 shadow-card transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

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
        title={
          <span className="flex items-center gap-1.5 text-[0.82rem] font-semibold text-ink-strong">
            Zone operating mode
            <InfoTooltip text={copy.help} />
          </span>
        }
        action={<Badge tone={TONE_TO_BADGE[copy.tone]}>{copy.label}</Badge>}
      >
        <p className="text-sm text-ink-strong">{copy.reason}</p>
        <p className="mt-1 text-xs text-ink-muted">{copy.primaryFact}</p>
      </SectionCard>
    </div>
  );
}
