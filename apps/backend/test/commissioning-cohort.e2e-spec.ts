import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Commissioning cohort view — `GET /api/reports/commissioning/{cohort,installers}`.
 *
 * An INSTALL-QUALITY measure, not a fault queue: a device fitted three days ago that is already
 * reporting belongs in this view as a success. The denominator is the point, so every count here is
 * asserted against a fixture population of known size rather than a global total.
 *
 * Booted through the real `AppModule` for the reason #218 established — a hand-built harness leaves a
 * collaborator Nest cannot resolve `undefined` and the suite passes anyway. Same rule as
 * `device-commissioning.e2e-spec.ts`, which pins the write side of this table.
 *
 * What these tests pin, in order of what would hurt most if it broke:
 *  1. `online` is decided by `device_states.first_reported_at`, NOT by the column of the same name on
 *     `device_commissioning`. The appender snapshots that column at OBSERVATION time
 *     (`master-sync.service.ts:481`), so for a genuinely new fitment it is null and stays null —
 *     measured 0 of 24,294 rows populated on the dev mirror. A reader that required both to agree
 *     would count zero devices as commissioned, forever.
 *  2. A `first_reported_at` EARLIER than `installed_at` is not evidence of coming online. 2,138 rows
 *     on the dev mirror are in that state: the write-once COALESCE captured a pre-existing device's
 *     last-seen ping the first time the tick ran after the column shipped. Counting those as online
 *     would report a dead re-mapped device as a successful install.
 *  3. Silent inside the grace window is `pending`, not `failed`. 96.97% of genuine new installations
 *     report within 12-24h, so flagging the grace population as defective cries wolf on the majority.
 *  4. Time-to-first-report is only meaningful for fitments observed after `first_reported_at` began
 *     being written. Before that epoch the column holds a last-seen value, which yields a median of
 *     ~8,707 hours on real data. Those rows must be excluded from the TTFR sample, not averaged in.
 *  5. The window is a parameter with a HARD ceiling. Unbounded lookback is the one shape that changes
 *     the query plan at scale — measured 1,078 ms with a 9.5 MB on-disk merge sort at 10x, against
 *     ~10 ms for every bounded shape. The cap is what keeps that plan unreachable.
 *  6. Machine accounts are classified explicitly. A leaderboard that reports `INTEGRATION_SERVICE` is
 *     bad at installing things is worse than no leaderboard.
 */
