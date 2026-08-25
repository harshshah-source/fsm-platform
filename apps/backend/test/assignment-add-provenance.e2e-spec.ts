import { PrismaService } from '../src/prisma/prisma.service';
import { ADD_SOURCES, ALL_ADD_SOURCES, COVERAGE_AT_ASSIGN } from '../src/scheduling/add-source';

/**
 * #283 slice 1 — the add side of `batch_assignment_tickets` learns who, why and through which door.
 *
 * The removal side has carried `removed_at` / `removed_by` / `removal_reason` since #241. The add
 * side set exactly three fields (`batch_id`, `ticket_id`, `sort_order`) from all four of its writers,
 * so "who put this ticket on this plan" was answerable only by joining `audit_logs` — and, on the
 * intraday CRITICAL path, not even then: the system and a ZM both audit as `CRITICAL_ASSIGN`.
 *
 * Storage posture is deliberately the mirror of #241's: TEXT rather than a Postgres enum so later
 * slices add members without a migration, with the closed set enforced in TypeScript. All four
 * columns are nullable because history predates them — NULL means "written before provenance
 * existed" and must render as unknown, never as a system decision (#282 R2).
 */
describe('#283 slice 1 — assignment add-provenance columns and vocabulary', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  const column = async (
    table: string,
    name: string,
  ): Promise<{ data_type: string; is_nullable: string } | null> => {
    const rows = await prisma.$queryRaw<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${name}`;
    return rows[0] ?? null;
  };

  it('adds added_by, add_reason, add_source and coverage_type_at_assign — all nullable', async () => {
    expect(await column('batch_assignment_tickets', 'added_by')).toEqual({
      data_type: 'uuid',
      is_nullable: 'YES',
    });
    for (const name of ['add_reason', 'add_source', 'coverage_type_at_assign']) {
      expect(await column('batch_assignment_tickets', name)).toEqual({
        data_type: 'text',
        is_nullable: 'YES',
      });
    }
  });

  it('keeps the vocabulary in TypeScript, not in a Postgres enum (the #241 posture)', async () => {
    const enumTypes = await prisma.$queryRaw<{ typname: string }[]>`
      SELECT t.typname FROM pg_type t
      WHERE t.typname IN ('add_source', 'coverage_at_assign')`;
    expect(enumTypes).toEqual([]);
  });

  it('publishes a closed add-source vocabulary covering every production writer', () => {
    // One member per door work can enter a plan through. AUTO_DISPATCH is the morning engine;
    // SYSTEM_CRITICAL is the intraday engine — the two the data could not previously tell apart
    // from a human, because both wrote a bare row and audited as CRITICAL_ASSIGN.
    expect(ALL_ADD_SOURCES).toEqual([
      'AUTO_DISPATCH',
      'SYSTEM_CRITICAL',
      'MANUAL_ASSIGN',
      'MANUAL_BATCH_ASSIGN',
      'MANUAL_PLANT_ASSIGN',
      'MANUAL_REASSIGN',
      'MANUAL_SPLIT',
      'SAME_DAY_ADD',
      'CROSS_ZONE_ASSIGN',
    ]);
    expect(ADD_SOURCES.AUTO_DISPATCH).toBe('AUTO_DISPATCH');
  });

  it('carries NONE in the coverage vocabulary — a human may assign an SE who covers nothing there', () => {
    // The three tiers are what the engine can choose from; a manual assign is not restricted to
    // them (#258 Q1 orders the engine's candidates, it does not gate a manager). Recording such an
    // assignment as FLOATING would be a fabrication, so the absence gets its own member.
    expect(Object.values(COVERAGE_AT_ASSIGN)).toEqual([
      'DEDICATED',
      'MULTI_PLANT',
      'FLOATING',
      'NONE',
    ]);
  });
});
