/**
 * TEST-ONLY CSV-backed SourceReader.  (Lives under test/ — NOT wired into any module. Production
 * code is imported, never modified.)
 *
 * It implements the exact same `SourceReader` seam the real AutoPlant reader will bind to, so the
 * REAL `SnapshotIngestionWorker` / `SnapshotIngestionService` pipeline runs unchanged against CSV
 * rows. Two deliberate accommodations for the corrupted export:
 *
 *   1. device_id is unrecoverable (scientific-notation collapse), so we mint a STABLE synthetic
 *      BigInt device_id per `vehicle_no` (vehicle_no is 100% unique). The map is built once up front
 *      and exposed via getSeedData() so the test can seed devices/vehicles with matching ids.
 *   2. CSV dates are `DD-MM-YYYY HH:mm` (no seconds); we reformat to the ISO shape the PRODUCTION
 *      `normalizeGpsTimestamp` expects and reuse it (IST +330) — so UTC normalization is tested for
 *      real, not re-implemented.
 *
 * One ping per device (latest snapshot), so this drives ingestion → device-state → tickets only.
 */
import { readFileSync } from 'node:fs';
import { normalizeGpsTimestamp } from '../../src/ingestion/normalize';
import type { SourceReader, SourceChunk, SourceSnapshotRow } from '../../src/ingestion/source-reader';

const SYNTH_BASE = 900_000_000_000_000n; // '9' prefix marks the id synthetic
const IST_OFFSET_MIN = 330;

export interface CsvDeviceSeed {
  deviceId: bigint;
  vehicleNo: string;
  plantCode: string; // raw plant_id from CSV (used to group plants in the test)
  plantName: string;
  transporterId: string;
  deviceType: string | null;
}

/** Minimal RFC4180-ish field split: respects double-quoted fields containing commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const isNull = (s: string | undefined) => s === undefined || s === '' || s === 'NULL' || s === 'null';
const num = (s: string | undefined) => (isNull(s) ? null : Number(s));

/** `DD-MM-YYYY HH:mm` → production-normalizer UTC instant, or null if absent/unparseable. */
function gpsToUtc(raw: string | undefined): Date | null {
  if (isNull(raw)) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/.exec(raw!.trim());
  if (!m) return null;
  const [, d, mo, y, hh, mm] = m;
  return normalizeGpsTimestamp(`${y}-${mo}-${d}T${hh}:${mm}:00`, IST_OFFSET_MIN);
}

export class CsvSourceReader implements SourceReader {
  private readonly rows: SourceSnapshotRow[] = [];
  private readonly seeds: CsvDeviceSeed[] = [];

  /** @param csvPath absolute path to one Book*.csv  @param limit optional row cap for fast tests */
  constructor(csvPath: string, limit = Infinity) {
    const lines = readFileSync(csvPath, 'utf8').split(/\r?\n/);
    const header = splitCsvLine(lines[0]);
    const ix = (name: string) => header.indexOf(name);
    const C = {
      vno: ix('vehicle_no'), gps: ix('latest_gps_datetime'), plantId: ix('plant_id'),
      plantName: ix('plant_name'), transId: ix('transporter_id'), lat: ix('latitude'),
      lon: ix('longitude'), speed: ix('speed'), ign: ix('IGNITION_STATUS'),
      devType: ix('DEVICE_TYPE'), main: ix('MAIN_STATUS'),
    };

    const idOf = new Map<string, bigint>();
    let seq = 0;
    let taken = 0;
    for (let i = 1; i < lines.length && taken < limit; i++) {
      if (!lines[i]) continue;
      const f = splitCsvLine(lines[i]);
      const vno = f[C.vno];
      if (isNull(vno)) continue; // no stable key → unusable row
      if (!idOf.has(vno)) idOf.set(vno, SYNTH_BASE + BigInt(++seq));
      const deviceId = idOf.get(vno)!;

      this.seeds.push({
        deviceId, vehicleNo: vno,
        plantCode: isNull(f[C.plantId]) || f[C.plantId] === '0' ? '9999' : f[C.plantId],
        plantName: (f[C.plantName] || 'UNKNOWN').trim(),
        transporterId: f[C.transId] ?? '',
        deviceType: isNull(f[C.devType]) ? null : f[C.devType].trim(),
      });

      const gpsDatetime = gpsToUtc(f[C.gps]);
      if (gpsDatetime) {
        this.rows.push({
          deviceId, gpsDatetime,
          lat: num(f[C.lat]), lon: num(f[C.lon]), speed: num(f[C.speed]),
          ignitionStatus: isNull(f[C.ign]) ? null : f[C.ign],
          mainsStatus: num(f[C.main]),
          deviceType: isNull(f[C.devType]) ? null : f[C.devType].trim(),
        });
      }
      taken++;
    }
  }

  /** Seed data for the test to create Zone/Company/Plant/Vehicle/Device/PGI with matching ids. */
  getSeedData(): { devices: CsvDeviceSeed[]; snapshotRowCount: number } {
    return { devices: this.seeds, snapshotRowCount: this.rows.length };
  }

  async readChunk(cursor: string | null, chunkSize: number): Promise<SourceChunk> {
    const start = cursor === null ? 0 : Number(cursor);
    const slice = this.rows.slice(start, start + chunkSize);
    const next = start + slice.length;
    const exhausted = slice.length === 0 || next >= this.rows.length;
    return { rows: slice, nextCursor: exhausted ? null : String(next) };
  }
}