describe('GET /api/reports/commissioning — cohort + install quality (real DI graph)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const NS = Date.now() % 100_000;
  /** Every relative fixture hangs off one captured instant, so the arithmetic below cannot drift mid-run. */
  const NOW = new Date();
  const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);

  /** Zone 1 is the seeded zone `zm.north@fsm.test` owns — the ZM-clamp assertions depend on that. */
  const ZONE_NORTH = 1n;
  let zoneOther: bigint;
  let companyId: bigint;
  let plantCohort: bigint; // the cohort arithmetic
  let plantClass: bigint; // installer classification
  let plantBurst: bigint; // the one-afternoon signature
  let plantEpoch: bigint; // pre-epoch TTFR exclusion
  let plantEmpty: bigint; // inert-on-empty
  let plantOut: bigint; // outside the ZM's zone
  let plantPop: bigint; // the #233 population split
  let plantDead: bigint; // deactivated under #119
  let deactivationId: bigint;

  const TECH = `ZZ_TECH_${NS}`;
  const BURST = `ZZ BURST ${NS}`;
  const PERSON = `ZZ PERSON ${NS}`;
  const UNDERSCORED = `ZZPLANT_SOMEONE${NS}`;
  const MACHINE = 'INTEGRATION_SERVICE';
  /** Owns only the #233 population fixtures, so its row isolates the split from every other assertion. */
  const POP = `ZZ_POP_${NS}`;

  const deviceIds: string[] = [];
  const plantIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    zoneOther = (await prisma.zone.create({ data: { name: `Z-comm-${NS}` } })).zoneId;
    companyId = (await prisma.company.create({
      data: { name: `Co-comm-${NS}`, companyTier: 'GOLD', companyPriorityRank: 'B' },
    })).companyId;

    const plant = async (label: string, zoneId: bigint): Promise<bigint> => {
      const { plantId } = await prisma.plant.create({ data: { name: `P-comm-${label}-${NS}`, zoneId } });
      plantIds.push(plantId);
      return plantId;
    };
    plantCohort = await plant('cohort', ZONE_NORTH);
    plantClass = await plant('class', ZONE_NORTH);
    plantBurst = await plant('burst', ZONE_NORTH);
    plantEpoch = await plant('epoch', ZONE_NORTH);
    plantEmpty = await plant('empty', ZONE_NORTH);
    plantOut = await plant('out', zoneOther);
    plantPop = await plant('pop', ZONE_NORTH);
    plantDead = await plant('dead', ZONE_NORTH);
    deactivationId = (await prisma.plantDeactivation.create({
      data: { plantId: plantDead, reason: `commissioning population fixture ${NS}` },
    })).id;

    // --- the cohort population on `plantCohort`: 5 fitments inside a 7-day window ------------------
    // A/B came online (TTFR 2h and 6h). C is silent inside the 48h grace. D is silent PAST it. E holds
    // a stale stamp that predates its own fitment — the trap from finding (2).
    await fitment({ suffix: 'A', plantId: plantCohort, installedAt: hoursAgo(6), firstReportedAt: hoursAgo(4), installedBy: TECH });
    await fitment({ suffix: 'B', plantId: plantCohort, installedAt: hoursAgo(12), firstReportedAt: hoursAgo(6), installedBy: TECH });
    await fitment({ suffix: 'C', plantId: plantCohort, installedAt: hoursAgo(10), firstReportedAt: null, installedBy: TECH });
    await fitment({ suffix: 'D', plantId: plantCohort, installedAt: hoursAgo(90), firstReportedAt: null, installedBy: TECH });
    await fitment({ suffix: 'E', plantId: plantCohort, installedAt: hoursAgo(30), firstReportedAt: hoursAgo(40), installedBy: TECH });

    // --- one fitment per installer shape, all inside the live window -------------------------------
    await fitment({ suffix: 'M', plantId: plantClass, installedAt: hoursAgo(5), firstReportedAt: null, installedBy: MACHINE });
    await fitment({ suffix: 'P', plantId: plantClass, installedAt: hoursAgo(5), firstReportedAt: hoursAgo(4), installedBy: PERSON });
    await fitment({ suffix: 'U', plantId: plantClass, installedAt: hoursAgo(5), firstReportedAt: null, installedBy: UNDERSCORED });
    await fitment({ suffix: 'N', plantId: plantClass, installedAt: hoursAgo(5), firstReportedAt: null, installedBy: null });

    // --- the PRATIK PAWAR signature: many installs, one calendar day, none online ------------------
    // Pinned to an absolute instant (not `hoursAgo`) so all three land on the same UTC date whatever
    // time of day the suite runs. 20 days back keeps it inside the 30-day default lookback.
    const burstDay = new Date(NOW.getTime() - 20 * 24 * 3_600_000);
    burstDay.setUTCHours(9, 0, 0, 0);
    for (const suffix of ['R1', 'R2', 'R3']) {
      await fitment({ suffix, plantId: plantBurst, installedAt: burstDay, firstReportedAt: null, installedBy: BURST });
    }

    // --- a fitment from before `first_reported_at` began being written ----------------------------
    // Reachable only at a long lookback. It counts as an install and as online, but its TTFR is a
    // measurement of the epoch, not of the install, so it must not enter the sample.
    await fitment({
      suffix: 'X',
      plantId: plantEpoch,
      installedAt: new Date('2026-01-01T09:00:00.000Z'),
      firstReportedAt: new Date('2026-01-02T09:00:00.000Z'),
      installedBy: TECH,
    });

    // --- outside the ZM's zone --------------------------------------------------------------------
    await fitment({ suffix: 'O', plantId: plantOut, installedAt: hoursAgo(6), firstReportedAt: hoursAgo(5), installedBy: TECH });

    // --- the #233 population split, all on `plantPop`/`plantDead` ---------------------------------
    // Four fitments, one per population state, deliberately given the SAME shape as each other —
    // silent and well past the 48h grace — so the ONLY thing that can move them between `failed` and
    // "not in the measure" is the population predicate itself. Before #233 all four counted as failed
    // installs; that is the 39.1%-vs-5.6% defect in miniature.
    await fitment({ suffix: 'W1', plantId: plantPop, installedAt: hoursAgo(90), firstReportedAt: null, installedBy: POP, departed: true });
    await fitment({ suffix: 'W2', plantId: plantPop, installedAt: hoursAgo(90), firstReportedAt: null, installedBy: POP, departed: true });
    await fitment({ suffix: 'G1', plantId: plantPop, installedAt: hoursAgo(90), firstReportedAt: null, installedBy: POP });
    await fitment({ suffix: 'K1', plantId: plantDead, installedAt: hoursAgo(90), firstReportedAt: null, installedBy: POP });
    // No `device_states` row at all — a fitment that outlived its mirror row (#227). The table carries
    // no FKs precisely so this is representable, and it is NOT the same claim as "departed".
    await fitment({ suffix: 'M1', plantId: plantPop, installedAt: hoursAgo(90), firstReportedAt: null, installedBy: POP, unmirrored: true });
  });

  async function fitment(spec: {
    suffix: string;
    plantId: bigint;
    installedAt: Date;
    firstReportedAt: Date | null;
    installedBy: string | null;
    /** #233: returned to a warehouse — silent by circumstance, not by fault. */
    departed?: boolean;
    /** #233: no `device_states` row is written at all — the fitment outlived the mirror (#227). */
    unmirrored?: boolean;
  }): Promise<void> {
    const deviceId = `ZZC${NS}${spec.suffix}`;
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    if (!spec.unmirrored) {
      await prisma.deviceState.create({
        data: {
          deviceId,
          plantId: spec.plantId,
          companyId,
          isDeparted: spec.departed ?? false,
          firstReportedAt: spec.firstReportedAt,
          firstReportedOffsetMin: spec.firstReportedAt ? 0 : null,
          computedAt: NOW,
        },
      });
    }
    await prisma.deviceCommissioning.create({
      data: {
        deviceId,
        installedAt: spec.installedAt,
        installedAtOffsetMin: 0,
        installedBy: spec.installedBy,
        installationRemark: 'New Installation',
        plantId: spec.plantId,
        companyId,
        // Deliberately null — mirroring what the appender actually writes for a new fitment. If the
        // reader depended on this column the whole view would be empty in production.
        firstReportedAt: null,
        observedAt: NOW,
      },
    });
  }

  afterAll(async () => {
    await prisma.deviceCommissioning.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plantDeactivation.deleteMany({ where: { id: deactivationId } });
    await prisma.plant.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: zoneOther } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  const cohort = async (token: string, query: Record<string, string | number>, expected = 200) =>
    request(app.getHttpServer())
      .get('/api/reports/commissioning/cohort')
      .query(query)
      .set('Authorization', `Bearer ${token}`)
      .expect(expected);

  const installers = async (token: string, query: Record<string, string | number>, expected = 200) =>
    request(app.getHttpServer())
      .get('/api/reports/commissioning/installers')
      .query(query)
      .set('Authorization', `Bearer ${token}`)
      .expect(expected);

  // ---------------------------------------------------------------------------------------------
  // 1. The cohort arithmetic
  // ---------------------------------------------------------------------------------------------
  describe('live cohort', () => {
    it('splits the window into online / pending / failed against a known denominator', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 7, graceHours: 48, plantId: String(plantCohort) });

      expect(res.body.cohortDays).toBe(7);
      expect(res.body.graceHours).toBe(48);
      expect(res.body.totals).toMatchObject({
        fitments: 5, // the denominator is the point
        online: 2, // A + B
        pending: 2, // C (10h) and E (30h) — both still inside the 48h grace
        failed: 1, // D — silent 90h after fitment
      });
    });

    it('reports time-to-first-report only for the devices that actually reported', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 7, graceHours: 48, plantId: String(plantCohort) });

      // A took 2h, B took 6h. The three silent/stale devices contribute nothing — not a zero.
      expect(res.body.totals.ttfr.sampleSize).toBe(2);
      expect(res.body.totals.ttfr.medianHours).toBeCloseTo(4, 1);
      expect(res.body.totals.ttfr.p95Hours).toBeCloseTo(5.8, 1);
    });

    it('does not count a first_reported_at that predates the fitment as coming online', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 7, graceHours: 48, plantId: String(plantCohort) });

      // Device E carries a stamp 40h ago against a fitment 30h ago. That is the stale last-seen value
      // the write-once COALESCE captured, not evidence of commissioning.
      expect(res.body.totals.online).toBe(2);
      expect(res.body.totals.ttfr.sampleSize).toBe(2);
    });

    it('ignores device_commissioning.first_reported_at, which is null for every real fitment', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 7, graceHours: 48, plantId: String(plantCohort) });

      // Every fixture row has a null `device_commissioning.first_reported_at`, exactly as the appender
      // writes it. A reader requiring both columns to agree would report 0 online here.
      const rows = await prisma.deviceCommissioning.findMany({
        where: { deviceId: { in: deviceIds } },
        select: { firstReportedAt: true },
      });
      expect(rows.every((r) => r.firstReportedAt === null)).toBe(true);
      expect(res.body.totals.online).toBe(2);
    });

    it('moves a device from pending to failed when the grace window is tightened', async () => {
      const token = await login('ops.head@fsm.test');
      // At a 24h grace, E (silent 30h) crosses the line; C (silent 10h) does not.
      const res = await cohort(token, { cohortDays: 7, graceHours: 24, plantId: String(plantCohort) });

      expect(res.body.totals).toMatchObject({ fitments: 5, online: 2, pending: 1, failed: 2 });
    });

    it('shrinks the denominator with the cohort window, not just the numerator', async () => {
      const token = await login('ops.head@fsm.test');
      // A 1-day cohort drops D (90h) and E (30h) out of the population entirely.
      const res = await cohort(token, { cohortDays: 1, graceHours: 48, plantId: String(plantCohort) });

      expect(res.body.totals).toMatchObject({ fitments: 3, online: 2, pending: 1, failed: 0 });
    });

    it('breaks the cohort down per plant', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 7, graceHours: 48 });

      const row = res.body.byPlant.find((r: { plantId: string }) => r.plantId === String(plantCohort));
      expect(row).toMatchObject({ fitments: 5, online: 2, pending: 2, failed: 1, zoneId: String(ZONE_NORTH) });
      expect(row.plantName).toBe(`P-comm-cohort-${NS}`);
    });

    it('breaks the cohort down per installer', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 7, graceHours: 48, plantId: String(plantCohort) });

      const row = res.body.byInstaller.find((r: { installerKey: string }) => r.installerKey === TECH);
      expect(row).toMatchObject({ fitments: 5, online: 2, pending: 2, failed: 1 });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 2. Inert on an empty population
  // ---------------------------------------------------------------------------------------------
  describe('empty state', () => {
    it('returns a zero cohort with null medians, not zero medians', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 7, graceHours: 48, plantId: String(plantEmpty) });

      expect(res.body.totals).toMatchObject({ fitments: 0, online: 0, pending: 0, failed: 0 });
      // A zero median would read as "commissioned instantly". Absence of measurement is null.
      expect(res.body.totals.ttfr.sampleSize).toBe(0);
      expect(res.body.totals.ttfr.medianHours).toBeNull();
      expect(res.body.totals.ttfr.p95Hours).toBeNull();
      expect(res.body.byPlant).toEqual([]);
      expect(res.body.byInstaller).toEqual([]);
    });

    it('returns an empty installer list rather than an error', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await installers(token, { lookbackDays: 30, plantId: String(plantEmpty) });
      expect(res.body.rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 3. Install quality
  // ---------------------------------------------------------------------------------------------
  describe('installer quality', () => {
    it('rates an installer by never-online count, counting a stale stamp as never online', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await installers(token, { lookbackDays: 30, plantId: String(plantCohort) });

      const row = res.body.rows.find((r: { installerKey: string }) => r.installerKey === TECH);
      // C and D never reported; E's stamp predates its fitment. Never-online is the exact complement
      // of online — the two endpoints must not disagree about what commissioned means.
      expect(row).toMatchObject({ installs: 5, neverOnline: 3, distinctPlants: 1 });
      expect(row.neverOnlineRate).toBeCloseTo(0.6, 3);
    });

    it('surfaces the one-afternoon signature without a special case', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await installers(token, { lookbackDays: 30, plantId: String(plantBurst) });

      const row = res.body.rows.find((r: { installerKey: string }) => r.installerKey === BURST);
      // 3 installs, 1 calendar day, none online — the shape of the PRATIK PAWAR finding as a sortable
      // column rather than a hardcoded name.
      expect(row).toMatchObject({ installs: 3, neverOnline: 3, distinctInstallDays: 1, distinctPlants: 1 });
      expect(row.neverOnlineRate).toBeCloseTo(1, 3);
      expect(row.firstInstallAt).toBe(row.lastInstallAt);
    });

    it('excludes pre-epoch fitments from the TTFR sample while still counting the install', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await installers(token, { lookbackDays: 365, plantId: String(plantEpoch) });

      const row = res.body.rows.find((r: { installerKey: string }) => r.installerKey === TECH);
      // Device X reported a day after its January fitment, but `first_reported_at` was not being
      // written then — the stamp measures the epoch, not the install. Counted as an install and as
      // online; excluded from the timing sample, which is therefore empty rather than 24 hours.
      expect(row).toMatchObject({ installs: 1, neverOnline: 0 });
      expect(row.ttfr.sampleSize).toBe(0);
      expect(row.ttfr.medianHours).toBeNull();
    });

    it('sorts by failure rate when asked', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await installers(token, { lookbackDays: 30, sort: 'neverOnlineRate', minInstalls: 3 });

      const rates = res.body.rows.map((r: { neverOnlineRate: number }) => r.neverOnlineRate);
      expect(rates).toEqual([...rates].sort((a: number, b: number) => b - a));
      expect(res.body.rows.every((r: { installs: number }) => r.installs >= 3)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 4. Person vs machine — explicit, not an inline regex
  // ---------------------------------------------------------------------------------------------
  describe('installer classification', () => {
    it('separates service accounts, people, and the unclassifiable', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await installers(token, { lookbackDays: 30, plantId: String(plantClass) });

      const kind = (key: string | null): string =>
        res.body.rows.find((r: { installerKey: string | null }) => r.installerKey === key)?.installerKind;

      expect(kind(MACHINE)).toBe('SERVICE_ACCOUNT');
      expect(kind(PERSON)).toBe('PERSON');
      // Underscore-form logins mix plant-prefixed people with depot accounts and cannot be told apart
      // from the data — 17,712 of 24,294 rows are in this shape. Labelled, never silently merged.
      expect(kind(UNDERSCORED)).toBe('UNCLASSIFIED');
      expect(kind(null)).toBe('UNATTRIBUTED');
    });

    it('keeps unattributed installs in the denominator', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await installers(token, { lookbackDays: 30, plantId: String(plantClass) });

      // 27.1% of real rows have no installer. Dropping them would flatter the fleet-wide rate.
      const total = res.body.rows.reduce((n: number, r: { installs: number }) => n + r.installs, 0);
      expect(total).toBe(4);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5. The window ceiling — the one shape that changes the query plan at scale
  // ---------------------------------------------------------------------------------------------
  describe('parameter bounds', () => {
    it('accepts the documented defaults when no window is given', async () => {
      const token = await login('ops.head@fsm.test');
      const live = await cohort(token, { plantId: String(plantCohort) });
      expect(live.body.cohortDays).toBe(7);
      expect(live.body.graceHours).toBe(48);

      const quality = await installers(token, { plantId: String(plantCohort) });
      expect(quality.body.lookbackDays).toBe(30);
    });

    it('accepts the boundary values', async () => {
      const token = await login('ops.head@fsm.test');
      await cohort(token, { cohortDays: 90, graceHours: 720, plantId: String(plantEmpty) });
      await installers(token, { lookbackDays: 365, plantId: String(plantEmpty) });
    });

    it('rejects a cohort window past 90 days', async () => {
      const token = await login('ops.head@fsm.test');
      await cohort(token, { cohortDays: 91 }, 400);
    });

    it('rejects a lookback past 365 days', async () => {
      const token = await login('ops.head@fsm.test');
      await installers(token, { lookbackDays: 366 }, 400);
    });

    it('rejects zero, negative, and non-numeric windows', async () => {
      const token = await login('ops.head@fsm.test');
      await cohort(token, { cohortDays: 0 }, 400);
      await cohort(token, { cohortDays: -1 }, 400);
      await cohort(token, { cohortDays: 'all' }, 400);
      await cohort(token, { graceHours: 0 }, 400);
      await cohort(token, { graceHours: 721 }, 400);
      await installers(token, { lookbackDays: 0 }, 400);
      await installers(token, { lookbackDays: 'forever' }, 400);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 6. Access
  // ---------------------------------------------------------------------------------------------
  describe('access', () => {
    it('serves the Operations Head and the CSM unscoped', async () => {
      for (const email of ['ops.head@fsm.test', 'csm@fsm.test']) {
        const token = await login(email);
        const res = await cohort(token, { cohortDays: 7 });
        expect(res.body.scopedToZoneId).toBeNull();
      }
    });

    it('clamps a Zonal Manager to their own zone and says so in the payload', async () => {
      const token = await login('zm.north@fsm.test');
      const res = await cohort(token, { cohortDays: 7 });

      // The UI renders a "filtered to your zone" caveat off this field — an installer working three
      // zones otherwise shows a partial denominator with nothing marking it as partial.
      expect(res.body.scopedToZoneId).toBe(String(ZONE_NORTH));
      const plants = res.body.byPlant.map((r: { plantId: string }) => r.plantId);
      expect(plants).toContain(String(plantCohort));
      expect(plants).not.toContain(String(plantOut));
    });

    it('clamps the installer view for a Zonal Manager too', async () => {
      const token = await login('zm.north@fsm.test');
      const res = await installers(token, { lookbackDays: 30 });

      expect(res.body.scopedToZoneId).toBe(String(ZONE_NORTH));
      const row = res.body.rows.find((r: { installerKey: string }) => r.installerKey === TECH);
      // The out-of-zone fitment must not reach this row's counts.
      expect(row.distinctPlants).toBe(1);
    });

    it('rejects a ZM targeting another zone', async () => {
      const token = await login('zm.north@fsm.test');
      await cohort(token, { cohortDays: 7, zoneId: String(zoneOther) }, 403);
    });

    it('forbids a Service Engineer and a Warehouse Manager', async () => {
      for (const email of ['se.north@fsm.test', 'wm@fsm.test']) {
        const token = await login(email);
        await cohort(token, { cohortDays: 7 }, 403);
        await installers(token, { lookbackDays: 30 }, 403);
      }
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer()).get('/api/reports/commissioning/cohort').expect(401);
      await request(app.getHttpServer()).get('/api/reports/commissioning/installers').expect(401);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5. The population predicate (#233)
  //
  // The defect this closes, in one sentence: the cohort had no operational-fleet predicate, so a
  // device returned to a warehouse was counted as a FAILED INSTALL. Measured live on `fsm` over 90
  // days before the fix — 6,832 fitments / 2,668 failed (39.1%); after — 2,645 / 147 (5.6%), because
  // 4,127 of the 6,405 cohort devices were departed.
  //
  // The `POP` installer owns five fitments of deliberately IDENTICAL shape (silent, 90h old, well past
  // the grace window). They differ in exactly one way — which population they belong to — so anything
  // that moves between the two runs below is the predicate and nothing else.
  //   W1, W2  warehouse (is_departed = true)
  //   G1      operational
  //   K1      on a plant deactivated under #119
  //   M1      no device_states row at all (#227)
  // ---------------------------------------------------------------------------------------------
  describe('population', () => {
    const popRow = (body: { byInstaller: { installerKey: string }[] }) =>
      body.byInstaller.find((r) => r.installerKey === POP) as
        | { fitments: number; online: number; pending: number; failed: number }
        | undefined;

    it('defaults to the operational fleet: a warehoused device is not a failed install (AC-1)', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 7 });

      // Only G1 survives. W1/W2 are in a box, K1's plant is deactivated, M1 has no mirror row —
      // none of them is evidence that an install failed.
      expect(popRow(res.body)).toMatchObject({ fitments: 1, online: 0, pending: 0, failed: 1 });
    });

    it('population=all reproduces the pre-#233 numbers exactly (AC-2)', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 7, population: 'all' });

      // All five, and every one of them graded `failed` — which is precisely what the old query did
      // to 2,668 fitments on live data.
      expect(popRow(res.body)).toMatchObject({ fitments: 5, online: 0, pending: 0, failed: 5 });
    });

    it('reports the census, and its parts sum to the window exactly (AC-3, AC-4)', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 7 });
      const c = res.body.population;

      // The identity — the whole reason `deactivatedPlant` is a remainder rather than its own FILTER.
      expect(c.operational + c.warehouse + c.deactivatedPlant + c.unmirrored).toBe(c.fitmentsInWindow);
      // And each drop is named rather than merely absent. Fixture-relative (`toBeGreaterThanOrEqual`)
      // because #156's leaked fixtures mean this database is never empty of other people's rows.
      expect(c.warehouse).toBeGreaterThanOrEqual(2);
      expect(c.deactivatedPlant).toBeGreaterThanOrEqual(1);
      expect(c.unmirrored).toBeGreaterThanOrEqual(1);
    });

    it('the census does NOT move with the population filter — it describes the window, not the measure', async () => {
      const token = await login('ops.head@fsm.test');
      const operational = await cohort(token, { cohortDays: 7 });
      const all = await cohort(token, { cohortDays: 7, population: 'all' });

      // If the census were population-filtered it could never name what the filter removed, which is
      // the one job it has.
      expect(all.body.population).toEqual(operational.body.population);
      // The selected part, by contrast, must equal the census entry it selects.
      expect(operational.body.totals.fitments).toBe(operational.body.population.operational);
      expect(all.body.totals.fitments).toBe(all.body.population.fitmentsInWindow);
    });

    it('drops a group whose every fitment fell outside the population, rather than showing zeroes', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 7 });

      // `plantDead` contributes only K1, which the operational predicate removes. A row of zeroes
      // would read as "this plant fitted nothing", which is a different and false claim.
      const dead = res.body.byPlant.find((r: { plantId: string }) => r.plantId === String(plantDead));
      expect(dead).toBeUndefined();
      const all = await cohort(token, { cohortDays: 7, population: 'all' });
      expect(all.body.byPlant.find((r: { plantId: string }) => r.plantId === String(plantDead))).toBeDefined();
    });

    it('applies the same predicate to install quality, and echoes it in filters', async () => {
      const token = await login('ops.head@fsm.test');
      const operational = await installers(token, { lookbackDays: 30 });
      const all = await installers(token, { lookbackDays: 30, population: 'all' });

      const find = (body: { rows: { installerKey: string }[] }) => body.rows.find((r) => r.installerKey === POP) as
        | { installs: number; neverOnline: number; neverOnlineRate: number; distinctPlants: number }
        | undefined;

      expect(find(operational.body)).toMatchObject({ installs: 1, neverOnline: 1, neverOnlineRate: 1 });
      // Two plants only under `all`: plantDead's fitment is excluded from the operational view, so a
      // count(DISTINCT) that ignored the filter would leak it back in.
      expect(find(operational.body)!.distinctPlants).toBe(1);
      expect(find(all.body)).toMatchObject({ installs: 5, neverOnline: 5, distinctPlants: 2 });

      expect(operational.body.filters.population).toBe('operational');
      expect(all.body.filters.population).toBe('all');
    });

    it('scopes the resolution curve to the population too', async () => {
      const token = await login('ops.head@fsm.test');
      const operational = await cohort(token, { cohortDays: 7 });
      const all = await cohort(token, { cohortDays: 7, population: 'all' });

      // W1/W2/K1/M1 are all matured (90h) and silent, so under `all` they land in the curve's
      // never-online count. If the curve read a different population than the counts beside it, the
      // page would show a cohort of 2,623 next to a curve drawn over 6,810.
      expect(all.body.resolution.neverOnline).toBeGreaterThan(operational.body.resolution.neverOnline);
      expect(all.body.resolution.maturedFitments).toBeGreaterThan(operational.body.resolution.maturedFitments);
    });

    it('rejects an unknown population rather than silently falling back', async () => {
      const token = await login('ops.head@fsm.test');
      // Silently defaulting would answer a question the caller did not ask — the same failure the ZM
      // clamp rejects rather than overrides.
      await cohort(token, { cohortDays: 7, population: 'everything' }, 400);
      await installers(token, { lookbackDays: 30, population: 'everything' }, 400);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 6. The resolution curve, over HTTP (#234)
  //
  // The ARITHMETIC lives in `commissioning-units.spec.ts` and is pinned there directly, because
  // reaching it from here would need fixtures that are simultaneously matured (older than
  // RESOLUTION_MATURITY_HOURS) and post-epoch (younger than COMMISSIONING_TTFR_EPOCH) — a window whose
  // width is a function of today's date. A test like that passes this week and silently stops
  // exercising its branches later.
  //
  // What is asserted here is the WIRING: that the curve is served, that it is computed over the same
  // population and the same `commissioned` expression as the counts beside it, and that the two
  // identities hold on real rows rather than on a hand-built object.
  // ---------------------------------------------------------------------------------------------
  describe('resolution curve', () => {
    it('serves the curve with the configured bands', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 7 });

      expect(res.body.resolution.buckets.map((b: { upToHours: number }) => b.upToHours)).toEqual([4, 12, 24, 48, 72]);
      expect(res.body.resolution.maturityHours).toBe(72);
    });

    it('partitions the matured population, and never claims more than the cohort holds', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 7 });
      const r = res.body.resolution;

      // All three identities, on live rows. The last is what stops an immature fitment being counted
      // as a failure to report within 72h when it has not had 72 hours.
      expect(r.sampleSize + r.neverOnline).toBe(r.curveFitments);
      expect(r.curveFitments + r.preEpochExcluded).toBe(r.maturedFitments);
      expect(r.maturedFitments).toBeLessThanOrEqual(res.body.totals.fitments);
    });

    it('excludes an immature fitment from the curve while still counting it in the cohort', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 7, plantId: String(plantCohort) });

      // plantCohort holds 5 fitments; only D (90h) is matured. A/B/C/E are 6-30h old and belong in the
      // cohort — they are real fitments — but cannot yet be graded against a 72h curve.
      expect(res.body.totals.fitments).toBe(5);
      expect(res.body.resolution.maturedFitments).toBe(1);
      // And D is silent, so the curve is a measured 0%, not a null one.
      expect(res.body.resolution.neverOnline).toBe(1);
      expect(res.body.resolution.buckets.every((b: { cumulativeOnlinePct: number }) => b.cumulativeOnlinePct === 0)).toBe(true);
    });

    it('never samples more than the cohort measured, because the curve is a subset of it', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await cohort(token, { cohortDays: 90 });

      // Both read `ttfr_hours`; the curve additionally requires maturity. If this ever inverted, the
      // curve would be drawing on rows the median beside it never saw.
      expect(res.body.resolution.sampleSize).toBeLessThanOrEqual(res.body.totals.ttfr.sampleSize);
    });

    // NOT tested here: a pre-epoch fitment landing in `onlineUnmeasured` with a wholly null curve.
    // It is unreachable from THIS endpoint by construction and increasingly so — `COHORT_DAYS.max` is
    // 90 and `DEFAULT_TTFR_EPOCH` is fixed, so once the epoch is more than 90 days old no cohort
    // window can contain a pre-epoch fitment and `onlineUnmeasured` is permanently 0 here. That is
    // desirable (the epoch contamination ages out on its own) but it makes any fixture for it a test
    // with a fuse. The branch is pinned deterministically in `commissioning-units.spec.ts` instead —
    // "returns NULL percentages when nothing was measured" is exactly this shape.
  });
});
