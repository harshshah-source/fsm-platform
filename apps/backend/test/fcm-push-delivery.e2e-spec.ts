import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { DeviceTokenService } from '../src/notifications/device-token.service';
import { NotificationService } from '../src/notifications/notification.service';
import {
  LoggingChannelGateway,
  NOTIFICATION_CHANNEL_GATEWAY,
  channelDeliveryStatus,
  type NotificationChannelGateway,
} from '../src/notifications/notification-channel.gateway';
import {
  FcmChannelGateway,
  createChannelGateway,
  resolvePushProvider,
  type FcmAccessTokenProvider,
  type FcmHttpClient,
  type FcmHttpRequest,
  type FcmHttpResponse,
} from '../src/notifications/fcm-channel.gateway';

/**
 * #337 — the push delivery exit.
 *
 * `LoggingChannelGateway.deliver` returned `'UNAVAILABLE'` unconditionally and was the only bound
 * implementation: the outbox was durable, the in-app rows were written, `device_tokens` existed, and
 * nothing had ever left the server. Five modules bottom out here, so every "the SE is notified" claim
 * in the product was false at the last inch.
 *
 * FCM project credentials are external provisioning (HITL) and are not available, so this is a seam
 * build in the CLAUDE.md sense: the adapter is complete and fully exercised against an injected HTTP
 * stub, the default binding stays `logging` so nothing changes until an operator says so, and live
 * delivery is one env var plus a service account away.
 *
 * The mapping in AC1 is what these tests are mostly about. 404/410 is the one that costs something if
 * it is wrong: a dead token that is never reaped means every future push to that user retries against
 * a handset that will never answer.
 */

/** Records every request and answers from a queue of scripted responses. */
class StubHttp implements FcmHttpClient {
  readonly requests: FcmHttpRequest[] = [];
  constructor(private readonly responses: (FcmHttpResponse | Error)[]) {}
  async post(request: FcmHttpRequest): Promise<FcmHttpResponse> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (!next) throw new Error('StubHttp: no scripted response left');
    if (next instanceof Error) throw next;
    return next;
  }
}

const staticToken: FcmAccessTokenProvider = { accessToken: async () => 'stub-access-token' };

const CONFIG = {
  projectId: 'fsm-test-project',
  clientEmail: 'push@fsm-test-project.iam.gserviceaccount.com',
  privateKey: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
};

