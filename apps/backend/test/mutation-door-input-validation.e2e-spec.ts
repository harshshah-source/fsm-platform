import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { istDate } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import { OverrideService } from '../src/scheduling/override.service';
import { SchedulerPreviewService } from '../src/scheduling/scheduler-preview.service';

/**
 * #310 (CB-3 + CB-9 + RC-11 past-dates) — input validation on the override / intraday mutation doors.
 *
 * Three gaps on one surface, and they share a shape: the request itself was never checked, so garbage
 * reached the service or the driver and came back as a 500, or — worse — committed.
 *
 * - **CB-3** `POST /batches/:id/override` took an *interface*-typed body, and the global
 *   `ValidationPipe` skips non-class metatypes by design, so **nothing** validated it. The mandatory
 *   `reasonCode` wrote through as NULL onto the accountability record #275/#282 read, and a missing
 *   `ticketId` reached Prisma as a 500. The sibling door on the same concept
 *   (`intraday-updates.controller.ts`) has always 400'd both.
 * - **CB-9** bare `BigInt(id)` on five handlers whose own siblings, in the same files, wrap it and
 *   answer 404.
 * - **RC-11** a past-dated hold or defer returned OK while holding nothing: `notDeferredOn` is
 *   inclusive, so `deferred_until <= today` is dispatchable today. A "defer" that keeps its audit row
 *   and none of its effect is a bare remove wearing the wrong name.
 *
 * **Why the id/DTO cases use ids that do not exist.** Both the pipe and the id guards run *before* the
 * handler reads anything, so the resource's existence cannot change the answer — and asserting against
 * a nonexistent batch is what makes the assertion sharp: it moves 404 → 400 when the body is the
 * problem, and stays 404 when it is not. The one rule that genuinely needs data — a defer whose date
 * would hold nothing — is driven against a real batch below.
 */
const NS = Date.now();
const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const shiftDays = (d: Date, days: number): Date => new Date(d.getTime() + days * 86_400_000);

