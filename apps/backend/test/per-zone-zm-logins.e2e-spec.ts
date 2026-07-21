import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

/**
 * Issue 133 — a separate login for the ZM of each operational zone (North/South/East/West), each
 * carrying their own `zone_id` so the existing ZoneScopeGuard clamps them to their zone.
 */
describe('Per-zone ZM logins (e2e)', () => {
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

  const cases: { email: string; zoneId: number }[] = [
    { email: 'zm.north@fsm.test', zoneId: 1 },
    { email: 'zm.south@fsm.test', zoneId: 2 },
    { email: 'zm.east@fsm.test', zoneId: 3 },
    { email: 'zm.west@fsm.test', zoneId: 4 },
  ];

  it.each(cases)('logs in $email as ZONAL_MANAGER carrying zone_id $zoneId', async ({ email, zoneId }) => {
    const claims = decodeJwtPayload(await login(email));
    expect(claims.role).toBe('ZONAL_MANAGER');
    expect(claims.zone_id).toBe(zoneId);
  });

  it('clamps each ZM to their own zone (South ZM cannot read the North zone)', async () => {
    const south = await login('zm.south@fsm.test'); // zone 2
    // own zone: allowed
    await request(app.getHttpServer()).get('/api/zones/2').set('Authorization', `Bearer ${south}`).expect(200);
    // North zone: rejected by the existing ZoneScopeGuard
    const res = await request(app.getHttpServer())
      .get('/api/zones/1')
      .set('Authorization', `Bearer ${south}`)
      .expect(403);
    expect(res.body.message).toBe('ZONE_SCOPE_VIOLATION');
  });
});
