/**
 * #161 D-4 — the human-readable ticket display label derived from `Ticket.ticketNo`
 * (`ticket_no BIGINT @default(autoincrement()) @unique`, migration `20260803120000_ticket_no`).
 * `ticket_id` (UUID) stays canonical identity and the API route param; `ticket_no` / `TCK-#####` is
 * a label only — never a lookup key, never a foreign key.
 *
 * The client formats `TCK-` + zero-padded-to-5 (per the issue's cited reference images:
 * `TCK-10252`, `TCK-10306`, ...); the server returns the raw integer AND this pre-formatted string
 * (the issue's own recommendation) so the padding rule never forks between callers. Real backfilled
 * volumes (~21k+ tickets) run past five digits — the pad is a floor, not a fixed width, so a
 * 6-digit number still renders `TCK-123456` rather than being truncated.
 */
export function formatTicketNo(ticketNo: bigint | number): string {
  return `TCK-${String(ticketNo).padStart(5, '0')}`;
}

/**
 * `ticket_no` as a JSON-safe number. Unlike the UUID-adjacent bigint ids elsewhere in these read
 * models (deviceId/vehicleId/plantId, stringified for precision safety), `ticket_no` is a plain
 * monotonic counter over the platform's ticket volume (tens of thousands) — well inside JS's
 * MAX_SAFE_INTEGER — so it is returned as a genuine JSON number, matching the issue's "server
 * returns the raw integer" wording literally.
 */
export function ticketNoAsNumber(ticketNo: bigint): number {
  return Number(ticketNo);
}
