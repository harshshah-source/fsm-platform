import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationService } from '../src/notifications/notification.service';
import { type ChannelDeliveryResult, type ChannelSendInput, type NotificationChannelGateway } from '../src/notifications/notification-channel.gateway';
import { type NotificationChannel } from '../src/generated/prisma/enums';

/**
 * Issue 03 slice 2 — the notification spine. `notify` always fires the in-app notification (AC#1); GENERAL
 * notifications walk the push→SMS→WhatsApp→email fallback chain, stopping at the first SENT channel and
 * recording the rest ATTEMPTED (AC#2); SE_ACCEPTANCE delivers WhatsApp as a first-class channel recorded
 * SENT — shown as "sent", not "attempted" (AC#3). External delivery itself is the deferred gateway seam.
 */
const NS = Date.now();

/** A configurable fake gateway: returns the mapped result per channel (default UNAVAILABLE). */
class FakeGateway implements NotificationChannelGateway {
  constructor(private readonly results: Partial<Record<NotificationChannel, ChannelDeliveryResult>> = {}) {}
  deliver(input: ChannelSendInput): ChannelDeliveryResult {
    return this.results[input.channel] ?? 'UNAVAILABLE';
  }
}

describe('Issue 03 slice 2 — NotificationService.notify', () => {
  let prisma: PrismaService;
  let userIds: string[] = [];
  const notificationIds: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.notificationDelivery.deleteMany({ where: { notificationId: { in: notificationIds } } });
    await prisma.notification.deleteMany({ where: { id: { in: notificationIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.onModuleDestroy();
  });

  async function makeUser(): Promise<string> {
    const t = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'U ' + t, role: 'ZONAL_MANAGER', phone: 'nt-' + t, email: `nt-${t}@nt.test` } });
    userIds.push(u.userId);
    return u.userId;
  }

  const svc = (gw?: NotificationChannelGateway) => new NotificationService(prisma, gw);
  const deliveriesOf = async (id: string) => {
    notificationIds.push(BigInt(id));
    return prisma.notificationDelivery.findMany({ where: { notificationId: BigInt(id) }, orderBy: { id: 'asc' } });
  };

  it('always fires an in-app notification, and falls through the chain when no external channel is available', async () => {
    const userId = await makeUser();
    const [n] = await svc(new FakeGateway()).notify({ recipients: [{ userId, role: 'ZONAL_MANAGER' }], type: 'SLA_WARNING', title: 'SLA risk' });
    const d = await deliveriesOf(n.id);
    expect(d.find((x) => x.channel === 'IN_APP')?.status).toBe('SENT');
    const chain = d.filter((x) => x.channel !== 'IN_APP');
    expect(chain.map((x) => x.channel)).toEqual(['PUSH', 'SMS', 'WHATSAPP', 'EMAIL']);
    expect(chain.every((x) => x.status === 'ATTEMPTED')).toBe(true);
  });

  it('stops the fallback chain at the first channel the gateway reports SENT', async () => {
    const userId = await makeUser();
    const [n] = await svc(new FakeGateway({ SMS: 'SENT' })).notify({ recipients: [{ userId, role: 'ZONAL_MANAGER' }], type: 'NEW_ASSIGNMENT', title: 'New ticket' });
    const d = await deliveriesOf(n.id);
    const byChannel = Object.fromEntries(d.map((x) => [x.channel, x.status]));
    expect(byChannel.IN_APP).toBe('SENT');
    expect(byChannel.PUSH).toBe('ATTEMPTED');
    expect(byChannel.SMS).toBe('SENT');
    expect(byChannel.WHATSAPP).toBeUndefined(); // chain stopped — never tried
    expect(byChannel.EMAIL).toBeUndefined();
  });

  it('SE_ACCEPTANCE delivers WhatsApp as a first-class channel, recorded SENT (shown as "sent")', async () => {
    const userId = await makeUser();
    const [n] = await svc(new FakeGateway()).notify({
      recipients: [{ userId, role: 'SERVICE_ENGINEER' }],
      type: 'SE_ACCEPTANCE_CONFIRMATION',
      title: 'You accepted ticket #42',
      deliveryModel: 'SE_ACCEPTANCE',
    });
    const d = await deliveriesOf(n.id);
    const wa = d.find((x) => x.channel === 'WHATSAPP');
    expect(wa?.status).toBe('SENT');
    expect(wa?.firstClass).toBe(true);
    expect(d.find((x) => x.channel === 'IN_APP')?.status).toBe('SENT');
    // SE_ACCEPTANCE is not the general fallback chain — no PUSH/SMS/EMAIL rows.
    expect(d.some((x) => x.channel === 'PUSH' || x.channel === 'EMAIL')).toBe(false);
  });

  it('writes one notification per recipient', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const res = await svc(new FakeGateway()).notify({ recipients: [{ userId: a, role: 'ZONAL_MANAGER' }, { userId: b, role: 'OPERATIONS_HEAD' }], type: 'BATCH_STATUS', title: 'Batch dispatched' });
    expect(res).toHaveLength(2);
    for (const n of res) await deliveriesOf(n.id);
    expect(new Set(res.map((n) => n.recipientUserId))).toEqual(new Set([a, b]));
  });
});
