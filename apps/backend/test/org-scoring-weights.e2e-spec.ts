import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 02 Slice 8 — Recommender scoring weights (`priority_rule_config`). Operations Head tunes
 * the weight set without code changes (AC#3); BatchAssignment stamps the active set into
 * recommendations (Issue 10). Upsert keyed by (weightSetRef, component).
 */
describe('Issue 02 Slice 8 — /api/org/scoring-weights', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  it('upserts a scoring weight and lists it by weight set', async () => {
    const token = await login('ops.head@fsm.test');
    const ref = `v-${randomUUID().slice(0, 8)}`;

    const created = await request(app.getHttpServer())
      .post('/api/org/scoring-weights')
      .set('Authorization', `Bearer ${token}`)
      .send({ weightSetRef: ref, component: 'company_priority_rank', weight: 0.5 })
      .expect(201);
    expect(created.body.weight).toBe(0.5);
    expect(created.body.active).toBe(true);

    await request(app.getHttpServer())
      .post('/api/org/scoring-weights')
      .set('Authorization', `Bearer ${token}`)
      .send({ weightSetRef: ref, component: 'company_priority_rank', weight: 0.75 })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get(`/api/org/scoring-weights?weightSetRef=${ref}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].weight).toBe(0.75);
  });

  it('rejects a non-numeric weight with 400', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/scoring-weights')
      .set('Authorization', `Bearer ${token}`)
      .send({ weightSetRef: 'v1', component: 'dispatch_urgency', weight: 'heavy' })
      .expect(400);
  });

  it('rejects a non-Operations-Head writer with 403', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/scoring-weights')
      .set('Authorization', `Bearer ${token}`)
      .send({ weightSetRef: 'v1', component: 'x', weight: 1 })
      .expect(403);
  });

  it('#266 — rejects a component the scorer does not read, with 400', async () => {
    // The weight set is a CLOSED vocabulary: `scoring.ts` names the six components `scoreCandidate`
    // actually reads, and anything else is a lever that moves nothing. This endpoint used to accept
    // any string, and the admin form's Component field is free text, so a dead weight could be
    // created in seconds and would then sit in the table looking exactly like a real one — and ride
    // along in every persisted `score_breakdown.weights`, since `activeWeights` loads whatever is
    // active. That is the same "looks like a lever, isn't one" defect #266 exists to remove; leaving
    // the door open would let it be recreated the day after the dead three are deactivated.
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/org/scoring-weights')
      .set('Authorization', `Bearer ${token}`)
      .send({ weightSetRef: 'v1', component: 'company_tier', weight: 0.4 })
      .expect(400);
    // The message names the component and the real vocabulary, because the operator's next question
    // is always "then what CAN I set?".
    expect(String(res.body.message)).toContain('company_tier');
    expect(String(res.body.message)).toContain('company_priority_rank');
  });

  it('#266 — the three dead seeded weights are no longer active anywhere', async () => {
    // `company_tier`, `device_bucket` and `sla_urgency` were seeded as scoring components and read by
    // nothing: `scoreCandidate` consumes only company_priority_rank, dispatch_urgency,
    // repeat_failure_penalty, distance, repeat_failure_bonus and device_age (grep of src/recommender
    // returns zero hits for the three). They still loaded into `activeWeights` and were persisted in
    // every breakdown, so each stored explanation carried three numbers that contributed nothing.
    const token = await login('ops.head@fsm.test');
    const list = await request(app.getHttpServer())
      .get('/api/org/scoring-weights')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const dead = (list.body as { component: string; active: boolean }[]).filter((w) =>
      ['company_tier', 'device_bucket', 'sla_urgency'].includes(w.component),
    );
    // Deactivated rather than deleted, so the history of them having existed survives — but none may
    // be active, because active is what reaches the scorer and the breakdown.
    expect(dead.every((w) => w.active === false)).toBe(true);
  });

  it('#266 — serves the component vocabulary so the admin picker cannot drift from validation', async () => {
    // The admin's Component field was free text. Turning it into a picker needs the list, and hard-
    // coding six strings in the admin would be a second spelling of the vocabulary — the same fork
    // #273's one-predicate rule exists to close. Both the picker and the 400 above now read this.
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/org/scoring-weights/components')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.components).toContain('company_priority_rank');
    expect(res.body.components).toContain('device_age');
    // The retired three are absent — this endpoint answers "what is a lever", not "what rows exist".
    expect(res.body.components).not.toContain('company_tier');
  });
});