describe('#310 — mutation-door input validation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let override: OverrideService;
  let preview: SchedulerPreviewService;

  let zmToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    override = app.get(OverrideService);
    preview = app.get(SchedulerPreviewService);

    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'zm.north@fsm.test', password: 'correct-password' })
      .expect(200);
    zmToken = res.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, body: unknown) =>
    request(app.getHttpServer()).post(`/api/${path}`).set('Authorization', `Bearer ${zmToken}`).send(body);

  const get = (path: string) =>
    request(app.getHttpServer()).get(`/api/${path}`).set('Authorization', `Bearer ${zmToken}`);

  const MISSING_BATCH = '999999999';
  const TICKET = '00000000-0000-0000-0000-0000000000aa';
  const SE = '00000000-0000-0000-0000-0000000000bb';

  /**
   * AC2 — the mandatory reason, and the fields each action cannot work without.
   *
   * Every case here is a body the endpoint used to accept far enough to hit the database. The control
   * case at the end is what stops this describe passing for the wrong reason: if the DTO simply
   * rejected everything, a complete body would 400 too, and the 404 proves it reaches the handler.
   */
  describe('AC2 — a reason-less or field-less override cannot commit', () => {
    it('400s a REMOVE_TICKET with no reasonCode', async () => {
      await post(`batches/${MISSING_BATCH}/override`, { action: 'REMOVE_TICKET', ticketId: TICKET }).expect(400);
    });

    it('400s a reasonCode that is only whitespace — an empty accountability record by another name', async () => {
      await post(`batches/${MISSING_BATCH}/override`, {
        action: 'REMOVE_TICKET',
        ticketId: TICKET,
        reasonCode: '   ',
      }).expect(400);
    });

    it('400s a REMOVE_TICKET with no ticketId (this was the Prisma 500)', async () => {
      await post(`batches/${MISSING_BATCH}/override`, { action: 'REMOVE_TICKET', reasonCode: 'X' }).expect(400);
    });

    it('400s a REORDER with no stopSequence', async () => {
      await post(`batches/${MISSING_BATCH}/override`, { action: 'REORDER', reasonCode: 'X' }).expect(400);
    });

    it('400s a SWAP_SE with no newSeId', async () => {
      await post(`batches/${MISSING_BATCH}/override`, { action: 'SWAP_SE', reasonCode: 'X' }).expect(400);
    });

    it('400s a SPLIT_BATCH with an empty ticketIds list', async () => {
      await post(`batches/${MISSING_BATCH}/override`, {
        action: 'SPLIT_BATCH',
        ticketIds: [],
        newSeId: SE,
        reasonCode: 'X',
      }).expect(400);
    });

    it('applies the same rules to the preview door — one body, one vocabulary (#289)', async () => {
      await post(`batches/${MISSING_BATCH}/override/preview`, { action: 'REASSIGN', ticketId: TICKET, newSeId: SE })
        .expect(400);
    });

    it('control — a complete body still reaches the handler and 404s the missing batch', async () => {
      await post(`batches/${MISSING_BATCH}/override`, {
        action: 'REMOVE_TICKET',
        ticketId: TICKET,
        reasonCode: 'WRONG_PLANT',
      }).expect(404);
    });

    /**
     * The version-skew contract (`batches-controller.e2e-spec.ts`) must survive the DTO. An action this
     * build does not implement is the admin bundle running ahead of the API, and the answer to that is
     * `UNSUPPORTED_ACTION` — a sentence an operator can act on — not a generic validation failure that
     * names a field. So the DTO deliberately does **not** enumerate the actions.
     *
     * This half asserts the pipe lets it through: the request reaches the handler and is answered by
     * the batch lookup (404), which is what the service does first. That the *service* then answers
     * `UNSUPPORTED_ACTION` for a batch that exists is asserted in AC3's block, which has one.
     */
    it('leaves an unknown action to the service rather than answering with a field error', async () => {
      const res = await post(`batches/${MISSING_BATCH}/override`, {
        action: 'NOT_A_REAL_ACTION_FROM_THE_FUTURE',
        ticketId: TICKET,
        reasonCode: 'X',
      });
      expect(res.status).toBe(404);
    });
  });

  /**
   * AC1 — malformed ids. `BigInt('abc')` throws a SyntaxError the handlers never caught; every one of
   * these was a 500 on input the caller controls.
   */
  describe('AC1 — a malformed id is an absent resource, never a 500', () => {
    it('404s a non-numeric batch id on the override door', async () => {
      await post('batches/not-a-number/override', {
        action: 'REMOVE_TICKET',
        ticketId: TICKET,
        reasonCode: 'X',
      }).expect(404);
    });

    it('404s a non-numeric batch id on the preview door (the sibling that already wrapped it)', async () => {
      await post('batches/not-a-number/override/preview', {
        action: 'REASSIGN',
        ticketId: TICKET,
        newSeId: SE,
        reasonCode: 'X',
      }).expect(404);
    });

    it('404s a non-numeric batchId in the intraday remove body', async () => {
      await post('intraday-updates/remove', { batchId: 'abc', ticketId: TICKET, reasonCode: 'X' }).expect(404);
    });

    it('404s a non-numeric batchId in the intraday reorder body', async () => {
      await post('intraday-updates/reorder', { batchId: 'abc', stopSequence: 1, reasonCode: 'X' }).expect(404);
    });

    it('400s a non-numeric zoneId on the critical-assign sweep trigger', async () => {
      // A ZM's zone comes from their own claims, so only a non-ZM manager can name one. This asserts
      // the shape the guard owns: a body-supplied zone that is not a number is the caller's mistake.
      const res = await request(app.getHttpServer())
        .post('/api/intraday-insertions/fire')
        .set('Authorization', `Bearer ${await login('csm@fsm.test')}`)
        .send({ zoneId: 'abc' });
      expect(res.status).toBe(400);
    });

    it('404s a non-numeric insertion id on available-ses', async () => {
      await get('intraday-insertions/abc/available-ses').expect(404);
    });

    it('404s a non-numeric insertion id on manual-assign', async () => {
      await post('intraday-insertions/abc/manual-assign', { seId: SE }).expect(404);
    });
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  /**
   * AC3 — a hold or defer that would hold nothing.
   *
   * `notDeferredOn` is **inclusive**: a ticket with `deferred_until = D` is dispatchable on D. So the
   * date names the day the work comes back, and any date at or before today puts it back today — the
   * ticket leaves the batch (a real, audited effect) and is re-planned by the very next run. The audit
   * says DEFER; the outcome is REMOVE. Both writers are refused, and both refusals name the field.
   */
  describe('AC3 — a past-dated hold or defer is refused, not a silent no-op', () => {
    let zoneId: bigint;
    let companyId: bigint;
    let plantId: bigint;
    let seId: string;
    let batchId: bigint;
    let scheduleId: bigint;
    let holdableTicketId: string;
    const deviceIds: string[] = [];
    const cycleIds: string[] = [];
    const ticketIds: string[] = [];

    const NOW = new Date();
    const TODAY = ymd(istDate(NOW));
    const TOMORROW = ymd(shiftDays(istDate(NOW), 1));
    const YESTERDAY = ymd(shiftDays(istDate(NOW), -1));

    /** One OPEN TROUBLESHOOT ticket on this describe's own plant. */
    const seedTicket = async (): Promise<string> => {
      const deviceId = String(15_310_000_000 + (NS % 100_000) * 10 + deviceIds.length);
      deviceIds.push(deviceId);
      await prisma.device.create({ data: { deviceId } });
      const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
      cycleIds.push(cycle.cycleId);
      const t = await prisma.ticket.create({
        data: {
          workType: 'TROUBLESHOOT',
          status: 'OPEN',
          failureCycleId: cycle.cycleId,
          deviceId,
          plantId,
          companyId,
          companyTier: 'GOLD',
          lastStateChangedAt: NOW,
        },
      });
      ticketIds.push(t.ticketId);
      return t.ticketId;
    };

    beforeAll(async () => {
      zoneId = (await prisma.zone.create({ data: { name: 'Z-310-' + NS } })).zoneId;
      companyId = (
        await prisma.company.create({ data: { name: 'Co-310-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
      ).companyId;
      plantId = (await prisma.plant.create({ data: { name: 'P-310-' + NS, zoneId } })).plantId;

      const user = await prisma.user.create({
        data: { email: `se-310-${NS}@fsm.test`, name: 'SE 310', phone: `+9199310${NS % 100000}`, role: 'SERVICE_ENGINEER', zoneId },
      });
      seId = user.userId;
      await prisma.engineerMaster.create({
        data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
      });

      holdableTicketId = await seedTicket();

      const day = istDate(NOW);
      scheduleId = (
        await prisma.workSchedule.create({ data: { seId, zoneId, dateFrom: day, dateTo: day, dispatchedAt: NOW } })
      ).scheduleId;
      batchId = (
        await prisma.plantBatchAssignment.create({
          data: { scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
        })
      ).batchId;
    });

    /**
     * A fresh assigned ticket per case. The refusals leave the row alone by definition and the control
     * consumes one, so sharing a ticket would make every assertion depend on the order the cases run
     * in — and would have let the control's commit answer for a refusal that never happened.
     */
    const seedAssigned = async (): Promise<string> => {
      const id = await seedTicket();
      await prisma.batchAssignmentTicket.create({ data: { batchId, ticketId: id, sortOrder: ticketIds.length } });
      await prisma.ticket.update({ where: { ticketId: id }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });
      return id;
    };

    afterAll(async () => {
      const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId }, select: { batchId: true } });
      const ids = batches.map((b) => b.batchId);
      await prisma.dayPlanNotificationOutbox.deleteMany({ where: { scheduleId } });
      await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: ids } } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ids.map(String), ...ticketIds] } } });
      await prisma.plantBatchAssignment.deleteMany({ where: { scheduleId } });
      await prisma.workSchedule.deleteMany({ where: { scheduleId } });
      await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
      await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
      await prisma.engineerMaster.deleteMany({ where: { engineerId: seId } });
      await prisma.user.deleteMany({ where: { userId: seId } });
      await prisma.plant.deleteMany({ where: { plantId } });
      await prisma.company.deleteMany({ where: { companyId } });
      await prisma.zone.deleteMany({ where: { zoneId } });
    });

    const defer = (id: string, deferredToDate: string) =>
      override.override(
        batchId,
        { action: 'DEFER_TICKET', ticketId: id, deferredToDate, reasonCode: 'PARTS_ETA' },
        { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
        { userId: randomUUID(), role: 'ZONAL_MANAGER', actedAsRole: null },
        NOW,
      );

    it('refuses a defer to today — inclusive means the ticket is dispatchable today', async () => {
      const id = await seedAssigned();

      expect(await defer(id, TODAY)).toMatchObject({ result: 'INVALID_DATE', field: 'deferredToDate', value: TODAY });

      // Refused means nothing moved. This is the half that matters: the old code returned OK here and
      // left exactly this state inverted — batch row retired, ticket unassigned, hold worth nothing.
      const row = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId, ticketId: id } });
      expect(row.removedAt).toBeNull();
      const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: id } });
      expect(t.deferredUntil).toBeNull();
      expect(t.assignmentState).toBe('FORMALLY_ASSIGNED');
    });

    it('refuses a defer to a past date', async () => {
      const id = await seedAssigned();
      expect(await defer(id, YESTERDAY)).toMatchObject({ result: 'INVALID_DATE', field: 'deferredToDate' });
    });

    it('refuses a defer to a date that does not exist — never rolls it over into March', async () => {
      const id = await seedAssigned();
      expect(await defer(id, '2026-02-31')).toMatchObject({ result: 'INVALID_DATE', field: 'deferredToDate' });
    });

    it('control — a defer to tomorrow still commits, and both halves land', async () => {
      const id = await seedAssigned();

      expect(await defer(id, TOMORROW)).toMatchObject({ result: 'OK' });

      const row = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId, ticketId: id } });
      expect(row.removedAt).not.toBeNull();
      const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: id } });
      expect(t.assignmentState).toBe('UNASSIGNED');
      expect(ymd(t.deferredUntil!)).toBe(TOMORROW);
    });

    it('refuses a hold whose date would hold nothing, and holds one that would', async () => {
      const zmScope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
      const actor = { userId: randomUUID(), role: 'ZONAL_MANAGER', actedAsRole: null };

      expect(
        await preview.placeHold(holdableTicketId, istDate(NOW), 'ZM_HOLD', zmScope, actor),
      ).toMatchObject({ result: 'INVALID_DATE', field: 'heldUntil' });
      expect(
        (await prisma.ticket.findUniqueOrThrow({ where: { ticketId: holdableTicketId } })).deferredUntil,
      ).toBeNull();

      expect(
        await preview.placeHold(holdableTicketId, shiftDays(istDate(NOW), 1), 'ZM_HOLD', zmScope, actor),
      ).toMatchObject({ result: 'OK' });
    });

    it('and the service still owns the unknown-action refusal, on a batch that exists', async () => {
      const out = await override.override(
        batchId,
        { action: 'NOT_A_REAL_ACTION_FROM_THE_FUTURE' } as never,
        { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
        { userId: randomUUID(), role: 'ZONAL_MANAGER', actedAsRole: null },
        NOW,
      );
      expect(out).toMatchObject({ result: 'UNSUPPORTED_ACTION', action: 'NOT_A_REAL_ACTION_FROM_THE_FUTURE' });
    });

    it('400s a garbage defer date at the door, before any batch is read', async () => {
      await post(`batches/${MISSING_BATCH}/override`, {
        action: 'DEFER_TICKET',
        ticketId: TICKET,
        deferredToDate: 'next tuesday',
        reasonCode: 'X',
      }).expect(400);
    });

    it('400s a past-dated hold over the wire, naming the field', async () => {
      const res = await post('schedules/holds', {
        ticketId: holdableTicketId,
        heldUntil: YESTERDAY,
        reasonCode: 'ZM_HOLD',
      });
      expect(res.status).toBe(400);
      expect(String(JSON.stringify(res.body))).toContain('heldUntil');
    });
  });
});
