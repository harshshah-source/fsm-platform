import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationService } from '../src/notifications/notification.service';
import { type ChannelDeliveryResult, type ChannelSendInput, type NotificationChannelGateway } from '../src/notifications/notification-channel.gateway';
import { type NotificationChannel } from '../src/generated/prisma/enums';

/**
 * Issue 03 slice 2 — the notification spine. `notify` always fires the in-app notification (AC#1);
 * notifications walk the push→SMS→WhatsApp→email fallback chain, stopping at the first SENT channel
 * and recording the rest ATTEMPTED (AC#2). External delivery itself is the deferred gateway seam.
 *
 * **#356 (AC6) — the SE_ACCEPTANCE delivery model is gone.** CONTEXT §21 retired SE Acceptance
 * (#268/#279): a CRITICAL ticket is assigned directly, there is no acceptance to confirm, and no
 * producer had passed `deliveryModel: 'SE_ACCEPTANCE'` since. The plan re-typed the survey's NOTIF-05
 * from "gap — the WhatsApp confirmation is coded but never called" to "dead code: delete", and this is
 * that deletion. The two tests that pinned the branch's behaviour (#76's "never record a false SENT")
 * are rewritten below rather than deleted outright: what #76 was actually protecting — that a channel
 * the gateway did not send is never recorded SENT — is a property of the surviving chain too, and it
 * keeps its test here.
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

  /**
   * #356 AC6, rewriting #76's pair. WhatsApp is no longer a first-class channel for anything — it is
   * one rung of the ordinary chain — but the rule #76 existed for outlives the branch: a channel the
   * gateway did not actually send is recorded ATTEMPTED, never SENT. A false SENT in
   * `notification_deliveries` is a false record in the audit trail, and the whole point of the table
   * is that somebody can afterwards ask "was this person actually told?".
   */
  it('#76/#356 — a channel the gateway could not send is recorded ATTEMPTED, never a false SENT', async () => {
    const userId = await makeUser();
    const [n] = await svc(new FakeGateway({ WHATSAPP: 'SENT' })).notify({
      recipients: [{ userId, role: 'SERVICE_ENGINEER' }],
      type: 'INTRADAY_ESCALATION_REQUIRED',
      title: 'Manual assignment needed',
    });
    const d = await deliveriesOf(n.id);
    const byChannel = Object.fromEntries(d.map((x) => [x.channel, x.status]));
    expect(byChannel.PUSH).toBe('ATTEMPTED');
    expect(byChannel.SMS).toBe('ATTEMPTED');
    expect(byChannel.WHATSAPP).toBe('SENT');
    expect(byChannel.EMAIL).toBeUndefined();
  });

  it('#356 AC6 — every notification walks the general chain; there is no acceptance model left to take', async () => {
    const userId = await makeUser();
    const [n] = await svc(new FakeGateway()).notify({
      recipients: [{ userId, role: 'SERVICE_ENGINEER' }],
      type: 'INTRADAY_DIRECT_ASSIGNED',
      title: 'CRITICAL ticket added to your Day Plan',
      deliveryModel: 'GENERAL',
    });
    const d = await deliveriesOf(n.id);
    // The WhatsApp-only shape the retired SE_ACCEPTANCE model produced is unreachable: PUSH and EMAIL
    // are both attempted, which that branch never did.
    expect(d.map((x) => x.channel)).toEqual(['IN_APP', 'PUSH', 'SMS', 'WHATSAPP', 'EMAIL']);
    expect(d.every((x) => x.firstClass === false)).toBe(true);
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

/**
 * #356 AC4 — who a zone's escalation news reaches when the zone names no manager.
 *
 * `zoneManagerRecipients` is the one place that question is answered, promoted here out of
 * `cross-zone-escalation.service.ts` (where #354 first wrote it privately) because three producers now
 * ask it: cross-zone escalation, the CRITICAL intra-day sweep and stranded-work escalation. The
 * designated `zones.zonal_manager_user_id` wins when there is one — a zone that names an accountable
 * manager does not want its news fanned out to everyone holding the role there. When there is none the
 * role itself answers, and when *that* is empty the miss is logged rather than returned as silence.
 */
describe('#356 — zoneManagerRecipients', () => {
  let prisma: PrismaService;
  let svc: NotificationService;
  let namedZone: bigint;
  let vacantZone: bigint;
  let emptyZone: bigint;
  const userIds: string[] = [];
  let designated: string;
  let roleHolder: string;

  const makeZm = async (zoneId: bigint | null, tag: string): Promise<string> => {
    const u = await prisma.user.create({
      data: { name: 'ZM ' + tag, role: 'ZONAL_MANAGER', phone: `zmr-${tag}-${NS}`, email: `zmr-${tag}-${NS}@zr.test`, zoneId },
    });
    userIds.push(u.userId);
    return u.userId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new NotificationService(prisma);

    namedZone = (await prisma.zone.create({ data: { name: 'Z-zmr-named-' + NS } })).zoneId;
    vacantZone = (await prisma.zone.create({ data: { name: 'Z-zmr-vacant-' + NS } })).zoneId;
    emptyZone = (await prisma.zone.create({ data: { name: 'Z-zmr-empty-' + NS } })).zoneId;

    designated = await makeZm(namedZone, 'named');
    await prisma.zone.update({ where: { zoneId: namedZone }, data: { zonalManagerUserId: designated } });
    // A zone with a ZM on its roster but nobody designated on the zone row.
    roleHolder = await makeZm(vacantZone, 'vacant');
  });

  afterAll(async () => {
    await prisma.zone.update({ where: { zoneId: namedZone }, data: { zonalManagerUserId: null } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [namedZone, vacantZone, emptyZone] } } });
    await prisma.onModuleDestroy();
  });

  it('returns the designated manager when the zone names one', async () => {
    const out = await svc.zoneManagerRecipients(namedZone);
    expect(out).toEqual([{ userId: designated, role: 'ZONAL_MANAGER' }]);
  });

  it('AC4 — falls back to the role holders in the zone when the zone names nobody', async () => {
    const out = await svc.zoneManagerRecipients(vacantZone);
    expect(out).toEqual([{ userId: roleHolder, role: 'ZONAL_MANAGER' }]);
  });

  it('AC4 — a zone with nobody at all returns empty and logs the miss, rather than returning silently', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const out = await svc.zoneManagerRecipients(emptyZone);
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NO_RECIPIENT'));
    warn.mockRestore();
  });
});