describe('#337 — FCM push delivery exit (injected HTTP stub)', () => {
  let prisma: PrismaService;
  let deviceTokens: DeviceTokenService;
  const userIds: string[] = [];
  const notificationIds: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    deviceTokens = new DeviceTokenService(prisma);
  });

  afterAll(async () => {
    await prisma.notificationDelivery.deleteMany({ where: { notificationId: { in: notificationIds } } });
    await prisma.notification.deleteMany({ where: { id: { in: notificationIds } } });
    await prisma.deviceToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.onModuleDestroy();
  });

  async function makeSe(): Promise<string> {
    const t = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + t, role: 'SERVICE_ENGINEER', phone: 'fcm-' + t, email: `fcm-${t}@fcm.test` },
    });
    userIds.push(u.userId);
    return u.userId;
  }

  const gatewayWith = (http: FcmHttpClient): FcmChannelGateway =>
    new FcmChannelGateway({ config: CONFIG, http, tokens: staticToken, deviceTokens });

  const push = (userId: string, over: Record<string, unknown> = {}) => ({
    channel: 'PUSH' as const,
    recipientUserId: userId,
    recipientRole: 'SERVICE_ENGINEER',
    type: 'DAY_PLAN_DISPATCHED',
    title: 'Your Day Plan is live',
    body: 'Your Day Plan is live. Tap to start.',
    entityType: 'ticket',
    entityId: '4821',
    metadata: null,
    ...over,
  });

  it('AC1 — 200 maps to SENT and carries the provider message id', async () => {
    const userId = await makeSe();
    await deviceTokens.register(userId, 'tok-live', 'device-a');
    const http = new StubHttp([
      { status: 200, body: JSON.stringify({ name: 'projects/fsm-test-project/messages/0:1662' }) },
    ]);

    const out = await gatewayWith(http).deliver(push(userId));

    expect(channelDeliveryStatus(out)).toBe('SENT');
    expect(out).toMatchObject({ providerMessageId: 'projects/fsm-test-project/messages/0:1662' });
    expect(await prisma.deviceToken.findUnique({ where: { userId } })).not.toBeNull();
  });

  it('AC1 — the wire payload is {title, body, data:{type, entityId}} against the v1 send endpoint', async () => {
    const userId = await makeSe();
    await deviceTokens.register(userId, 'tok-shape', 'device-b');
    const http = new StubHttp([{ status: 200, body: JSON.stringify({ name: 'projects/p/messages/1' }) }]);

    await gatewayWith(http).deliver(push(userId));

    const [req] = http.requests;
    expect(req.url).toBe('https://fcm.googleapis.com/v1/projects/fsm-test-project/messages:send');
    expect(req.headers.Authorization).toBe('Bearer stub-access-token');
    const sent = JSON.parse(req.body) as {
      message: { token: string; notification: { title: string; body?: string }; data: Record<string, string> };
    };
    expect(sent.message.token).toBe('tok-shape');
    expect(sent.message.notification).toEqual({ title: 'Your Day Plan is live', body: 'Your Day Plan is live. Tap to start.' });
    expect(sent.message.data).toMatchObject({ type: 'DAY_PLAN_DISPATCHED', entityId: '4821' });
    // FCM v1 rejects a non-string data value outright — a number or null here 400s every send.
    expect(Object.values(sent.message.data).every((v) => typeof v === 'string')).toBe(true);
  });

  it('AC1 — 404 maps to FAILED and reaps the stale token row', async () => {
    const userId = await makeSe();
    await deviceTokens.register(userId, 'tok-dead-404', 'device-c');
    const http = new StubHttp([{ status: 404, body: '{"error":{"status":"NOT_FOUND"}}' }]);

    const out = await gatewayWith(http).deliver(push(userId));

    expect(channelDeliveryStatus(out)).toBe('FAILED');
    // The point of the reap: without it every future push to this user retries a handset that will
    // never answer, forever, and nothing in the system ever says why.
    expect(await prisma.deviceToken.findUnique({ where: { userId } })).toBeNull();
  });

  it('AC1 — 410 maps to FAILED and reaps the stale token row', async () => {
    const userId = await makeSe();
    await deviceTokens.register(userId, 'tok-dead-410', 'device-d');
    const http = new StubHttp([{ status: 410, body: '{"error":{"status":"UNREGISTERED"}}' }]);

    const out = await gatewayWith(http).deliver(push(userId));

    expect(channelDeliveryStatus(out)).toBe('FAILED');
    expect(out).toMatchObject({ retryable: false });
    expect(await prisma.deviceToken.findUnique({ where: { userId } })).toBeNull();
  });

  it('AC1 — a reap only deletes the token it actually sent to, never one registered since', async () => {
    const userId = await makeSe();
    await deviceTokens.register(userId, 'tok-old', 'device-e');
    const http: FcmHttpClient = {
      post: async () => {
        // The handset re-registered between the read and the response — the race the reap must lose.
        await deviceTokens.register(userId, 'tok-new', 'device-e2');
        return { status: 410, body: '{}' };
      },
    };

    await gatewayWith(http).deliver(push(userId));

    const row = await prisma.deviceToken.findUnique({ where: { userId } });
    expect(row?.token).toBe('tok-new');
  });

  it('AC1 — 5xx maps to FAILED, is marked retryable, and leaves the token row alone', async () => {
    const userId = await makeSe();
    await deviceTokens.register(userId, 'tok-5xx', 'device-f');
    const http = new StubHttp([{ status: 503, body: 'service unavailable' }]);

    const out = await gatewayWith(http).deliver(push(userId));

    expect(channelDeliveryStatus(out)).toBe('FAILED');
    expect(out).toMatchObject({ retryable: true });
    // A 5xx says nothing about the token — reaping it here would turn a provider blip into a
    // permanently unreachable engineer.
    expect(await prisma.deviceToken.findUnique({ where: { userId } })).not.toBeNull();
  });

  it('a transport error is FAILED and retryable, not an exception out of deliver()', async () => {
    const userId = await makeSe();
    await deviceTokens.register(userId, 'tok-net', 'device-g');
    const http = new StubHttp([new Error('ECONNRESET')]);

    const out = await gatewayWith(http).deliver(push(userId));

    expect(channelDeliveryStatus(out)).toBe('FAILED');
    expect(out).toMatchObject({ retryable: true });
  });

  it('an unregistered user is UNAVAILABLE — the chain continues exactly as it does today', async () => {
    const userId = await makeSe();
    const http = new StubHttp([]);

    const out = await gatewayWith(http).deliver(push(userId));

    expect(channelDeliveryStatus(out)).toBe('UNAVAILABLE');
    expect(http.requests).toHaveLength(0);
  });

  it('AC5 — SMS, WhatsApp and email stay UNAVAILABLE; the FCM adapter answers for PUSH only', async () => {
    const userId = await makeSe();
    await deviceTokens.register(userId, 'tok-other', 'device-h');
    const http = new StubHttp([]);
    const gw = gatewayWith(http);

    for (const channel of ['SMS', 'WHATSAPP', 'EMAIL'] as const) {
      expect(channelDeliveryStatus(await gw.deliver(push(userId, { channel })))).toBe('UNAVAILABLE');
    }
    expect(http.requests).toHaveLength(0);
  });

  it('AC4 — notify() records the provider message id on the PUSH delivery row', async () => {
    const userId = await makeSe();
    await deviceTokens.register(userId, 'tok-notify', 'device-i');
    const http = new StubHttp([{ status: 200, body: JSON.stringify({ name: 'projects/p/messages/9:99' }) }]);
    const svc = new NotificationService(prisma, gatewayWith(http));

    const [n] = await svc.notify({
      recipients: [{ userId, role: 'SERVICE_ENGINEER' }],
      type: 'DAY_PLAN_DISPATCHED',
      title: 'Your Day Plan is live',
      entityType: 'ticket',
      entityId: '4821',
    });
    notificationIds.push(BigInt(n.id));

    const rows = await prisma.notificationDelivery.findMany({ where: { notificationId: BigInt(n.id) } });
    const pushRow = rows.find((r) => r.channel === 'PUSH');
    expect(pushRow?.status).toBe('SENT');
    expect(pushRow?.providerMessageId).toBe('projects/p/messages/9:99');
    expect(pushRow?.error).toBeNull();
    // SENT stops the chain, exactly as it always has.
    expect(rows.map((r) => r.channel).sort()).toEqual(['IN_APP', 'PUSH']);
  });

  it('AC4 — a failed push is recorded FAILED with the provider error, and the chain still walks on', async () => {
    const userId = await makeSe();
    await deviceTokens.register(userId, 'tok-notify-fail', 'device-j');
    const http = new StubHttp([{ status: 503, body: 'upstream had a bad day' }]);
    const svc = new NotificationService(prisma, gatewayWith(http));

    const [n] = await svc.notify({
      recipients: [{ userId, role: 'SERVICE_ENGINEER' }],
      type: 'DAY_PLAN_OVERRIDDEN',
      title: 'Day Plan updated',
    });
    notificationIds.push(BigInt(n.id));

    const rows = await prisma.notificationDelivery.findMany({ where: { notificationId: BigInt(n.id) } });
    const byChannel = Object.fromEntries(rows.map((r) => [r.channel, r]));
    // FAILED, not ATTEMPTED: `notification_deliveries` is the record somebody consults to ask "was
    // this person actually told", and "we tried and the provider refused" is a different answer from
    // "there was no adapter".
    expect(byChannel.PUSH?.status).toBe('FAILED');
    expect(byChannel.PUSH?.error).toContain('503');
    expect(byChannel.SMS?.status).toBe('ATTEMPTED');
    expect(byChannel.EMAIL?.status).toBe('ATTEMPTED');
    // #361 consumes this shape: the per-channel result a producer reads carries the same detail.
    expect(n.deliveries.find((d) => d.channel === 'PUSH')).toMatchObject({ status: 'FAILED' });
  });
});

