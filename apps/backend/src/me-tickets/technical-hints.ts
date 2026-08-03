import { Prisma } from '../generated/prisma/client';

/**
 * #84 — Technical Hints (derived telemetry signals). Pure derivation over the latest
 * `RawDeviceSnapshot` row for a device (PRD §641 Flow 14). Hints are purely advisory: they never
 * read or write ticket/SLA/assignment/scoring/verification/closure state — see
 * `me-ticket-detail.service.ts` / `me-tickets-query.service.ts` for the only two call sites, both of
 * which pass in an already-fetched snapshot row and do nothing with the result but serialize it.
 *
 * Frozen vocabulary (#169 owns freezing this contract further; do not rename without updating there):
 * eight `code`s, one per §641 condition, each mapped 1:1 to its verbatim PRD label.
 */
export type TechnicalHintCode =
  | 'NO_MAIN_POWER'
  | 'NOT_ON_NETWORK'
  | 'GPS_INVALID'
  | 'NO_GPS_FIX'
  | 'LOW_VOLTAGE'
  | 'WEAK_GSM'
  | 'IGNITION_OFF'
  | 'VEHICLE_IN_MOTION';

export interface TechnicalHint {
  code: TechnicalHintCode;
  /** Higher number = more severe. See the ranking rationale below — deliberately spans 1-8 with no
   *  ties, so "the single highest-severity hint" (AC #2) is always well-defined even when every
   *  condition fires on the same snapshot. */
  severity: number;
  label: string;
}

/**
 * Severity ranking rationale (documented per the issue's own request, since #169 needs it frozen
 * alongside the code vocabulary): conditions that mean the device may be producing NO further usable
 * telemetry at all (no power, not on the network, GPS unreliable/no-fix) block diagnosis entirely and
 * outrank conditions that are just informational context about a device that IS still reporting
 * (ignition, motion). Within the "blocks diagnosis" tier, total power loss outranks a comms/GPS
 * problem (a device with no power cannot be reasoned about at all, whereas a device still powered but
 * briefly off-network may recover on its own). Low voltage / weak GSM are degraded-but-still-working
 * warnings, ranked between the two tiers.
 */
const HINT_DEFINITIONS: Record<TechnicalHintCode, { severity: number; label: string }> = {
  NO_MAIN_POWER: { severity: 8, label: 'No main power — check fuse' },
  NOT_ON_NETWORK: { severity: 7, label: 'Not on network' },
  GPS_INVALID: { severity: 6, label: 'GPS signal invalid' },
  NO_GPS_FIX: { severity: 5, label: 'No GPS fix' },
  LOW_VOLTAGE: { severity: 4, label: 'Low voltage' },
  WEAK_GSM: { severity: 3, label: 'Weak GSM signal' },
  IGNITION_OFF: { severity: 2, label: 'Ignition off' },
  VEHICLE_IN_MOTION: { severity: 1, label: 'Vehicle in motion' },
};

function hint(code: TechnicalHintCode): TechnicalHint {
  return { code, ...HINT_DEFINITIONS[code] };
}

/** Case-insensitive, trimmed equality — every ambiguous free-`String?` condition below matches this
 *  way since nothing in the current ingestion path (`ingestion/autoplant/mapping.ts`) produces a
 *  confirmed real value to match against case-sensitively. */
function eqCI(value: string | null, target: string): boolean {
  return value !== null && value.trim().toLowerCase() === target;
}

/**
 * The already-primitive fields the §641 table conditions read. Deliberately decoupled from the
 * Prisma-generated `RawDeviceSnapshot` row type (no `Prisma.Decimal`, no `Date`) so this module has
 * no DB/ORM dependency and is trivially unit-testable — `buildTechnicalHealth` below does the
 * one-time conversion from the real row shape.
 */
export interface HintDerivationInput {
  mainsStatus: number | null;
  mainsVoltage: number | null;
  csq: number | null;
  gpsValidity: string | null;
  gpsMode: string | null;
  creg: string | null;
  cgreg: string | null;
  ignitionStatus: string | null;
  speed: number | null;
}

/**
 * Encodes the §641 table as data, one condition per row, and evaluates all eight independently — a
 * snapshot can fire zero, one, or all eight simultaneously (deliberately not `else if`; e.g. no main
 * power AND low voltage both apply to the same low-power event). Returned already sorted by
 * `severity` descending (`HINT_DEFINITIONS` above is itself declared in that order) so a caller that
 * wants "all hints" gets a stable, severity-ordered list for free, and `pickTopHint` is simply
 * `hints[0]`.
 *
 * Ambiguous-string conditions and the exact literal each matches (documented per the issue's own
 * request, since nothing currently produces these fields to test against real data):
 *  - `gpsMode` "no fix" — case-insensitive equality to the literal `"no fix"`.
 *  - `creg` / `cgreg` "not registered" — case-insensitive equality to the literal `"not registered"`
 *    (either field alone is sufficient; AutoPlant's numeric 3GPP CREG/CGREG codes, e.g. `0`/`3`, are
 *    NOT matched here — the source column is a free `String?` with no confirmed real value yet, and
 *    inventing a numeric-code mapping would be a new threshold the issue's own "no new thresholds"
 *    rule forbids).
 *  - `ignitionStatus` "off" — case-insensitive equality to the literal `"off"` (AutoPlant's
 *    `IGNITION_STATUS` column is documented as free text, likely `"ON"`/`"OFF"`).
 */
