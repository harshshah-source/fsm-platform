import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SHARED_AUTH_SE_ID, seedSharedAuthSeEngineer } from './fixtures/shared-auth-se';

/**
 * Issue 81 (D-12) — the Media Upload API. `POST /api/media/upload` turns a captured photo into an
 * opaque `photoRef`; `GET /api/media/:id` retrieves it, scoped so an SE can't read another SE's
 * unsubmitted media. Both are exercised over real multipart HTTP, not the service directly, since
 * multer's field parsing is exactly what this issue's contract depends on.
 */
const NS = Date.now();
const JPEG_BYTES = Buffer.from('ffd8ffe000104a464946', 'hex');
// se.north@fsm.test's fixed userId (auth-fixture-seed.ts) — not globally given an EngineerMaster
// row, so writes through it FK-violate on media_objects.se_id until this suite upserts one,
// same pattern as verification-controller.e2e-spec.ts.
const SE_ID = SHARED_AUTH_SE_ID; // se.north@fsm.test — shared across 16 specs, see fixtures/shared-auth-se.ts

describe('media controller (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const mediaIds: string[] = [];
  const voucherIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    await seedSharedAuthSeEngineer(prisma); // canonical North row (#215); a create-only no-op post-global-setup
  });

  afterAll(async () => {
    await prisma.expenseVoucher.deleteMany({ where: { voucherId: { in: voucherIds } } });
    await prisma.mediaObject.deleteMany({ where: { mediaId: { in: mediaIds } } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  function uploadAs(token: string, kind: string, slot: string, opts?: { contentType?: string; bytes?: Buffer }) {
    return request(app.getHttpServer())
      .post('/api/media/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('kind', kind)
      .field('slot', slot)
      .attach('file', opts?.bytes ?? JPEG_BYTES, { filename: 'x.jpg', contentType: opts?.contentType ?? 'image/jpeg' });
  }

  it('an SE uploads a troubleshoot BEFORE photo and gets back a photoRef', async () => {
    const token = await login('se.north@fsm.test');
    const res = await uploadAs(token, 'TROUBLESHOOT', 'BEFORE').expect(201);

    expect(typeof res.body.photoRef).toBe('string');
    expect(res.body.photoRef.length).toBeGreaterThan(0);
    expect(res.body.kind).toBe('TROUBLESHOOT');
    expect(res.body.slot).toBe('BEFORE');
    mediaIds.push(res.body.photoRef);
  });

  it('rejects a slot that does not belong to the given kind', async () => {
    const token = await login('se.north@fsm.test');
    const res = await uploadAs(token, 'VOUCHER', 'BEFORE').expect(400);
    expect(res.body.code).toBe('INVALID_SLOT');
  });

  it('rejects an unknown kind', async () => {
    const token = await login('se.north@fsm.test');
    const res = await uploadAs(token, 'BOGUS', 'BEFORE').expect(400);
    expect(res.body.code).toBe('INVALID_KIND');
  });

  it('rejects a non-image content type', async () => {
    const token = await login('se.north@fsm.test');
    const res = await uploadAs(token, 'VOUCHER', 'RECEIPT', { contentType: 'text/plain' }).expect(400);
    expect(res.body.code).toBe('INVALID_CONTENT_TYPE');
  });

  it('rejects a file over the size cap as a 400, not a 500', async () => {
    const token = await login('se.north@fsm.test');
    const big = Buffer.alloc(9 * 1024 * 1024, 1);
    const res = await uploadAs(token, 'VOUCHER', 'RECEIPT', { bytes: big }).expect(400);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });

  it('the owning SE can read the photo back', async () => {
    const token = await login('se.north@fsm.test');
    const uploaded = await uploadAs(token, 'VOUCHER', 'PHOTO').expect(201);
    mediaIds.push(uploaded.body.photoRef);

    const res = await request(app.getHttpServer())
      .get(`/api/media/${uploaded.body.photoRef}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Buffer.compare(res.body, JPEG_BYTES)).toBe(0);
  });

  it('a review role (Zonal Manager) can read a SE-owned photo', async () => {
    const seToken = await login('se.north@fsm.test');
    const uploaded = await uploadAs(seToken, 'VOUCHER', 'BILL').expect(201);
    mediaIds.push(uploaded.body.photoRef);

    const zmToken = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get(`/api/media/${uploaded.body.photoRef}`)
      .set('Authorization', `Bearer ${zmToken}`)
      .expect(200);
  });

  it('a different SE cannot read another SE\'s unsubmitted media (#59/#162 wrong-SE regression pattern)', async () => {
    const tag = randomUUID().slice(0, 8);
    const otherUser = await prisma.user.create({
      data: { name: 'SE Other Media', role: 'SERVICE_ENGINEER', phone: 'ph-media-' + tag, email: `se-media-other-${tag}@x.test`, zoneId: (await prisma.zone.findFirstOrThrow()).zoneId },
    });
    await prisma.engineerMaster.create({
      data: { engineerId: otherUser.userId, coverageType: 'DEDICATED', zoneId: otherUser.zoneId!, dailyCapacity: 10 },
    });
    const templateCred = await prisma.userCredential.findFirstOrThrow();
    await prisma.userCredential.create({
      data: {
        userId: otherUser.userId,
        passwordHash: templateCred.passwordHash,
        passwordSalt: templateCred.passwordSalt,
        passwordAlgo: templateCred.passwordAlgo,
        passwordParams: templateCred.passwordParams ?? undefined,
      },
    });

    const seToken = await login('se.north@fsm.test');
    const uploaded = await uploadAs(seToken, 'VOUCHER', 'RECEIPT').expect(201);
    mediaIds.push(uploaded.body.photoRef);

    const otherToken = await login(`se-media-other-${tag}@x.test`);
    const res = await request(app.getHttpServer())
      .get(`/api/media/${uploaded.body.photoRef}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);
    expect(res.body.code).toBe('MEDIA_FORBIDDEN');

    await prisma.engineerMaster.deleteMany({ where: { engineerId: otherUser.userId } });
    await prisma.userCredential.deleteMany({ where: { userId: otherUser.userId } });
    await prisma.user.deleteMany({ where: { userId: otherUser.userId } });
  });

  it('a photoRef round-trips through /api/vouchers unchanged', async () => {
    const token = await login('se.north@fsm.test');
    const uploaded = await uploadAs(token, 'VOUCHER', 'RECEIPT').expect(201);
    mediaIds.push(uploaded.body.photoRef);

    const res = await request(app.getHttpServer())
      .post('/api/vouchers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clientSubmissionId: randomUUID(),
        items: [{ category: 'TRAVEL', amount: 100, photoRef: uploaded.body.photoRef }],
      })
      .expect(201);

    voucherIds.push(res.body.voucher.voucherId);
    const items = await prisma.expenseVoucherItem.findMany({ where: { voucherId: res.body.voucher.voucherId } });
    expect(items[0].photoRef).toBe(uploaded.body.photoRef);
  });
});
