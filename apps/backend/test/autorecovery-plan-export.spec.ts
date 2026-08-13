import type { AutoRecoveryPlanRow } from '../src/ticketing/auto-recovery.service';
import { groupPlanBy, parseDryRunArgs, toPlanCsv } from '../src/ticketing/autorecovery-plan-export';

/**
 * #229 — the pure halves of `npm run autorecovery:dryrun`. The CLI itself ends in `void main()` and
 * needs a database; these two do not, so the flag contract and the CSV shape are pinned here.
 *
 * The flag validation matters more than it looks: `--max` and `--zone` are the two knobs that make a
 * first drain staged rather than total, and a silently-ignored typo (`--max abc` parsing to NaN, or
 * `--zone` swallowing the next flag as its value) would produce an *uncapped* run while the operator
 * believed they had bounded it.
 */
const row = (over: Partial<AutoRecoveryPlanRow> = {}): AutoRecoveryPlanRow => ({
  ticketId: 'ac1d1f7e-0000-4000-8000-000000000001',
  ticketNo: '4211',
  deviceId: '9081001',
  cycleId: 'bb1d1f7e-0000-4000-8000-000000000001',
  cycleOpenedAt: new Date('2026-07-13T04:00:00.000Z'),
  pingCount: 32,
  firstPing: new Date('2026-07-13T05:00:00.000Z'),
  lastPing: new Date('2026-07-13T09:30:00.000Z'),
  spanMinutes: 270,
  plantId: '17',
  companyId: '4',
  zoneId: '3',
  ...over,
});

describe('#229 — autorecovery:dryrun argument parsing', () => {
  it('defaults to an unbounded, unscoped, non-exporting preview', () => {
    expect(parseDryRunArgs([])).toEqual({});
  });

  it('parses --zone, --max and --export together', () => {
    expect(parseDryRunArgs(['--zone', '3', '--max', '200', '--export', 'plan.csv'])).toEqual({
      zoneId: 3,
      maxClosures: 200,
      exportPath: 'plan.csv',
    });
  });

  it('rejects a non-numeric or non-positive cap rather than silently running uncapped', () => {
    expect(() => parseDryRunArgs(['--max', 'abc'])).toThrow('--max');
    expect(() => parseDryRunArgs(['--max', '0'])).toThrow('--max');
    expect(() => parseDryRunArgs(['--zone', '-1'])).toThrow('--zone');
  });

  it('rejects a flag whose value is missing — the next flag is never consumed as a value', () => {
    expect(() => parseDryRunArgs(['--max', '--export', 'plan.csv'])).toThrow('--max requires a value');
    expect(() => parseDryRunArgs(['--export'])).toThrow('--export requires a value');
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    expect(() => parseDryRunArgs(['--apply'])).toThrow('unknown flag');
  });

  it('ignores the dotenv_config_* tokens node -r dotenv/config puts in argv', () => {
    expect(parseDryRunArgs(['dotenv_config_path=.env', '--max', '50'])).toEqual({ maxClosures: 50 });
  });
});

describe('#229 — autorecovery:dryrun CSV', () => {
  it('emits a header plus one row per ticket, carrying the qualifying evidence', () => {
    const csv = toPlanCsv([row(), row({ ticketNo: '4212', deviceId: '9081002', pingCount: 5, spanMinutes: 61.5 })]);
    const lines = csv.split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      'ticket_no,ticket_id,device_id,cycle_id,cycle_opened_at,ping_count,first_ping,last_ping,span_minutes,zone_id,plant_id,company_id',
    );
    expect(lines[1]).toContain('4211,ac1d1f7e-0000-4000-8000-000000000001,9081001');
    expect(lines[1]).toContain('2026-07-13T04:00:00.000Z');
    expect(lines[1]).toContain('270.0');
    expect(lines[2]).toContain('61.5');
  });

  it('renders a device with no zone as an empty cell, not the string "null"', () => {
    expect(toPlanCsv([row({ zoneId: null })]).split('\n')[1]).toMatch(/,,17,4$/);
  });

  it('groups by any key, most-affected first — the staging view', () => {
    const plan = [row({ zoneId: '3' }), row({ zoneId: '5' }), row({ zoneId: '3' })];
    expect(groupPlanBy(plan, (r) => r.zoneId ?? '(no zone)')).toEqual([
      ['3', 2],
      ['5', 1],
    ]);
  });
});