export function deriveTechnicalHints(s: HintDerivationInput): TechnicalHint[] {
  const hints: TechnicalHint[] = [];
  if (s.mainsStatus === 0) hints.push(hint('NO_MAIN_POWER'));
  if (eqCI(s.creg, 'not registered') || eqCI(s.cgreg, 'not registered')) hints.push(hint('NOT_ON_NETWORK'));
  if (eqCI(s.gpsValidity, 'invalid')) hints.push(hint('GPS_INVALID'));
  if (eqCI(s.gpsMode, 'no fix')) hints.push(hint('NO_GPS_FIX'));
  if (s.mainsVoltage !== null && s.mainsVoltage < 10) hints.push(hint('LOW_VOLTAGE'));
  if (s.csq !== null && s.csq <= 9) hints.push(hint('WEAK_GSM'));
  if (eqCI(s.ignitionStatus, 'off')) hints.push(hint('IGNITION_OFF'));
  if (s.speed !== null && s.speed > 5) hints.push(hint('VEHICLE_IN_MOTION'));
  return hints;
}

/** AC #2 — "card source = the single highest-severity hint". `hints` is already severity-descending
 *  (see `deriveTechnicalHints`), but this reduces explicitly rather than assuming callers never
 *  reorder the array first. */
export function pickTopHint(hints: TechnicalHint[]): TechnicalHint | null {
  if (hints.length === 0) return null;
  return hints.reduce((best, h) => (h.severity > best.severity ? h : best));
}

/** The raw telemetry field set the issue's API spec calls out — every `RawDeviceSnapshot` column
 *  except `id`/`runId`/`deviceId` (those three are row plumbing, not device telemetry; `deviceId` is
 *  already on the enclosing ticket/list payload). */
export interface RawTelemetry {
  gpsDatetime: string;
  lat: number | null;
  lon: number | null;
  mainsStatus: number | null;
  mainsVoltage: number | null;
  gpsValidity: string | null;
  gpsMode: string | null;
  ignitionStatus: string | null;
  speed: number | null;
  creg: string | null;
  cgreg: string | null;
  csq: number | null;
  ipAddress: string | null;
  portNo: number | null;
  simSubscriberName: string | null;
  unitNo: string | null;
  deviceType: string | null;
}

export interface TechnicalHealth {
  hints: TechnicalHint[];
  rawTelemetry: RawTelemetry | null;
  dataAsOf: string | null;
  available: boolean;
}

/** The subset of `RawDeviceSnapshot` this module reads — `id`/`runId`/`deviceId` intentionally
 *  excluded (see `RawTelemetry`). Kept structurally compatible with the generated Prisma row so a
 *  `findFirst` result can be passed straight through with no manual mapping at the call site. */
export interface TechnicalHealthSourceRow {
  gpsDatetime: Date;
  lat: number | null;
  lon: number | null;
  mainsStatus: number | null;
  mainsVoltage: Prisma.Decimal | number | null;
  gpsValidity: string | null;
  gpsMode: string | null;
  ignitionStatus: string | null;
  speed: Prisma.Decimal | number | null;
  creg: string | null;
  cgreg: string | null;
  csq: number | null;
  ipAddress: string | null;
  portNo: number | null;
  simSubscriberName: string | null;
  unitNo: string | null;
  deviceType: string | null;
}

function decimalToNumber(v: Prisma.Decimal | number | null): number | null {
  if (v === null) return null;
  return typeof v === 'number' ? v : v.toNumber();
}

/**
 * Builds the full `technicalHealth` API payload from the latest snapshot row (or `null` when the
 * device has never pinged / has no row at all — AC "missing snapshot → available=false"). This is the
 * single call site both `MeTicketDetailService` (full `hints`) and `MeTicketsQueryService` (top hint
 * only, via `pickTopHint`) should use, so the two surfaces can never derive hints differently.
 *
 * Read-only by construction: it only ever reads its `row` argument and returns a plain object — no
 * Prisma client, no writes, nothing ticket/SLA/assignment-shaped in scope at all.
 */
export function buildTechnicalHealth(row: TechnicalHealthSourceRow | null): TechnicalHealth {
  if (!row) return { hints: [], rawTelemetry: null, dataAsOf: null, available: false };

  const mainsVoltage = decimalToNumber(row.mainsVoltage);
  const speed = decimalToNumber(row.speed);

  const hints = deriveTechnicalHints({
    mainsStatus: row.mainsStatus,
    mainsVoltage,
    csq: row.csq,
    gpsValidity: row.gpsValidity,
    gpsMode: row.gpsMode,
    creg: row.creg,
    cgreg: row.cgreg,
    ignitionStatus: row.ignitionStatus,
    speed,
  });

  const dataAsOf = row.gpsDatetime.toISOString();

  return {
    hints,
    rawTelemetry: {
      gpsDatetime: dataAsOf,
      lat: row.lat,
      lon: row.lon,
      mainsStatus: row.mainsStatus,
      mainsVoltage,
      gpsValidity: row.gpsValidity,
      gpsMode: row.gpsMode,
      ignitionStatus: row.ignitionStatus,
      speed,
      creg: row.creg,
      cgreg: row.cgreg,
      csq: row.csq,
      ipAddress: row.ipAddress,
      portNo: row.portNo,
      simSubscriberName: row.simSubscriberName,
      unitNo: row.unitNo,
      deviceType: row.deviceType,
    },
    dataAsOf,
    available: true,
  };
}
