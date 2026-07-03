/**
 * Book8 dataset — PURE parsing / classification / deterministic synthesis (NO database, NO Nest).
 *
 * This module turns `data/Book8_fixed.csv` into a self-consistent in-memory test world:
 *   • the telemetry rows the production SnapshotIngestionWorker will consume (via Book8SourceReader),
 *   • the CSV-derived master graph (zones → companies → plants → vehicles → devices),
 *   • the minimum synthetic data the CSV cannot supply (PGI history for eligibility),
 *   • a row-by-row classification so the harness can report exactly what was used vs skipped and why.
 *
 * It NEVER touches production code beyond importing the production UTC normalizer and the production
 * SourceSnapshotRow type — so UTC conversion is tested for real, not re-implemented.
 *
 * Determinism: every derivation is a pure function of the CSV file contents (stable file order) and
 * a clock derived from that file's latest ping (`datasetNow`, below). No Math.random(), no Date.now().
 * Re-running on the same file yields byte-identical master/mappings/telemetry.
 *
 * Dataset selection: `loadBook8Dataset()` reads `BOOK_DATASET` (repo-root-relative path) when set, else
 * defaults to Book8 — so Book4–Book8 run through this same harness unchanged (see `defaultCsvPath`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeGpsTimestamp } from '../../../src/ingestion/normalize';
import type { SourceSnapshotRow } from '../../../src/ingestion/source-reader';

/** AutoPlant GPS wall-clock is IST; production normalizer backs out the +330 offset to a UTC instant. */
const IST_OFFSET_MIN = 330;

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The injected "now" for the whole environment is anchored ONE MINUTE AFTER the SELECTED dataset's
 * latest parseable ping, so inactivity ages produce a realistic SLA-bucket spread instead of every
 * device reading as LONG_PENDING (which today's real clock would yield). It is DERIVED per-dataset in
 * `loadBook8Dataset` (exposed as `Book8Dataset.datasetNow`) rather than assuming Book8 — e.g. Book8's
 * latest ping 2026-04-26 12:59 IST → now 13:00 IST (2026-04-26T07:30:00Z), and Book4's own latest
 * ping anchors its own clock.
 */
const NOW_ANCHOR_OFFSET_MS = 60_000;
/** Fallback only — used when a dataset has no parseable ping at all (Book8 anchor − 1 min). */
const FALLBACK_MAX_PING_MS = Date.UTC(2026, 3, 26, 7, 29, 0);

/** Canonical zones (CONTEXT.md: NORTH / SOUTH / EAST / WEST). Zone is NOT in the CSV, so plant→zone
 *  is a deterministic synthetic partition (plant code mod 4) chosen to exercise zone-scoped and
 *  cross-zone workflows. */
export const ZONE_NAMES = ['EAST', 'NORTH', 'SOUTH', 'WEST'] as const;
export type ZoneName = (typeof ZONE_NAMES)[number];

const PLANT_SENTINEL_CODE = '9999'; // CSV plant_id 0/blank → sentinel, mirrors the existing fixture.
const UNKNOWN_COMPANY_KEY = '__UNKNOWN__';

const CLEAN_DEVICE_ID = /^[0-9]{14,16}$/;

export type SkipReason =
  | 'MISALIGNED_ROW'
  | 'MISSING_VEHICLE_NO'
  | 'COLLAPSED_DEVICE_ID'
  | 'DUPLICATE_DEVICE_ID';

export interface UsableRow {
  vehicleNo: string;
  deviceId: string;
  /** UTC instant of the latest ping, or null when the CSV timestamp was absent/unparseable. */
  gpsDatetime: Date | null;
  lat: number | null;
  lon: number | null;
  speed: number | null;
  ignitionStatus: string | null;
  mainsStatus: number | null;
  deviceType: string | null;
  plantCode: string;
  plantName: string;
  companyKey: string; // LATEST_INSTALLATION_COMPANYID, or UNKNOWN_COMPANY_KEY
  transporterId: bigint | null;
  dealType: 'RECURRING' | 'ONE_TIME';
  /** Synthetic eligibility decision (see rule below) — drives whether a PGI row is generated. */
  pgiEligible: boolean;
}

export interface DerivedZone {
  name: ZoneName;
}
export interface DerivedCompany {
  key: string; // CSV company id (or UNKNOWN_COMPANY_KEY)
  name: string;
  tier: 'PLATINUM' | 'GOLD' | 'SILVER';
  rank: string;
}
export interface DerivedPlant {
  code: string; // CSV plant_id (or sentinel)
  name: string; // canonical, suffixed with code for uniqueness
  zone: ZoneName;
}

export interface Book8Dataset {
  usable: UsableRow[];
  zones: DerivedZone[];
  companies: DerivedCompany[];
  plants: DerivedPlant[];
  /** Telemetry pings (one latest ping per usable device that had a parseable timestamp). */
  telemetry: SourceSnapshotRow[];
  /** Injected clock for the whole environment — one minute after the latest telemetry ping. */
  datasetNow: Date;
  /** Synthetic PGI date (datasetNow − 5 d) — comfortably inside the 15-day eligibility window. */
  syntheticPgiDate: Date;
  classification: {
    totalRows: number;
    usableCount: number;
    withGps: number;
    withoutGps: number;
    skipped: Record<SkipReason, number>;
    pgiEligibleCount: number;
    pgiIneligibleCount: number;
  };
  skippedSamples: Record<SkipReason, string[]>; // up to 5 vehicle_no examples per reason
}

/** Minimal RFC4180-ish field split: respects double-quoted fields and "" escapes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const isNull = (s: string | undefined): boolean =>
  s === undefined || s.trim() === '' || s.toUpperCase() === 'NULL' || s.toUpperCase() === 'NA';
const num = (s: string | undefined): number | null => (isNull(s) ? null : Number(s));

/** `DD-MM-YYYY HH:mm` (IST) → production-normalizer UTC instant, or null if absent/unparseable. */
function gpsToUtc(raw: string | undefined): Date | null {
  if (isNull(raw)) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/.exec(raw!.trim());
  if (!m) return null;
  const [, d, mo, y, hh, mm] = m;
  return normalizeGpsTimestamp(`${y}-${mo}-${d}T${hh}:${mm}:00`, IST_OFFSET_MIN);
}

const TIERS = ['PLATINUM', 'GOLD', 'SILVER'] as const;

export function defaultCsvPath(): string {
  // The harness selects the dataset via the BOOK_DATASET env var (repo-root-relative, e.g.
  // `data/Book5_fixed.csv`, or an absolute path). Absent, it defaults to Book8 — preserving the
  // original behavior exactly. vitest runs with cwd = apps/backend; the data/ dir is at the repo root.
  const envPath = process.env.BOOK_DATASET?.trim();
  if (envPath) return resolve(process.cwd(), '../../', envPath);
  return resolve(process.cwd(), '../../data/Book8_fixed.csv');
}

/**
 * Parse + classify + derive. `csvPath` defaults to the repo dataset. The full file is read; nothing
 * is reduced or sampled (the CSV is treated as the production telemetry source).
 */
export function loadBook8Dataset(csvPath: string = defaultCsvPath()): Book8Dataset {
  const text = readFileSync(csvPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const header = splitCsvLine(lines[0]);
  const ix = (name: string): number => header.indexOf(name);
  const C = {
    vehicleNo: ix('vehicle_no'),
    deviceId: ix('device_id'),
    gps: ix('latest_gps_datetime'),
    plantId: ix('plant_id'),
    plantName: ix('plant_name'),
    transporterId: ix('transporter_id'),
    lat: ix('latitude'),
    lon: ix('longitude'),
    speed: ix('speed'),
    ign: ix('IGNITION_STATUS'),
    main: ix('MAIN_STATUS'),
    devType: ix('DEVICE_TYPE'),
    company: ix('LATEST_INSTALLATION_COMPANYID'),
  };
  const expectedCols = header.length;

  // First pass: count clean device_id occurrences so we can flag duplicates deterministically.
  const deviceIdCount = new Map<string, number>();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = splitCsvLine(lines[i]);
    if (f.length !== expectedCols) continue;
    const dev = f[C.deviceId]?.trim();
    if (dev && CLEAN_DEVICE_ID.test(dev)) deviceIdCount.set(dev, (deviceIdCount.get(dev) ?? 0) + 1);
  }

  const usable: UsableRow[] = [];
  const skipped: Record<SkipReason, number> = {
    MISALIGNED_ROW: 0,
    MISSING_VEHICLE_NO: 0,
    COLLAPSED_DEVICE_ID: 0,
    DUPLICATE_DEVICE_ID: 0,
  };
  const skippedSamples: Record<SkipReason, string[]> = {
    MISALIGNED_ROW: [],
    MISSING_VEHICLE_NO: [],
    COLLAPSED_DEVICE_ID: [],
    DUPLICATE_DEVICE_ID: [],
  };
  const sample = (r: SkipReason, vno: string): void => {
    if (skippedSamples[r].length < 5) skippedSamples[r].push(vno || '(blank)');
  };

  let totalRows = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    totalRows++;
    const f = splitCsvLine(lines[i]);
    if (f.length !== expectedCols) {
      skipped.MISALIGNED_ROW++;
      sample('MISALIGNED_ROW', f[C.vehicleNo] ?? '');
      continue;
    }
    const vehicleNo = f[C.vehicleNo]?.trim() ?? '';
    if (isNull(vehicleNo)) {
      skipped.MISSING_VEHICLE_NO++;
      sample('MISSING_VEHICLE_NO', vehicleNo);
      continue;
    }
    const devRaw = f[C.deviceId]?.trim() ?? '';
    if (!CLEAN_DEVICE_ID.test(devRaw)) {
      skipped.COLLAPSED_DEVICE_ID++;
      sample('COLLAPSED_DEVICE_ID', vehicleNo);
      continue;
    }
    if ((deviceIdCount.get(devRaw) ?? 0) > 1) {
      skipped.DUPLICATE_DEVICE_ID++;
      sample('DUPLICATE_DEVICE_ID', vehicleNo);
      continue;
    }

    // Device id is a String key (leading-zero / alphanumeric ids survive verbatim). Book8 ids are
    // clean numeric strings; `deviceNum` is the numeric view used only for the synthetic deal-type /
    // eligibility derivations below.
    const deviceId = devRaw;
    const deviceNum = BigInt(devRaw);
    const plantCodeRaw = f[C.plantId]?.trim() ?? '';
    const plantCode = isNull(plantCodeRaw) || plantCodeRaw === '0' ? PLANT_SENTINEL_CODE : plantCodeRaw;
    const companyRaw = f[C.company]?.trim() ?? '';
    const companyKey = isNull(companyRaw) ? UNKNOWN_COMPANY_KEY : companyRaw;
    const transporterRaw = f[C.transporterId]?.trim() ?? '';
    const transporterId =
      isNull(transporterRaw) || !/^[0-9]+$/.test(transporterRaw) ? null : BigInt(transporterRaw);

    usable.push({
      vehicleNo,
      deviceId,
      gpsDatetime: gpsToUtc(f[C.gps]),
      lat: num(f[C.lat]),
      lon: num(f[C.lon]),
      speed: num(f[C.speed]),
      ignitionStatus: isNull(f[C.ign]) ? null : f[C.ign].trim(),
      mainsStatus: num(f[C.main]),
      deviceType: isNull(f[C.devType]) ? null : f[C.devType].trim(),
      plantCode,
      plantName: (isNull(f[C.plantName]) ? 'UNKNOWN' : f[C.plantName]).trim(),
      companyKey,
      transporterId,
      // Deal type: even device ids → RECURRING (provider-owned, Recovery-eligible), odd → ONE_TIME.
      dealType: deviceNum % 2n === 0n ? 'RECURRING' : 'ONE_TIME',
      // Eligibility rule: 9 of every 10 devices get a recent PGI (eligible); device ids ending in 0
      // are deliberately left without PGI to exercise the ineligible → no-ticket negative path.
      pgiEligible: deviceNum % 10n !== 0n,
    });
  }

  // ── Derive master sets (deterministic; sorted for stable ids on first insert) ───────────────────
  const companyKeys = [...new Set(usable.map((r) => r.companyKey))].sort();
  const companies: DerivedCompany[] = companyKeys.map((key, i) => ({
    key,
    name: key === UNKNOWN_COMPANY_KEY ? 'BOOK8 Co UNKNOWN' : `BOOK8 Co ${key}`,
    // (tier, rank) must be unique per the Company @@unique([tier, rank]); ranks A.. are all distinct.
    tier: TIERS[i % TIERS.length],
    rank: String.fromCharCode(65 + i),
  }));

  const plantCodes = [...new Set(usable.map((r) => r.plantCode))].sort((a, b) => Number(a) - Number(b));
  const nameByPlant = new Map<string, string>();
  for (const r of usable) if (!nameByPlant.has(r.plantCode)) nameByPlant.set(r.plantCode, r.plantName);
  const plants: DerivedPlant[] = plantCodes.map((code) => ({
    code,
    name: `${nameByPlant.get(code) ?? 'UNKNOWN'} [${code}]`,
    zone: ZONE_NAMES[Math.abs(Number(code)) % ZONE_NAMES.length],
  }));

  const zones: DerivedZone[] = ZONE_NAMES.map((name) => ({ name }));

  const telemetry: SourceSnapshotRow[] = usable
    .filter((r) => r.gpsDatetime !== null)
    .map((r) => ({
      deviceId: r.deviceId,
      gpsDatetime: r.gpsDatetime!,
      lat: r.lat,
      lon: r.lon,
      speed: r.speed,
      ignitionStatus: r.ignitionStatus,
      mainsStatus: r.mainsStatus,
      deviceType: r.deviceType,
    }));

  const withGps = telemetry.length;

  // Anchor the injected clock one minute after the dataset's latest parseable ping (folded, not
  // spread, to stay safe on large telemetry sets). Book8 → 2026-04-26T07:30:00Z; each other book
  // anchors to its own day.
  let maxPingMs = -Infinity;
  for (const t of telemetry) {
    const ms = t.gpsDatetime.getTime();
    if (ms > maxPingMs) maxPingMs = ms;
  }
  if (maxPingMs === -Infinity) maxPingMs = FALLBACK_MAX_PING_MS;
  const datasetNow = new Date(maxPingMs + NOW_ANCHOR_OFFSET_MS);
  const syntheticPgiDate = new Date(datasetNow.getTime() - 5 * DAY_MS);

  return {
    usable,
    zones,
    companies,
    plants,
    telemetry,
    datasetNow,
    syntheticPgiDate,
    classification: {
      totalRows,
      usableCount: usable.length,
      withGps,
      withoutGps: usable.length - withGps,
      skipped,
      pgiEligibleCount: usable.filter((r) => r.pgiEligible).length,
      pgiIneligibleCount: usable.filter((r) => !r.pgiEligible).length,
    },
    skippedSamples,
  };
}
