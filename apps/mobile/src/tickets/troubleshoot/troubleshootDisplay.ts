import type { RootCauseCategory } from '@fsm/shared';

const ACRONYMS = new Set(['GPS', 'SIM']);

/** e.g. `WIRING_ISSUE` -> "Wiring Issue", `GPS_ANTENNA_ISSUE` -> "GPS Antenna Issue". */
export function formatRootCauseLabel(category: RootCauseCategory): string {
  return category
    .split('_')
    .map((word) => (ACRONYMS.has(word) ? word : word.charAt(0) + word.slice(1).toLowerCase()))
    .join(' ');
}

/**
 * The mockup's own literal Action Taken tile labels (docs/ui/mobile/troubleshooting.png) — the
 * only vocabulary that exists anywhere for this field. `actionTakenCategory` is still an
 * unvalidated free string server-side (#172 Decision 8), so these are sent as plain strings.
 */
export const ACTION_TAKEN_OPTIONS = [
  'Power',
  'Battery',
  'SIM',
  'Wire',
  'Antenna',
  'Restart',
  'Device',
  'Config',
  'No Fault',
  'Escalate',
] as const;
