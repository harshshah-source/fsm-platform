import type { IntradayDeclineReasonCode } from '@fsm/shared';

/** e.g. `AT_CAPACITY` -> "At Capacity". */
export function formatDeclineReasonLabel(reason: IntradayDeclineReasonCode): string {
  return reason
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

/** `acceptanceDeadline` is a server-computed absolute ISO instant (never client-derived — a
 *  client-side "10 minutes from receipt" drifts against the server's own timeout sweep). Rendered
 *  as a plain local time, not a live countdown — same proportionality call as #71's Install Form. */
export function formatAcceptByLabel(acceptanceDeadlineIso: string): string {
  const d = new Date(acceptanceDeadlineIso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `Accept by ${hh}:${mm}`;
}
