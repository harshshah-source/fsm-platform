/**
 * How a ticket got onto a day plan, and who put it there (#283).
 *
 * **The problem this replaces.** `batch_assignment_tickets` has recorded the *end* of an assignment
 * since #241 — `removed_at` / `removed_by` / `removal_reason` — and recorded nothing at all about its
 * *start*. All four writers set exactly three fields (`batch_id`, `ticket_id`, `sort_order`), so the
 * row could not say who added it, why, or through which door. Provenance was recoverable only by
 * joining `audit_logs` — and on the intraday CRITICAL path not even then, because the engine and a
 * ZM both audit as `CRITICAL_ASSIGN` with only `actor_id = 'SYSTEM'` telling them apart.
 *
 * That gap is what made the approved provenance grammar unrenderable: #282 R2 requires that "a human
 * decision never looks like a system one", and the UI may only draw provenance the data supports.
 *
 * **Why a closed vocabulary and not free text.** Same argument as #241's: the value is read as a
 * *predicate* (the deck decides chip treatment from it; #284's changes-today groups by it), not shown
 * as a label, so a typo silently reclassifies an operation instead of producing a visible mistake.
 * TEXT in the database rather than a Postgres enum, deliberately — later slices add members without a
 * schema migration, and the discipline lives here, in one importable set every writer uses.
 *
 * **Storage note.** All four columns are nullable, and NULL means exactly one thing: the row predates
 * provenance. History is **not** backfilled — a pre-#283 row genuinely does not record who added it,
 * and guessing would be a fabrication. Readers must render NULL as unknown, never as a system
 * decision, which is the one direction that would break the grammar's promise.
 */
export const ADD_SOURCES = {
  /** The morning batch engine placed it (`BatchAssignmentService.dispatchForSe`). Actor is NULL — no
   *  human added it; `plant_batch_assignments.run_id` is the run's own handle. */
  AUTO_DISPATCH: 'AUTO_DISPATCH',
  /**
   * The intraday CRITICAL sweep placed it directly (#268 / #258 Q3 — CRITICAL is assigned, never
   * offered). Written when `IntradayInsertionService` reaches `assignTicket` as `SYSTEM_ACTOR`.
   * This is the member the data most needed: before it, a system CRITICAL insert and a ZM's one-click
   * assign produced byte-identical rows.
   */
  SYSTEM_CRITICAL: 'SYSTEM_CRITICAL',
  /** A manager assigned one ticket to one SE (`POST /schedules/assign`). */
  MANUAL_ASSIGN: 'MANUAL_ASSIGN',
  /** A lane commit from the Assign Work Console (`POST /schedules/assign-batch`, #275). */
  MANUAL_BATCH_ASSIGN: 'MANUAL_BATCH_ASSIGN',
  /** The plant-shaped shorthand over the same lane commit (`POST /schedules/assign-plants`). */
  MANUAL_PLANT_ASSIGN: 'MANUAL_PLANT_ASSIGN',
  /** Destination row of a human REASSIGN — its source row is stamped `REASSIGNED` on removal. */
  MANUAL_REASSIGN: 'MANUAL_REASSIGN',
  /** Destination row of a human SPLIT_BATCH. */
  MANUAL_SPLIT: 'MANUAL_SPLIT',
  /** A same-day ADD onto an already-dispatched plan (`POST /intraday-updates/add`). */
  SAME_DAY_ADD: 'SAME_DAY_ADD',
  /** Placed by an approved cross-zone escalation (`CrossZoneEscalationService.approve`). */
  CROSS_ZONE_ASSIGN: 'CROSS_ZONE_ASSIGN',
} as const;

/** The add-source vocabulary as a type — every writer's `addSource` is one of these. */
export type AddSource = (typeof ADD_SOURCES)[keyof typeof ADD_SOURCES];

/** Every member, for the tests and queries that need to assert over the closed set. */
export const ALL_ADD_SOURCES = Object.values(ADD_SOURCES) as readonly AddSource[];

