import { useEffect, useState } from 'react';
import { listZones, type ZoneView } from '../../../api/org';
import { Select } from '../../../components/ui';

const LAST_ZONE_KEY = 'fsm.console.lastZone';

/** The zone a CSM/OH last looked at, so the Console opens where they left it rather than empty. */
export function readLastZone(): string | null {
  try {
    return localStorage.getItem(LAST_ZONE_KEY);
  } catch {
    return null; // private mode / storage disabled — an empty picker is a fine fallback.
  }
}

export function rememberZone(zoneId: string): void {
  try {
    localStorage.setItem(LAST_ZONE_KEY, zoneId);
  } catch {
    /* remembering is a convenience, never a requirement */
  }
}

/**
 * **The zone picker — the fix for the Console's largest hole** (slice C4).
 *
 * `GET /dispatch/today` is keyed on `(zone × today)` and **refuses to guess a zone** for a role that
 * could mean several: `parseZoneId` throws `ZONE_REQUIRED` for a multi-zone role with no `zoneId`. The
 * cockpit shipped reading `params.get('zoneId')` and nothing else, so a Central Service Manager or an
 * Operations Head opening `/dispatch/today` — two of the surface's three primary users — got a 400 and
 * an error card unless they hand-crafted the URL. This control is what makes the Console openable for
 * them at all.
 *
 * **Hidden for a Zonal Manager, not disabled** (UI§4.4). A ZM has exactly one zone; a picker with one
 * unchangeable option teaches nothing and implies a choice that does not exist. It is also the honest
 * rendering of the backend: `GET /org/zones` is `@Roles('CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD')`
 * and 403s for a ZM, so there is no list to offer even if we wanted one.
 *
 * **A failed zone list degrades to absent, not to a broken control.** The picker exists to widen what
 * a CSM can reach; if the list cannot be read, the caller's current zone still renders and the
 * operator can still work — they simply cannot switch. An empty dropdown would read as "this account
 * has no zones", which is a different and false statement.
 */
export function ZonePicker({
  value,
  onChange,
}: {
  /** The zone currently being viewed, or undefined before one has been chosen. */
  value: string | undefined;
  onChange: (zoneId: string) => void;
}) {
  const [zones, setZones] = useState<ZoneView[] | null>(null);

  useEffect(() => {
    let live = true;
    void listZones()
      .then((z) => live && setZones(z))
      .catch(() => live && setZones(null));
    return () => {
      live = false;
    };
  }, []);

  if (!zones || zones.length === 0) return null;

  return (
    <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
      <span className="hidden sm:inline">Zone</span>
      <Select
        aria-label="Zone"
        data-testid="console-zone-picker"
        className="h-8 w-40 text-xs"
        value={value ?? ''}
        onChange={(e) => {
          const next = e.target.value;
          if (!next) return;
          rememberZone(next);
          onChange(next);
        }}
      >
        <option value="">Choose a zone…</option>
        {zones.map((z) => (
          <option key={z.zoneId} value={String(z.zoneId)}>
            {z.name}
          </option>
        ))}
      </Select>
    </label>
  );
}

/**
 * What a CSM or OH sees before they have picked a zone.
 *
 * **It must not be filled with a fabricated fleet summary.** No aggregate read exists — the backend
 * refuses "all zones" deliberately, because "'all zones' is not a cockpit, it is a different product"
 * — so any number shown here would be invented. An explicit chooser is the honest opening state.
 */
export function ChooseZoneState({ hasZones }: { hasZones: boolean }) {
  return (
    <section
      data-testid="console-choose-zone"
      className="rounded-lg border border-line bg-surface p-6 text-center"
    >
      <h2 className="text-sm font-semibold text-ink">Choose a zone</h2>
      <p className="mx-auto mt-1 max-w-prose text-[12px] text-ink-muted">
        The Console shows one zone's operating day. There is no pan-India dispatch view — the scheduler
        plans, and this screen reports, one zone at a time.
      </p>
      {!hasZones && (
        <p className="mt-2 text-[11px] text-warning">
          The zone list could not be loaded, so no zone can be selected here. Open the Console from a
          zone link, or retry.
        </p>
      )}
    </section>
  );
}
