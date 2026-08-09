import { SnapshotIngestionService } from '../src/ingestion/snapshot-ingestion.service';
import { TRUE_SOURCE_UTC_OFFSET_MIN, normalizeSourceRow } from '../src/ingestion/normalize';
import type { SourceSnapshotRow } from '../src/ingestion/source-reader';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * `device_states.first_reported_at` — the commissioning anchor, and the only WRITE-ONCE column on the
 * ingest path. It had no test at all until this file (the gap #228 is about: a value that cannot be
 * re-derived, guarded by nothing).
 *
 * Two properties make it different from every other column here, and both are why a wrong value would
 * be permanent rather than merely wrong:
 *
 *  1. **Write-once by COALESCE, not GREATEST/LEAST.** Nothing in FSM else retains a first-ever ping —
 *     `latest_gps_datetime` is overwritten every tick and `raw_device_snapshots` drops partitions after
 *     7 days. Once set, it is never revisited, so an incorrect freeze cannot be corrected by a later run.
 *  2. **Written at TRUE UTC (offset 0), NOT at the live `AUTOPLANT_UTC_OFFSET_MIN = 330`.** #222 owns
 *     that constant; a column frozen under it would carry the 5.5 h error forever. Hence the separate
 *     `gpsDatetimeUtc` on the source row and the recorded `first_reported_offset_min`.
 *
 * The consequence a test must ENCODE rather than "fix": while #222 is open, `first_reported_at` may read
 * LATER than `latest_gps_datetime` on the same row, because they are written at different offsets. The
 * migration warns against adding a `first_reported_at <= latest_gps_datetime` CHECK before then; the
 * last test here pins that expectation so nobody "corrects" it into a constraint.
 */
const DEV_A = 'FIRST_REPORTED_A';
const DEV_B = 'FIRST_REPORTED_B';
const DEV_C = 'FIRST_REPORTED_C';

/** A naive AutoPlant wall clock, exactly as `dateStrings: true` hands it over. */
const wall = (day: number, hour: number): string =>
  `2026-07-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:00:00`;

/** The instant that wall clock denotes under the CORRECTED convention (offset 0 ⇒ read as UTC). */
const trueUtc = (day: number, hour: number): Date => new Date(`2026-07-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`);

/**
 * Build a row the way the real AutoPlant path does — through `normalizeSourceRow`, so `gpsDatetime`
 * takes the live (still wrong) +330 and `gpsDatetimeUtc` takes offset 0. Constructing the pair by hand
 * would let the test agree with itself while disagreeing with production.
 */
const row = (deviceId: string, day: number, hour: number): SourceSnapshotRow =>
  normalizeSourceRow({
    deviceId,
    gpsWallClock: wall(day, hour),
    sourceUtcOffsetMinutes: 330,
    tripCreationDatetime: null,
  } as Parameters<typeof normalizeSourceRow>[0]);

/** A row from a reader that supplies no corrected timestamp (e.g. the in-memory fixture reader). */
const rowWithoutUtc = (deviceId: string, day: number, hour: number): SourceSnapshotRow => {
  const r = row(deviceId, day, hour);
  return { ...r, gpsDatetimeUtc: null };
};