describe('#337 — provider selection (AC2: default binding unchanged)', () => {
  it('defaults to the logging provider when PUSH_PROVIDER is unset', () => {
    expect(resolvePushProvider({})).toBe('logging');
    expect(resolvePushProvider({ PUSH_PROVIDER: '' })).toBe('logging');
    expect(resolvePushProvider({ PUSH_PROVIDER: 'logging' })).toBe('logging');
  });

  it('selects fcm only when it is spelled out', () => {
    expect(resolvePushProvider({ PUSH_PROVIDER: 'fcm' })).toBe('fcm');
    expect(resolvePushProvider({ PUSH_PROVIDER: ' FCM ' })).toBe('fcm');
  });

  it('refuses an unrecognised provider rather than quietly staying inert', () => {
    // A typo that silently falls back to logging is how an operator comes to believe push is live
    // when it is not — the exact defect class this slice closes.
    expect(() => resolvePushProvider({ PUSH_PROVIDER: 'firebase' })).toThrow(/PUSH_PROVIDER/);
  });

  it('AC2 — the factory builds the logging gateway by default', () => {
    const gw = createChannelGateway({ deviceTokens: null as never, env: {} });
    expect(gw).toBeInstanceOf(LoggingChannelGateway);
    expect(gw.sendsExternally).toBe(false);
  });

  it('builds the FCM gateway when the provider and credentials are both present', () => {
    const gw = createChannelGateway({
      deviceTokens: null as never,
      env: {
        PUSH_PROVIDER: 'fcm',
        FCM_PROJECT_ID: CONFIG.projectId,
        FCM_CLIENT_EMAIL: CONFIG.clientEmail,
        FCM_PRIVATE_KEY: CONFIG.privateKey,
      },
    });
    expect(gw).toBeInstanceOf(FcmChannelGateway);
    expect(gw.sendsExternally).toBe(true);
  });

  it('aborts the boot when fcm is asked for without credentials, rather than falling back to logging', () => {
    // Falling back would leave the operator with a configuration that says push is on, a log line
    // nobody reads, and engineers who are never told anything.
    expect(() => createChannelGateway({ deviceTokens: null as never, env: { PUSH_PROVIDER: 'fcm' } })).toThrow(
      /FCM_PROJECT_ID/,
    );
  });
});

describe('#337 — the AppModule binding is still the inert one (AC2)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('binds LoggingChannelGateway with no PUSH_PROVIDER set', () => {
    const gateway = moduleRef.get<NotificationChannelGateway>(NOTIFICATION_CHANNEL_GATEWAY);
    expect(gateway).toBeInstanceOf(LoggingChannelGateway);
  });
});
