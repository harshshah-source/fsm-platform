// Typed client for the Today's Dispatch cockpit (#284, serving the #282-approved Crew Deck).
// Read scope is server-side: a ZM receives their own zone only; CSM/OH name a zone.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/**
 * A ticket as it sits on a stop.
 *
 * `addSource` is the provenance grammar's input (#283): `AUTO_DISPATCH` / `SYSTEM_CRITICAL` are the
 * engine, everything else is a person, and **null is unknown** — a row written before provenance
 * existed. `systemPlaced` is the server's own reading of it, so the client never has to re-derive the
 * one distinction #282 R2 forbids getting wrong.
 */
/**
 * #295 — the dispatcher's one-word verdict on a card, decided by the server.
 *
 * - `IN_PROGRESS` — an unresolved `TROUBLESHOOT_STARTED` exists: somebody is on it.
 * - `AGING_UNTOUCHED` — nobody has started, and the **assignment** has sat past the published threshold.
 * - `NOT_STARTED` — nobody has started, and it is still inside that threshold.
 *
 * The client never re-derives this. The rule involves a clock, a soft state and an operator-tunable
 * threshold, and a second implementation of it here is exactly how `chronicThreshold` came to be
 * permanently false in production.
 */
export type TicketActionStatus = 'IN_PROGRESS' | 'NOT_STARTED' | 'AGING_UNTOUCHED';

export interface TodayTicket {
  ticketId: string;
  sortOrder: number;
  slaBucket: string | null;
  companyTier: string | null;
  addSource: string | null;
  addedBy: string | null;
  addReason: string | null;
  coverageTypeAtAssign: string | null;
  systemPlaced: boolean;
  returnDueToday: boolean;
  /**
   * Failure cycles recorded against this ticket's device — the **chronic** predicate's input (3.4).
   *
   * A count rather than a flag, so the chip can say *how* chronic and the threshold stays server-side
   * in one place. Null = the ticket resolves to no device, which is not the same as a device that has
   * never failed.
   */
  failureCycles: number | null;

  // ── #295 — what the work card names ─────────────────────────────────────────────────────────────
  /** The unit in the field: the label an operator recognises. **Never a key** — `ticketId` is that. */
  deviceId: string | null;
  vehicleNo: string | null;
  companyName: string | null;
  transporterName: string | null;
  /**
   * How long the **device** has been silent, in hours. Displayed, and informational only.
   *
   * **Null means "never recomputed", not zero** — render an em-dash, never `0h`, or the card claims
   * the unit just reported in. And this is emphatically *not* what {@link actionStatus} measures:
   * that clock starts at {@link assignedAt}. A device quiet for 40 hours whose ticket was dispatched
   * ten minutes ago is untouched-but-fresh.
   */
  inactivityHours: number | null;
  /** When the work became this engineer's — the clock `actionStatus` is measured from. */
  assignedAt: string;
  /** An unresolved `TROUBLESHOOT_STARTED`. Not ON_SITE, and not "it has been assigned". */
  troubleshootingStarted: boolean;
  actionStatus: TicketActionStatus;
}

export interface TodayStop {
  batchId: string;
  stopSequence: number;
  plantId: string;
  plantName: string;
  status: string;
  runId: string | null;
  tickets: TodayTicket[];
}

export interface TodayEngineer {
  seId: string;
  name: string;
  coverageType: string;
  committed: number;
  dailyCapacity: number;
  overCapacity: boolean;
  availability: string;
  scheduleId: string | null;
  scheduleStatus: string | null;
  stops: TodayStop[];
}

export interface TodaySituation {
  placed: number;
  unassignable: number;
  held: number;
  criticalNeedsYou: number;
  overCapacity: number;
  changesToday: number;
  /**
   * B1 — two funnel populations the six counters silently omitted, so the strip implied an
   * exhaustiveness it did not have.
   *
   * **Null is "this run did not record it", never zero.** The columns are nullable for runs predating
   * #177, and rendering an unrecorded population as an empty one is the same class of lie the
   * provenance grammar exists to prevent.
   */
  componentBlockedWithheld: number | null;
  bucketlessDropped: number | null;
}