describe('commissioning capture — device_states.first_reported_at at ingest', () => {
  let prisma: PrismaService;
  let service: SnapshotIngestionService;
  const runIds: bigint[] = [];
  const ids = [DEV_A, DEV_B, DEV_C];

  const newRun = async (): Promise<bigint> => {
    const run = await prisma.snapshotRun.create({ data: { status: 'SUCCESS' } });
    runIds.push(run.runId);
    return run.runId;
  };

  const state = (deviceId: string) => prisma.deviceState.findUnique({ where: { deviceId } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new SnapshotIngestionService(prisma);
    await prisma.device.createMany({ data: ids.map((deviceId) => ({ deviceId })), skipDuplicates: true });
  });

  afterAll(async () => {
    await prisma.rawDeviceSnapshot.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ids } } });
    await prisma.snapshotRun.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ids } } });
    await prisma.onModuleDestroy();
  });

  it('freezes the first ping in TRUE UTC and records the offset that was applied', async () => {
    const runId = await newRun();
    await service.ingestChunk(runId, [row(DEV_A, 10, 6)]);

    const ds = await state(DEV_A);
    expect(ds?.firstReportedAt).toEqual(trueUtc(10, 6));
    // Not 00:30 — a +330 freeze here could never be corrected, since nothing revisits the column.
    expect(ds?.firstReportedAt).not.toEqual(new Date('2026-07-10T00:30:00.000Z'));
    // The row describes itself: AUTOPLANT_SOURCE_UTC_OFFSET_MIN is runtime-overridable, so the constant
    // in source is not evidence of what THIS row received.
    expect(ds?.firstReportedOffsetMin).toBe(TRUE_SOURCE_UTC_OFFSET_MIN);
    expect(ds?.firstReportedOffsetMin).toBe(0);
  });

  it('is WRITE-ONCE — a later ping does not displace it', async () => {
    const runId = await newRun();
    await service.ingestChunk(runId, [row(DEV_A, 12, 9)]);

    const ds = await state(DEV_A);
    expect(ds?.firstReportedAt).toEqual(trueUtc(10, 6));
    // The ping watermark DID advance — proving the chunk was ingested and the column simply held.
    expect(ds?.latestGpsDatetime).toEqual(new Date('2026-07-12T03:30:00.000Z'));
  });

  it('is WRITE-ONCE against an EARLIER ping too — COALESCE, not LEAST', async () => {
    // The specific trap the migration calls out. After #222 flips the constant, correct values are 5.5 h
    // LATER than the poisoned ones, so a LEAST() here would pin every device to its pre-fix value
    // forever — the one form of "fix" that would silently destroy what this column is for.
    const runId = await newRun();
    await service.ingestChunk(runId, [row(DEV_A, 2, 1)]);

    expect((await state(DEV_A))?.firstReportedAt).toEqual(trueUtc(10, 6));
  });

  it('takes the chunk-MIN, not the chunk-max, when one chunk carries several pings', async () => {
    const runId = await newRun();
    await service.ingestChunk(runId, [row(DEV_B, 20, 11), row(DEV_B, 18, 4), row(DEV_B, 22, 15)]);

    const ds = await state(DEV_B);
    expect(ds?.firstReportedAt).toEqual(trueUtc(18, 4));
    // …while the watermark still takes the max, from the same statement.
    expect(ds?.latestGpsDatetime).toEqual(new Date('2026-07-22T09:30:00.000Z'));
  });

  it('leaves the column unset when the reader supplies no corrected timestamp', async () => {
    // A null must NOT be back-filled from `gpsDatetime`: that would freeze a +330 value under the guise
    // of offset 0, which is worse than having no value at all. Non-AutoPlant readers (the in-memory
    // fixture reader) legitimately supply none.
    const runId = await newRun();
    const res = await service.ingestChunk(runId, [rowWithoutUtc(DEV_C, 5, 7)]);

    expect(res.deviceStatesUpserted).toBe(1);
    const ds = await state(DEV_C);
    expect(ds?.firstReportedAt).toBeNull();
    expect(ds?.firstReportedOffsetMin).toBeNull();
    // …and the ping write is unaffected — a missing commissioning anchor never blocks telemetry.
    expect(ds?.latestGpsDatetime).toEqual(new Date('2026-07-05T01:30:00.000Z'));
  });

  it('still fills on a LATER chunk once a corrected timestamp does arrive', async () => {
    const runId = await newRun();
    await service.ingestChunk(runId, [row(DEV_C, 6, 8)]);

    const ds = await state(DEV_C);
    expect(ds?.firstReportedAt).toEqual(trueUtc(6, 8));
    expect(ds?.firstReportedOffsetMin).toBe(0);
  });

  it('EXPECTED while #222 is open: first_reported_at reads LATER than latest_gps_datetime', async () => {
    // Do not "fix" this, and do not add a first_reported_at <= latest_gps_datetime CHECK — the two
    // columns are written at different offsets on purpose (0 vs +330), so the ordering is inverted by
    // exactly 5.5 h on any single-ping device. It self-heals the moment #222 sets the constant to 0.
    // This test is the tripwire: when it starts failing, #222 has landed and it should be DELETED.
    const runId = await newRun();
    await prisma.deviceState.deleteMany({ where: { deviceId: DEV_B } });
    await service.ingestChunk(runId, [row(DEV_B, 15, 12)]);

    const ds = await state(DEV_B);
    const skewMs = ds!.firstReportedAt!.getTime() - ds!.latestGpsDatetime!.getTime();
    expect(skewMs).toBe(330 * 60_000);
  });
});
