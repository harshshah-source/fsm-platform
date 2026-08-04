import type { VehicleUnavailReason } from '@fsm/shared';

/** e.g. `VEHICLE_ON_TRIP` -> "Vehicle On Trip". */
export function formatReasonLabel(reason: VehicleUnavailReason): string {
  return reason
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

export interface ExpectedFromOption {
  key: string;
  label: string;
  compute: (now: Date) => Date;
}

/** Quick "expected back" presets — an SE knows roughly when, not to the minute; avoids a native
 *  date/time picker for a required field with no reference mockup specifying its input UX. */
export const EXPECTED_FROM_OPTIONS: readonly ExpectedFromOption[] = [
  { key: '2h', label: 'In 2 hours', compute: (now) => new Date(now.getTime() + 2 * 60 * 60_000) },
  { key: '4h', label: 'In 4 hours', compute: (now) => new Date(now.getTime() + 4 * 60 * 60_000) },
  { key: 'tomorrow-am', label: 'Tomorrow, 9 AM', compute: (now) => atNextDayTime(now, 1, 9) },
  { key: 'tomorrow-pm', label: 'Tomorrow, 2 PM', compute: (now) => atNextDayTime(now, 1, 14) },
];

function atNextDayTime(now: Date, daysAhead: number, hour: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d;
}
