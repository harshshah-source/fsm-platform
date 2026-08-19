import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { writeRolesFor } from '../src/settings/setting-authority';
import {
  DEFAULT_SPECIAL_ATTEMPT_THRESHOLD,
  SPECIAL_ATTEMPT_THRESHOLD_KEY,
  SPECIAL_ATTEMPT_THRESHOLD_OPTIONS,
  coerceStoredSpecialThreshold,
  parseSpecialAttemptThreshold,
  readSpecialAttemptThreshold,
} from '../src/settings/special-threshold';

/**
 * #244 AC-3 — the Special threshold: how many unsuccessful *reached* attempts make a ticket Special.
 *
 * The ladder starts at **2**, and the floor is the whole point. 1 is technically expressible and
 * operationally destructive: every ticket that has ever been dispatched, reached and expired once
 * would become Special simultaneously — the entire backlog flagged in a single evaluation, which is
 * indistinguishable from the flag meaning nothing. 0 is worse still (a ticket nobody has visited is
 * Special). Neither is a value an operator could recover from by re-reading a number, because the
 * derivation is retroactive: the queue reclassifies the moment the key moves. So the parser refuses
 * them, and refuses them *with the allowed list*, because a bare "invalid" leaves the operator
 * guessing at a bound nothing on the page states.
 *
 * The write path is the generic `PUT /api/settings/:key`, per the approved decision: authority is the
 * registry default (Operations Head), with **no invented co-ownership** — unlike #238's threshold,
 * which the CSM co-owns because they feel dispatch volume first. Nobody "feels" a classification
 * threshold day to day, so there is nothing to delegate. What the generic path lacked was validation,
 * which is why the key registers a validator rather than a whole second governance service: storing
 * an out-of-ladder number and then silently falling back to the default at read time would leave the
 * settings page showing 1 while the engine used 3.
 */
describe('#244 — Special-ticket attempt threshold (e2e)', () => {
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
    // Shared test DB (#156): leave the key on its canonical default so no later spec inherits a
    // threshold this one moved.
    await resetKey();
    await app.close();
  });

  const resetKey = async () => {
    await prisma.systemSetting.update({
      where: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY },
      data: { value: DEFAULT_SPECIAL_ATTEMPT_THRESHOLD as unknown as object },
    });
  };

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const put = (token: string, value: unknown) =>
    request(app.getHttpServer())
      .put(`/api/settings/${SPECIAL_ATTEMPT_THRESHOLD_KEY}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value });

  it('admits 2–10 and refuses the two values that would flag the whole backlog', () => {
    expect(SPECIAL_ATTEMPT_THRESHOLD_OPTIONS).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(parseSpecialAttemptThreshold(3)).toEqual({ ok: true, attempts: 3 });
    expect(parseSpecialAttemptThreshold('3')).toEqual({ ok: true, attempts: 3 }); // form bodies carry strings
    expect(parseSpecialAttemptThreshold(1)).toEqual({ ok: false, reason: 'NOT_AN_ALLOWED_OPTION' });
    expect(parseSpecialAttemptThreshold(0)).toEqual({ ok: false, reason: 'NOT_AN_ALLOWED_OPTION' });
    expect(parseSpecialAttemptThreshold(11)).toEqual({ ok: false, reason: 'NOT_AN_ALLOWED_OPTION' });
    expect(parseSpecialAttemptThreshold(3.5)).toEqual({ ok: false, reason: 'NOT_AN_ALLOWED_OPTION' });
    expect(parseSpecialAttemptThreshold('soon')).toEqual({ ok: false, reason: 'NOT_A_NUMBER' });
    expect(parseSpecialAttemptThreshold(null)).toEqual({ ok: false, reason: 'NOT_A_NUMBER' });
  });

  it('is seeded on the registry at the approved default of 3', async () => {
    const row = await prisma.systemSetting.findUnique({ where: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY } });
    expect(row?.value).toBe(3);
    expect(DEFAULT_SPECIAL_ATTEMPT_THRESHOLD).toBe(3);
    expect(row?.description ?? '').not.toBe('');
  });

  it('is Operations-Head-owned with no co-owner, unlike #238\'s threshold', () => {
    expect(writeRolesFor(SPECIAL_ATTEMPT_THRESHOLD_KEY)).toEqual(['OPERATIONS_HEAD']);
  });

  it('lets the Operations Head move it through the generic settings writer', async () => {
    const oh = await login('ops.head@fsm.test');

    await put(oh, 5).expect(200);

    // Read per evaluation, never cached — the next derivation uses 5 with no restart.
    expect(await readSpecialAttemptThreshold(prisma)).toBe(5);
    await resetKey();
  });

  it('refuses an out-of-ladder value with the allowed list, and leaves the stored value untouched', async () => {
    const oh = await login('ops.head@fsm.test');

    const res = await put(oh, 1).expect(400);

    expect(res.body.message?.code ?? res.body.code).toBe('SETTING_VALUE_INVALID');
    // The list is in the refusal because the bound exists nowhere else the operator can see.
    expect(res.body.message?.allowed ?? res.body.allowed).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const row = await prisma.systemSetting.findUnique({ where: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY } });
    expect(row?.value).toBe(DEFAULT_SPECIAL_ATTEMPT_THRESHOLD);
  });

  it('never lets a zonal manager write it', async () => {
    const zm = await login('zm.north@fsm.test');
    await put(zm, 4).expect(403);
    expect(await readSpecialAttemptThreshold(prisma)).toBe(DEFAULT_SPECIAL_ATTEMPT_THRESHOLD);
  });

  /**
   * The defensive read. A row hand-edited to a value the ladder does not admit must not gate the
   * derivation on a number nothing else in the system understands — the queue falls back to the
   * default rather than classifying against 1. Asserted at the reader, not only at the parser,
   * because that is the path the engine actually takes.
   */
  it('falls back to the default when the stored value is not on the ladder', async () => {
    expect(coerceStoredSpecialThreshold(1)).toBe(DEFAULT_SPECIAL_ATTEMPT_THRESHOLD);
    expect(coerceStoredSpecialThreshold('nonsense')).toBe(DEFAULT_SPECIAL_ATTEMPT_THRESHOLD);
    expect(coerceStoredSpecialThreshold(7)).toBe(7);

    await prisma.systemSetting.update({
      where: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY },
      data: { value: 1 as unknown as object },
    });
    expect(await readSpecialAttemptThreshold(prisma)).toBe(DEFAULT_SPECIAL_ATTEMPT_THRESHOLD);
    await resetKey();
  });
});