/** The sources written by the engine rather than by a person. The deck draws these solid. */
export const SYSTEM_ADD_SOURCES: readonly AddSource[] = [
  ADD_SOURCES.AUTO_DISPATCH,
  ADD_SOURCES.SYSTEM_CRITICAL,
];

/**
 * True when the engine put this ticket here. NULL (pre-#283 history) is **not** system — it is
 * unknown, and the grammar's one hard rule is that unknown may never be drawn as a system decision.
 */
export function isSystemAddSource(source: string | null | undefined): boolean {
  return source != null && (SYSTEM_ADD_SOURCES as readonly string[]).includes(source);
}

/**
 * The chosen SE's coverage of the ticket's plant, as it stood when the assignment was written.
 *
 * The engine already persists this per decision (`chosen.coverageType` + `tierEvaluated` on the
 * decision trace); manual paths persisted nothing, so a manager handing a DEDICATED plant's work to a
 * FLOATING engineer was indistinguishable in the data from any other assignment. That distinction is
 * the dashed-violet "a human crossed a tier" signal in the approved grammar.
 *
 * Recorded at write time rather than derived later on purpose: `se_coverage` is mutable and hard-
 * deleted on removal (#138), so a lookup a week from now answers a different question than "what was
 * true when this was assigned".
 */
export const COVERAGE_AT_ASSIGN = {
  DEDICATED: 'DEDICATED',
  MULTI_PLANT: 'MULTI_PLANT',
  FLOATING: 'FLOATING',
  /**
   * The SE covered this plant in no tier at all.
   *
   * Not a defect and not an error state: #258 Q1 orders the *engine's* candidates, it does not gate a
   * manager, and #272 R6 makes tier crossing explicitly permitted and marked. A manual assign may
   * therefore land outside all three tiers — recording that as `FLOATING` would be a fabrication, so
   * the absence gets its own member.
   */
  NONE: 'NONE',
} as const;

/** The coverage vocabulary as a type. */
export type CoverageAtAssign = (typeof COVERAGE_AT_ASSIGN)[keyof typeof COVERAGE_AT_ASSIGN];

/** Every member, for tests asserting over the closed set. */
export const ALL_COVERAGE_AT_ASSIGN = Object.values(COVERAGE_AT_ASSIGN) as readonly CoverageAtAssign[];

/**
 * What a writer stamps on the add side. Mirrors the shape the removal side already passes around.
 *
 * `addedBy` is null for engine writes by construction — the same posture `close-assignment.ts` takes
 * for `removed_by` on terminal closure: somebody closed the *ticket*, nobody withdrew the
 * *assignment*. Here: the run placed the work, no person added it.
 */
export interface AddProvenance {
  addSource: AddSource;
  addedBy: string | null;
  addReason: string | null;
  coverageTypeAtAssign: CoverageAtAssign | null;
}

/**
 * Which door an `assignTicket` call came through.
 *
 * `assignTicket` is the shared write for five callers, and its existing `auditAction` parameter is
 * *almost* the discriminator — except that the system CRITICAL sweep and a ZM's one-click assign
 * both pass `CRITICAL_ASSIGN`. That collision is precisely the provenance gap #283 exists to close,
 * so the actor decides first and the audit action only distinguishes among the human doors.
 */
export function addProvenanceSourceFor(auditAction: string, systemActor: boolean): AddSource {
  if (systemActor) return ADD_SOURCES.SYSTEM_CRITICAL;
  switch (auditAction) {
    case 'MANUAL_ZM_UPDATE':
      return ADD_SOURCES.SAME_DAY_ADD;
    case 'CROSS_ZONE_ASSIGN':
      return ADD_SOURCES.CROSS_ZONE_ASSIGN;
    case 'MANUAL_BATCH_ASSIGN':
      return ADD_SOURCES.MANUAL_BATCH_ASSIGN;
    case 'MANUAL_PLANT_ASSIGN':
      return ADD_SOURCES.MANUAL_PLANT_ASSIGN;
    default:
      return ADD_SOURCES.MANUAL_ASSIGN;
  }
}
