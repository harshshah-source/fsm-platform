import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RESOLVED_TICKET_STATUSES } from '../ticketing/resolved-ticket-status';

/**
 * OH raw-data "entity mapping" export (Issue 120): one CSV row per device joining the org graph
 * (device → vehicle → plant → zone → company → transporter) with the derived operational columns
 * (zone source, SLA bucket, uptime eligibility, open-ticket count, plant FSM status).
 *
 * The ~19k-device population is streamed in keyset pages (never materialised whole in memory): the
 * service yields the header then batches of rows ordered by `device_id`, so the HTTP response starts
 * flowing after the first page and peak memory is one page, not the whole fleet.
 */

/**
 * Non-open (terminal) ticket statuses — a device's open-ticket count excludes these.
 *
 * #308 — this was the **divergent** copy: four members, silently counting `FAILED_VERIFICATION`,
 * `FAILED_ACTIVATION` and `RECEIVED_AT_WAREHOUSE` tickets as open work. The exported numbers move as a
 * result, and that is the fix, not a side effect.
 */
const CLOSED_TICKET_STATUSES: readonly string[] = RESOLVED_TICKET_STATUSES;

const PAGE_SIZE = 2000;

export const ENTITY_MAPPING_HEADERS = [
  'device_id',
  'vehicle_no',
  'company',
  'plant_name',
  'source_plant_id',
  'zone',
  'zone_source',
  'transporter',
  'deployment_status',
  'plant_fsm_status',
  'latest_gps_datetime',
  'inactive_hours',
  'sla_bucket',
  'eligible_for_uptime',
  'open_ticket_count',
  // #223 — stated, not left to be inferred from a blank cell. This export was surface 6 of the six in
  // `cross-analysis.md` §2.3: it emitted `eligible_for_uptime = true` with an empty
  // `latest_gps_datetime` for all 913 never-reported devices, and every reader had to know that the
  // blank meant "has never reported once" rather than "column not populated for this row". Appended
  // last rather than beside the GPS column so existing column-index consumers are unaffected.
  'never_reported',
] as const;

interface ExportRow {
  deviceId: string;
  vehicleNo: string | null;
  company: string | null;
  plantName: string | null;
  sourcePlantId: bigint | null;
  zone: string | null;
  zoneSource: 'override' | 'mapped' | 'unzoned';
  transporter: string | null;
  deploymentStatus: string | null;
  plantFsmStatus: 'active' | 'deactivated';
  latestGpsDatetime: Date | null;
  inactiveHours: Prisma.Decimal | null;
  slaBucket: string | null;
  eligibleForUptime: boolean;
  openTicketCount: number;
  /** #223 — the device has never sent a single GPS fix. Derived from `latest_gps_datetime IS NULL`. */
  neverReported: boolean;
}

@Injectable()
export class EntityMappingExportService {
  constructor(private readonly prisma: PrismaService) {}

  /** A streaming CSV body for `StreamableFile` — header first, then keyset-paged device rows. */
  toCsvStream(): Readable {
    return Readable.from(this.generateCsv());
  }

  /** Suggested download filename, dated (UTC) so repeated pulls are distinguishable on disk. */
  filename(now: Date = new Date()): string {
    return `entity-mapping-${now.toISOString().slice(0, 10)}.csv`;
  }

  /** Cheap pre-download hint for the card: row count + the freshness of the underlying snapshot. */
  async summary(): Promise<{ rowCount: number; dataAsOf: string | null }> {
    const [row] = await this.prisma.$queryRaw<{ count: bigint; dataAsOf: Date | null }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count, MAX(ds.computed_at) AS "dataAsOf" FROM device_states ds`);
    return { rowCount: Number(row?.count ?? 0n), dataAsOf: row?.dataAsOf ? row.dataAsOf.toISOString() : null };
  }

  private async *generateCsv(): AsyncGenerator<string> {
    yield ENTITY_MAPPING_HEADERS.join(',') + '\n';
    let afterDeviceId = '';
    for (;;) {
      const rows = await this.page(afterDeviceId);
      if (rows.length === 0) break;
      yield rows.map(toCsvLine).join('') || '';
      afterDeviceId = rows[rows.length - 1].deviceId;
      if (rows.length < PAGE_SIZE) break;
    }
  }

  private page(afterDeviceId: string): Promise<ExportRow[]> {
    // Keyset on device_id (the device_states PK) — stable order, no OFFSET drift on a large scan.
    // plant_fsm_status: 'deactivated' when the plant has an active row in plant_deactivations (#119).
    return this.prisma.$queryRaw<ExportRow[]>(Prisma.sql`
      SELECT ds.device_id AS "deviceId",
             v.vehicle_no AS "vehicleNo",
             c.name AS "company",
             p.name AS "plantName",
             p.source_plant_id AS "sourcePlantId",
             z.name AS "zone",
             CASE WHEN p.plant_id IS NULL OR p.zone_id IS NULL THEN 'unzoned'
                  WHEN pzo.source_plant_id IS NOT NULL THEN 'override'
                  ELSE 'mapped' END AS "zoneSource",
             t.name AS "transporter",
             v.status AS "deploymentStatus",
             CASE WHEN pd.plant_id IS NOT NULL THEN 'deactivated' ELSE 'active' END AS "plantFsmStatus",
             ds.latest_gps_datetime AS "latestGpsDatetime",
             ds.inactivity_hours AS "inactiveHours",
             ds.sla_bucket::text AS "slaBucket",
             ds.eligible_for_uptime AS "eligibleForUptime",
             (SELECT COUNT(*) FROM tickets tk
                WHERE tk.device_id = ds.device_id
                  AND tk.status NOT IN (${Prisma.join(CLOSED_TICKET_STATUSES)}))::int AS "openTicketCount",
             (ds.latest_gps_datetime IS NULL) AS "neverReported"
      FROM device_states ds
      JOIN devices d ON d.device_id = ds.device_id
      LEFT JOIN vehicles v ON v.vehicle_id = ds.vehicle_id
      LEFT JOIN plants p ON p.plant_id = ds.plant_id
      LEFT JOIN zones z ON z.zone_id = p.zone_id
      LEFT JOIN company_master c ON c.company_id = ds.company_id
      LEFT JOIN transporters t ON t.transporter_id = ds.transporter_id
      LEFT JOIN plant_zone_overrides pzo ON pzo.source_plant_id = p.source_plant_id
      LEFT JOIN plant_deactivations pd ON pd.plant_id = p.plant_id AND pd.reactivated_at IS NULL
      WHERE ds.device_id > ${afterDeviceId}
      ORDER BY ds.device_id
      LIMIT ${PAGE_SIZE}`);
  }
}

/** RFC-4180-ish: quote a cell containing comma/quote/newline; double interior quotes. */
function esc(v: string | number | bigint | boolean | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsvLine(r: ExportRow): string {
  return (
    [
      r.deviceId,
      r.vehicleNo,
      r.company,
      r.plantName,
      r.sourcePlantId,
      r.zone,
      r.zoneSource,
      r.transporter,
      r.deploymentStatus,
      r.plantFsmStatus,
      r.latestGpsDatetime ? r.latestGpsDatetime.toISOString() : '',
      r.inactiveHours === null ? '' : r.inactiveHours.toString(),
      r.slaBucket,
      r.eligibleForUptime,
      r.openTicketCount,
      r.neverReported,
    ]
      .map(esc)
      .join(',') + '\n'
  );
}