export interface TodayRun {
  runId: string;
  status: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface TodayUnassignable {
  ticketId: string;
  deviceId: string | null;
  plantId: string | null;
  plantName: string | null;
  poolEmptyReason: string | null;
  failureCycles: number | null;
}

export interface TodayHold {
  ticketId: string;
  deviceId: string | null;
  plantName: string | null;
  heldUntil: string;
  expectedFrom: string | null;
  /** Who approved the *vehicle-unavailability report* behind this hold — and nothing else. */
  decidedBy: string | null;
  /**
   * Who deferred it, when a manager did. A separate field from `decidedBy` on purpose: that one
   * answers the vehicle-report question, and a single field standing for two different decisions is
   * how a rail starts telling a plausible lie about which of them happened.
   */
  deferredBy: string | null;
  /** Their name; null when the id resolves to no user — render the id, never a guess (B7). */
  deferredByName: string | null;
  /** The reason they were made to type. Null where no manager deferred it, or none was recorded. */
  deferredReason: string | null;
  failureCycles: number | null;
}

/** #288 — the ledger's `insertion_type` for work an engineer became unavailable on. */
export const SE_UNAVAILABLE = 'SE_UNAVAILABLE';

export interface TodayEscalation {
  insertionId: string;
  ticketId: string;
  slaBucket: string | null;
  createdAt: string;
  /**
   * #288 — why this row exists: `SYSTEM_CRITICAL` (no capacity-eligible engineer, #268) or
   * `SE_UNAVAILABLE`. The strip explains itself in words, so it has to know which it is looking at.
   */
  insertionType: string;
  /**
   * The engineer the ticket is live on, or null. Non-null means manual Assign cannot resolve it —
   * `assignTicket` refuses an assigned ticket — and a reassign on that engineer's day plan can.
   */
  assignedSeId: string | null;
  assignedSeName: string | null;
}

/**
 * #286 — this zone's same-day recovery state, or `null` when nothing crashed today.
 *
 * `EXHAUSTED` and `EXPIRED` are the two the operator has to act on: the first means the system tried
 * and gave up, the second that the field day ran out first. Both are days of work that will not happen
 * unless somebody does something, which is why they are on the page rather than only in a log.
 */
export interface TodayRecovery {
  state: string;
  attempts: number;
  markedAt: string;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface DispatchTodayView {
  operatingDay: string;
  /** The chronic threshold in force. Published so no client hard-codes it (#244's precedent). */
  chronicThreshold: number;
  /**
   * #295 — hours an assignment may sit untouched before it reads as aged.
   *
   * Sent so the card can *say* the rule ("aged — untouched 4h+") without owning it. The verdict
   * itself arrives as {@link TodayTicket.actionStatus}; this is for the sentence, not the decision.
   */
  agingThresholdHours: number;
  zone: { zoneId: string; name: string };
  run: TodayRun | null;
  /** #286 — null on an ordinary day; set when this zone was owed a re-dispatch. */
  recovery: TodayRecovery | null;
  engineers: TodayEngineer[];
  situation: TodaySituation;
  rails: {
    unassignable: TodayUnassignable[];
    held: TodayHold[];
    /** `itemised: false` is the contract, not a placeholder: the engine counts this work and never
     *  lists it, so the rail renders a count and says so rather than implying a truncated list. */
    policyWithheld: { count: number; itemised: false };
  };
  escalations: TodayEscalation[];
}

export type ChangeKind = 'ADD' | 'REMOVE' | 'SWAP';

export interface DispatchChange {
  kind: ChangeKind;
  ticketId: string;
  actorId: string;
  /** B7 — the name behind `actorId`. Null when it resolves to no user; render the id, never a guess. */
  actorName: string | null;
  at: string;
  reason: string | null;
  toSeId: string | null;
  fromSeId: string | null;
  via: string | null;
}

export interface DispatchChangesTodayView {
  operatingDay: string;
  zoneId: string;
  counts: { adds: number; removes: number; swaps: number; total: number };
  changes: DispatchChange[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new Error(body.code ?? body.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export function apiDispatchToday(zoneId?: string): Promise<DispatchTodayView> {
  return get<DispatchTodayView>(`/dispatch/today${zoneId ? `?zoneId=${encodeURIComponent(zoneId)}` : ''}`);
}

export function apiDispatchChangesToday(zoneId?: string): Promise<DispatchChangesTodayView> {
  return get<DispatchChangesTodayView>(
    `/dispatch/changes-today${zoneId ? `?zoneId=${encodeURIComponent(zoneId)}` : ''}`,
  );
}

/**
 * #295 — one visible card's identity on a column that is **not** today.
 *
 * The fields a day-scoped source can honestly answer, and not one more. In particular there is no
 * `actionStatus`: nobody has started work whose day has not begun, and an aging verdict about
 * Wednesday is a category error rather than a fact.
 */
export interface CardSummary {
  ticketId: string;
  deviceId: string | null;
  vehicleNo: string | null;
  companyName: string | null;
  transporterName: string | null;
  inactivityHours: number | null;
}

/**
 * Identity for every card a non-today column is about to draw — **one request for the column**, not
 * one per card.
 *
 * `GET /schedules?date=&detail=stops` gives that column its ticket ids and nothing physical, so
 * without this the choice would be an eight-character hash or an N+1. A `POST` because the input is a
 * list of ids that does not belong in a URL; the endpoint writes nothing (the same shape as
 * `distribute-preview` and `override/preview`).
 */
export async function apiDispatchCardSummaries(
  ticketIds: string[],
  zoneId?: string,
): Promise<CardSummary[]> {
  if (ticketIds.length === 0) return [];
  const res = await fetch(
    `${BASE_URL}/dispatch/card-summaries${zoneId ? `?zoneId=${encodeURIComponent(zoneId)}` : ''}`,
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketIds }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new Error(body.code ?? body.message ?? `Request failed (${res.status})`);
  }
  return ((await res.json()) as { summaries: CardSummary[] }).summaries;
}
