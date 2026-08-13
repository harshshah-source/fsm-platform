import type { AutoRecoveryPlanRow } from './auto-recovery.service';

/**
 * #229 — argument parsing and CSV rendering for `npm run autorecovery:dryrun`.
 *
 * Separate from the CLI entrypoint for the same reason `stand-down-export.ts` is (#128/#218c): the
 * entrypoint ends in `void main()`, so anything importable from it would run the whole scan on
 * import. These two are pure, so they are unit-tested directly.
 */

export interface DryRunArgs {
  zoneId?: number;
  maxClosures?: number;
  exportPath?: string;
}

/**
 * Parsed before anything expensive, so a mistyped flag surfaces immediately rather than after a full
 * scan of the open book. Throws — the caller turns that into a non-zero exit.
 *
 * Unknown `--flags` are rejected rather than ignored, because the two flags that matter (`--max`,
 * `--zone`) are what make a first drain *staged*: a typo silently dropped would produce an unbounded
 * preview while the operator believed they had bounded it. The one exception is Node's own
 * `dotenv_config_*` tokens — `node -r dotenv/config … dotenv_config_path=.env` puts them in `argv`,
 * so every npm-script entrypoint in this repo sees them.
 */
export function parseDryRunArgs(argv: readonly string[]): DryRunArgs {
  const args: DryRunArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag.startsWith('dotenv_config_')) continue;
    const requireValue = (): string => {
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      i++;
      return next;
    };
    if (flag === '--zone') {
      const n = Number(requireValue());
      if (!Number.isInteger(n) || n <= 0) throw new Error('--zone must be a positive integer zone id');
      args.zoneId = n;
    } else if (flag === '--max') {
      const n = Number(requireValue());
      if (!Number.isInteger(n) || n <= 0) throw new Error('--max must be a positive integer');
      args.maxClosures = n;
    } else if (flag === '--export') {
      args.exportPath = requireValue();
    } else {
      throw new Error(`unknown flag: ${flag} (expected --zone, --max or --export)`);
    }
  }
  return args;
}

const csvCell = (value: unknown): string => {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per ticket, carrying the evidence that qualified it — a count is not evidence (#229). */
export function toPlanCsv(rows: readonly AutoRecoveryPlanRow[]): string {
  const header = [
    'ticket_no', 'ticket_id', 'device_id', 'cycle_id', 'cycle_opened_at',
    'ping_count', 'first_ping', 'last_ping', 'span_minutes', 'zone_id', 'plant_id', 'company_id',
  ];
  const lines = rows.map((r) =>
    [
      r.ticketNo, r.ticketId, r.deviceId, r.cycleId, r.cycleOpenedAt.toISOString(),
      r.pingCount, r.firstPing?.toISOString() ?? '', r.lastPing?.toISOString() ?? '',
      r.spanMinutes.toFixed(1), r.zoneId ?? '', r.plantId, r.companyId,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

/** Bucket a plan by one of its key fields, returning entries sorted descending by count. */
export function groupPlanBy(
  rows: readonly AutoRecoveryPlanRow[],
  key: (row: AutoRecoveryPlanRow) => string,
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
