import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 47 — RequestActor acting-attribution seam. Before this slice `acted_as_role` was
 * structurally always null on every audited mutation: controllers handed services an
 * AccessTokenClaims (no acting fields) and `resolveActingContext` ran only in `GET /me`.
 *
 * Proof the seam works end-to-end: an acting-capable caller (Operations Head) that targets a
 * zone via `X-Acting-As-Zone` on a real audited mutation must stamp `acted_as_role` (+ the
 * `acting_zone`) onto the `audit_logs` row — not just on `/me`. A normal config request (no
 * acting header) must still record `acted_as_role = null` (Issue 02 behaviour unchanged).
 */
const NS = Date.now();

describe('Issue 47 — acted_as_role reaches an audited mutation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const actingName = `Co-actor-acting-${NS}`;
  const normalName = `Co-actor-normal-${NS}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({
      where: { entityType: 'company_master', entityId: { in: [actingName, normalName] } },
    });
    await prisma.company.deleteMany({ where: { name: { in: [actingName, normalName] } } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  it('stamps acted_as_role + acting_zone on the audit row when acting in a zone', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/companies')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acting-As-Zone', '1')
      .send({ name: actingName, companyTier: 'SILVER', companyPriorityRank: 'C' })
      .expect(201);

    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'company_master', entityId: actingName, action: 'COMPANY_CREATED' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].actedAsRole).toBe('OPERATIONS_HEAD');
    expect(rows[0].actingZone).toBe(1n);
  });

  it('leaves acted_as_role null on a normal (non-acting) config mutation', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/companies')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: normalName, companyTier: 'SILVER', companyPriorityRank: 'C' })
      .expect(201);

    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'company_master', entityId: normalName, action: 'COMPANY_CREATED' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].actedAsRole).toBeNull();
    expect(rows[0].actingZone).toBeNull();
  });
});
