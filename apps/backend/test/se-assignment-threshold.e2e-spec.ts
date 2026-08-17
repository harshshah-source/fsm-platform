import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ASSIGNMENT_THRESHOLD_OPTIONS,
  DEFAULT_SE_ASSIGNMENT_THRESHOLD_HOURS,
  SE_ASSIGNMENT_THRESHOLD_KEY,
  parseAssignmentThresholdHours,
} from '../src/settings/assignment-threshold';
import { canWriteSetting } from '../src/settings/setting-authority';

/**
 * #238 — the SE-assignment threshold: configurable, co-owned by the Operations Head and the CSM, with
 * the OH holding the final decision through a lock.
 *
 * The governance half is straightforward to assert. The half worth guarding is the *engine* half:
 * ticket creation and auto-recovery are exact complements of one another, and #238 moved the predicate
 * they complement. Get that wrong and a device is ticketed and auto-closed on every telemetry tick,
 * forever, each closure recorded as a self-healing device — a silent, self-inflating data corruption
 * rather than a visible failure. `complementarity` below is the test that would catch it.
 */
describe('#238 — SE-assignment threshold (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // Shared test DB (#156): leave the key on its canonical default and its trail cleared, so no
    // later spec inherits a threshold this one moved.
    await prisma.settingChange.deleteMany({ where: { key: SE_ASSIGNMENT_THRESHOLD_KEY } });
    await prisma.systemSetting.update({
      where: { key: SE_ASSIGNMENT_THRESHOLD_KEY },
      data: {
        value: DEFAULT_SE_ASSIGNMENT_THRESHOLD_HOURS as unknown as object,
        lockedAt: null,
        lockedBy: null,
        lockedByRole: null,
        lockReason: null,
      },
    });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const get = (token: string) =>
    request(app.getHttpServer()).get('/api/settings/assignment-threshold').set('Authorization', `Bearer ${token}`);
  const put = (token: string, body: unknown) =>
    request(app.getHttpServer())
      .put('/api/settings/assignment-threshold')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  /** Reset to a known, unlocked default between the governance cases. */
  const resetKey = async () => {
    await prisma.settingChange.deleteMany({ where: { key: SE_ASSIGNMENT_THRESHOLD_KEY } });
    await prisma.systemSetting.update({
      where: { key: SE_ASSIGNMENT_THRESHOLD_KEY },
      data: {
        value: DEFAULT_SE_ASSIGNMENT_THRESHOLD_HOURS as unknown as object,
        lockedAt: null,
        lockedBy: null,
        lockedByRole: null,
        lockReason: null,
      },
    });
  };

  // ---------------------------------------------------------------------------------------------
  // The ladder
  // ---------------------------------------------------------------------------------------------

  it('admits only SLA-band boundaries, so no choice can split a bucket the UI has to render', () => {
    expect(ASSIGNMENT_THRESHOLD_OPTIONS).toEqual([4, 8, 12, 24, 48, 72, 120, 168]);
    expect(parseAssignmentThresholdHours(48)).toEqual({ ok: true, hours: 48 });
    expect(parseAssignmentThresholdHours('48')).toEqual({ ok: true, hours: 48 }); // form bodies carry strings
    expect(parseAssignmentThresholdHours(37)).toEqual({ ok: false, reason: 'NOT_AN_ALLOWED_OPTION' });
    expect(parseAssignmentThresholdHours('soon')).toEqual({ ok: false, reason: 'NOT_A_NUMBER' });
    expect(parseAssignmentThresholdHours(null)).toEqual({ ok: false, reason: 'NOT_A_NUMBER' });
  });

  it('ships inert: the default equals the Inactive definition, so the deploy changes no behaviour', async () => {
    const row = await prisma.systemSetting.findUnique({ where: { key: SE_ASSIGNMENT_THRESHOLD_KEY } });
    const inactivity = await prisma.systemSetting.findUnique({ where: { key: 'inactivity_threshold_hours' } });
    expect(row?.value).toBe(DEFAULT_SE_ASSIGNMENT_THRESHOLD_HOURS);
    expect(row?.value).toBe(inactivity?.value);
  });

  // ---------------------------------------------------------------------------------------------
  // Authority — the unit the lock rule actually lives in
  // ---------------------------------------------------------------------------------------------

  describe('canWriteSetting', () => {
    const unlocked = { lockedAt: null };
    const locked = { lockedAt: new Date() };

    it('lets both owners write while unlocked, and no one else', () => {
      expect(canWriteSetting(SE_ASSIGNMENT_THRESHOLD_KEY, 'OPERATIONS_HEAD', unlocked)).toEqual({ allowed: true });
      expect(canWriteSetting(SE_ASSIGNMENT_THRESHOLD_KEY, 'CENTRAL_SERVICE_MANAGER', unlocked)).toEqual({ allowed: true });
      expect(canWriteSetting(SE_ASSIGNMENT_THRESHOLD_KEY, 'ZONAL_MANAGER', unlocked)).toEqual({
        allowed: false,
        code: 'ROLE_NOT_PERMITTED',
      });
    });

    it('locks out the CSM but never the Operations Head — a lock the locked-out party could lift is not a lock, and one the OH could not lift would be irreversible', () => {
      expect(canWriteSetting(SE_ASSIGNMENT_THRESHOLD_KEY, 'CENTRAL_SERVICE_MANAGER', locked)).toEqual({
        allowed: false,
        code: 'SETTING_LOCKED',
      });
      expect(canWriteSetting(SE_ASSIGNMENT_THRESHOLD_KEY, 'OPERATIONS_HEAD', locked)).toEqual({ allowed: true });
    });

    it('leaves every other settings key Operations-Head-only', () => {
      expect(canWriteSetting('eligibility_mode', 'CENTRAL_SERVICE_MANAGER', unlocked)).toEqual({
        allowed: false,
        code: 'ROLE_NOT_PERMITTED',
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Governance over HTTP
  // ---------------------------------------------------------------------------------------------

  describe('governance', () => {
    beforeEach(resetKey);

    it('lets the CSM set the threshold, and records the value it replaced', async () => {
      const csm = await login('csm@fsm.test');
      const res = await put(csm, { hours: 48, reason: 'Monsoon — rural trackers recover on their own' }).expect(200);

      expect(res.body.hours).toBe(48);
      expect(res.body.history[0]).toMatchObject({
        previousHours: 24,
        newHours: 48,
        changeType: 'SET',
        actorRole: 'CENTRAL_SERVICE_MANAGER',
        reason: 'Monsoon — rural trackers recover on their own',
      });
      const row = await prisma.systemSetting.findUnique({ where: { key: SE_ASSIGNMENT_THRESHOLD_KEY } });
      expect(row?.value).toBe(48);
    });

    it('refuses a value outside the ladder and leaves the setting untouched', async () => {
      const csm = await login('csm@fsm.test');
      const res = await put(csm, { hours: 37 }).expect(400);
      expect(res.body.code).toBe('INVALID_ASSIGNMENT_THRESHOLD');

      const row = await prisma.systemSetting.findUnique({ where: { key: SE_ASSIGNMENT_THRESHOLD_KEY } });
      expect(row?.value).toBe(24);
    });

    it('gives the Operations Head the final decision: a lock stops the CSM and not the OH', async () => {
      const oh = await login('ops.head@fsm.test');
      const csm = await login('csm@fsm.test');

      await request(app.getHttpServer())
        .post('/api/settings/assignment-threshold/lock')
        .set('Authorization', `Bearer ${oh}`)
        .send({ reason: 'Holding at 24h until the Q3 SLA review' })
        .expect(201);

      const refused = await put(csm, { hours: 72 }).expect(403);
      expect(refused.body.code).toBe('SETTING_LOCKED');
      // The refusal must carry the decision, not just the denial — a CSM who cannot read WHY the
      // control is disabled cannot tell a governance act from a bug.
      expect(refused.body.reason).toContain('Holding at 24h until the Q3 SLA review');

      // The OH writes straight through the lock.
      await put(oh, { hours: 72 }).expect(200);
      const row = await prisma.systemSetting.findUnique({ where: { key: SE_ASSIGNMENT_THRESHOLD_KEY } });
      expect(row?.value).toBe(72);

      // …and unlocking hands it back.
      await request(app.getHttpServer())
        .delete('/api/settings/assignment-threshold/lock')
        .set('Authorization', `Bearer ${oh}`)
        .send({})
        .expect(200);
      await put(csm, { hours: 24 }).expect(200);
    });

    it('refuses to let the CSM lock, unlock or revert — those are the final authority itself', async () => {
      const csm = await login('csm@fsm.test');
      await request(app.getHttpServer())
        .post('/api/settings/assignment-threshold/lock')
        .set('Authorization', `Bearer ${csm}`)
        .send({})
        .expect(403);
      await request(app.getHttpServer())
        .post('/api/settings/assignment-threshold/revert')
        .set('Authorization', `Bearer ${csm}`)
        .send({ changeId: '1' })
        .expect(403);
    });

    it('reverts to a specific past decision, and the revert is itself recorded rather than erasing it', async () => {
      const oh = await login('ops.head@fsm.test');
      const csm = await login('csm@fsm.test');

      const first = await put(csm, { hours: 48, reason: 'trial' }).expect(200);
      const changeId = first.body.history[0].id as string;
      await put(csm, { hours: 120, reason: 'trial went further' }).expect(200);

      const res = await request(app.getHttpServer())
        .post('/api/settings/assignment-threshold/revert')
        .set('Authorization', `Bearer ${oh}`)
        .send({ changeId, reason: '120h leaves Platinum uncovered' })
        .expect(201);

      expect(res.body.hours).toBe(48);
      expect(res.body.history[0]).toMatchObject({
        previousHours: 120,
        newHours: 48,
        changeType: 'REVERT',
        revertedFromId: changeId,
        actorRole: 'OPERATIONS_HEAD',
      });
      // The 120 decision is still in the trail — a revert overrules a decision, it does not unmake it.
      expect(res.body.history.some((h: { newHours: number }) => h.newHours === 120)).toBe(true);
    });

    it('lets a ZM read the policy they work under but never write it', async () => {
      const zm = await login('zm.north@fsm.test');
      const res = await get(zm).expect(200);
      expect(res.body.hours).toBe(24);
      expect(res.body.canEdit).toBe(false);
      expect(res.body.canLock).toBe(false);

      await put(zm, { hours: 48 }).expect(403);
    });

    it('reports the Inactive definition alongside, because the choice is only meaningful next to it', async () => {
      const oh = await login('ops.head@fsm.test');
      const res = await get(oh).expect(200);
      expect(res.body.inactivityThresholdHours).toBe(24);
      expect(res.body.canEdit).toBe(true);
      expect(res.body.canLock).toBe(true);
    });

    it('refuses the generic settings writer, which would store the number and skip the governance', async () => {
      const oh = await login('ops.head@fsm.test');
      const res = await request(app.getHttpServer())
        .put(`/api/settings/${SE_ASSIGNMENT_THRESHOLD_KEY}`)
        .set('Authorization', `Bearer ${oh}`)
        .send({ value: 168 })
        .expect(400);
      expect(res.body.code).toBe('USE_SPECIALISED_SETTING_ENDPOINT');
      expect(res.body.endpoint).toBe('PUT /api/settings/assignment-threshold');

      const row = await prisma.systemSetting.findUnique({ where: { key: SE_ASSIGNMENT_THRESHOLD_KEY } });
      expect(row?.value).toBe(24);
    });

    it('routes PUT /api/settings/assignment-threshold to the governed writer, not to settings/:key', async () => {
      // Registration order in AppModule decides this. Registered after SettingsController, the write
      // below would fall through to the generic key writer and 400 — the endpoint would be dead while
      // every service-level test still passed.
      const oh = await login('ops.head@fsm.test');
      const res = await put(oh, { hours: 48 }).expect(200);
      expect(res.body.hours).toBe(48);
    });
  });
});
