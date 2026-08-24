import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { RoleGuard } from '../src/common/guards/role.guard';
import { BulkUnassignService } from '../src/scheduling/bulk-unassign.service';
import { DayPlanQueryService } from '../src/scheduling/day-plan-query.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { DispatchScheduleService } from '../src/scheduling/dispatch-schedule.service';
import { OverrideService } from '../src/scheduling/override.service';
import { AssignableWorkQueryService } from '../src/scheduling/assignable-work-query.service';
import { CandidateQueryService } from '../src/scheduling/candidate-query.service';
import { DistributeProjectionService } from '../src/scheduling/distribute-projection.service';
import { SchedulerPreviewService } from '../src/scheduling/scheduler-preview.service';
import { SchedulesController } from '../src/scheduling/schedules.controller';
import { ZmScheduleQueryService } from '../src/scheduling/zm-schedule-query.service';

describe('Schedules route matching (e2e)', () => {
  let app: INestApplication;
  const dayPlan = { getDayPlan: vi.fn() };
  const override = { assignTicket: vi.fn(), assignBatch: vi.fn() };
  const zm = {
    listSchedules: vi.fn(),
    listZoneEngineers: vi.fn(),
    getScheduleDetail: vi.fn(),
  };
  const dispatchSchedule = { current: vi.fn(), setCron: vi.fn() };
  const assignableWork = { listForScope: vi.fn(), ticketIdsForPlants: vi.fn() };
  const candidateQuery = { listForPlants: vi.fn() };
  const distribute = { project: vi.fn() };

  const authGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest();
      request.user = {
        user_id: '11111111-1111-1111-1111-111111111111',
        role: 'ZONAL_MANAGER',
        zone_id: 1,
      };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SchedulesController],
      providers: [
        { provide: DayPlanQueryService, useValue: dayPlan },
        { provide: OverrideService, useValue: override },
        { provide: ZmScheduleQueryService, useValue: zm },
        { provide: DispatchRunService, useValue: { runForActiveZones: vi.fn() } },
        { provide: BulkUnassignService, useValue: { preview: vi.fn(), execute: vi.fn() } },
        { provide: DispatchScheduleService, useValue: dispatchSchedule },
        // #251 — stubbed like the other collaborators: this spec pins *route matching*, so the
        // controller only has to construct. `preview` is the one route added below the param-route
        // boundary check, and it must resolve for the module to compile at all.
        {
          provide: SchedulerPreviewService,
          useValue: { preview: vi.fn(), placeHold: vi.fn(), releaseHold: vi.fn() },
        },
        // #273 — stubbed for the same reason as the rest: this spec pins *route matching*, so the
        // controller only has to construct. Adding a constructor dependency without adding it here
        // makes `beforeAll` throw, and vitest then reports the file as **4 skipped** rather than
        // failed — the suite stays green while this file silently contributes no coverage at all.
        // That is exactly how it went unnoticed for one run; see `docs/progress/273-…md`.
        { provide: AssignableWorkQueryService, useValue: assignableWork },
        // #274 — and the warning above was not hypothetical: this dependency was added to the
        // controller without being added here, `beforeAll` threw, and the file reported **5 skipped**
        // while the run summary said "1 failed" — a line easy to read as the known #184 worker crash.
        // It shipped. The route assertion below now exists so the file has something to fail *with*.
        { provide: CandidateQueryService, useValue: candidateQuery },
        // #276 — same trap, sixth time: a constructor dependency added to the controller without a
        // matching provider here throws in `beforeAll` and the file reports every test skipped rather
        // than failed, which reads as green from a distance.
        { provide: DistributeProjectionService, useValue: distribute },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue(authGuard)
      .overrideGuard(RoleGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  /** #213 — `dispatch-schedule` is a static path on a controller that also has `GET :engineerId`, so it
   *  is one `ParseUUIDPipe` away from being swallowed by the param route. Same trap `engineers` sits in. */
  it('routes GET /api/schedules/dispatch-schedule to the schedule handler, not :engineerId', async () => {
    dispatchSchedule.current.mockResolvedValue({
      cron: '0 5 * * *',
      timeZone: 'Asia/Kolkata',
      nextFireAt: '2026-08-04T23:30:00.000Z',
    });

    const res = await request(app.getHttpServer()).get('/api/schedules/dispatch-schedule').expect(200);

    expect(res.body.cron).toBe('0 5 * * *');
    expect(dispatchSchedule.current).toHaveBeenCalledTimes(1);
    expect(zm.getScheduleDetail).not.toHaveBeenCalled();
  });

  it('routes GET /api/schedules/engineers to the static engineers handler', async () => {
    zm.listZoneEngineers.mockResolvedValue([
      {
        engineerId: '22222222-2222-2222-2222-222222222222',
        coverageType: 'DEDICATED',
        zoneId: '1',
        dailyCapacity: 10,
        isActive: true,
      },
    ]);

    const res = await request(app.getHttpServer()).get('/api/schedules/engineers').expect(200);

    expect(res.body).toHaveLength(1);
    expect(zm.listZoneEngineers).toHaveBeenCalledWith({ role: 'ZONAL_MANAGER', zoneId: 1 });
    expect(zm.getScheduleDetail).not.toHaveBeenCalled();
  });

  /**
   * #273 — `assignable-work` is the third literal path on a controller that also has `GET :engineerId`.
   * It went in below the param route on the first attempt and every request came back **400** from
   * `ParseUUIDPipe`, which is the same trap `dispatch-schedule` and `engineers` sit in. Pinned here so
   * the ordering is a property of the suite rather than of whoever edits the controller next.
   */
  it('routes GET /api/schedules/assignable-work to the work-pool handler, not :engineerId', async () => {
    assignableWork.listForScope.mockResolvedValue({
      date: '2026-06-24',
      totals: { openUnassigned: 0, criticalCount: 0, heldCount: 0, plants: 0 },
      companies: [],
    });

    const res = await request(app.getHttpServer()).get('/api/schedules/assignable-work').expect(200);

    expect(res.body.companies).toEqual([]);
    expect(assignableWork.listForScope).toHaveBeenCalledTimes(1);
    expect(zm.getScheduleDetail).not.toHaveBeenCalled();
  });

  it('does not route arbitrary path words to the engineer detail handler', async () => {
    await request(app.getHttpServer()).get('/api/schedules/not-a-uuid').expect(400);

    expect(zm.listZoneEngineers).not.toHaveBeenCalled();
    expect(zm.getScheduleDetail).not.toHaveBeenCalled();
  });

  it('routes UUID-shaped schedule detail paths to the detail handler', async () => {
    const engineerId = '00000000-0000-0000-0000-0000000000ff';
    zm.getScheduleDetail.mockResolvedValue({
      scheduleId: '1',
      seId: engineerId,
      status: 'ACTIVE',
      dateFrom: '2026-06-24',
      dateTo: '2026-06-24',
      stops: [],
    });

    await request(app.getHttpServer()).get(`/api/schedules/${engineerId}`).expect(200);

    expect(zm.getScheduleDetail).toHaveBeenCalledWith(engineerId, { role: 'ZONAL_MANAGER', zoneId: 1 });
  });
  /**
   * #274 — `candidates` is the fourth literal path on a controller that also has `GET :engineerId`,
   * and it hit the identical `ParseUUIDPipe` 400 on its first attempt. Same trap, fourth time.
   */
  it('routes GET /api/schedules/candidates to the candidate handler, not :engineerId', async () => {
    candidateQuery.listForPlants.mockResolvedValue({ date: '2026-06-24', plants: [] });

    const res = await request(app.getHttpServer())
      .get('/api/schedules/candidates?plantIds=20,21')
      .expect(200);

    expect(res.body.plants).toEqual([]);
    expect(candidateQuery.listForPlants).toHaveBeenCalledTimes(1);
    // The ids arrive parsed, in order, as bigints — not as the raw query string.
    expect(candidateQuery.listForPlants.mock.calls[0][0]).toEqual([20n, 21n]);
    expect(zm.getScheduleDetail).not.toHaveBeenCalled();
  });

  /** #275 — `assignable-tickets` is the fifth literal path on a controller that also has `GET :engineerId`. */
  it('routes GET /api/schedules/assignable-tickets to the resolver handler, not :engineerId', async () => {
    assignableWork.ticketIdsForPlants.mockResolvedValue([{ plantId: '20', ticketIds: ['t1', 't2'] }]);

    const res = await request(app.getHttpServer())
      .get('/api/schedules/assignable-tickets?plantIds=20')
      .expect(200);

    expect(res.body).toEqual([{ plantId: '20', ticketIds: ['t1', 't2'] }]);
    expect(assignableWork.ticketIdsForPlants).toHaveBeenCalledTimes(1);
    expect(assignableWork.ticketIdsForPlants.mock.calls[0][1]).toEqual([20n]);
    expect(zm.getScheduleDetail).not.toHaveBeenCalled();
  });

  describe('#276 — POST /api/schedules/distribute-preview validation', () => {
    it('rejects a missing ticket/engineer selection or an unknown strategy', async () => {
      await request(app.getHttpServer())
        .post('/api/schedules/distribute-preview')
        .send({ engineerIds: ['se-1'], strategy: 'COVERAGE_TIER' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/schedules/distribute-preview')
        .send({ ticketIds: ['t-1'], strategy: 'COVERAGE_TIER' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/schedules/distribute-preview')
        .send({ ticketIds: ['t-1'], engineerIds: ['se-1'], strategy: 'MADE_UP' })
        .expect(400);
      expect(distribute.project).not.toHaveBeenCalled();
    });

    it('forwards a valid request to the service unchanged', async () => {
      distribute.project.mockResolvedValue({ strategy: 'COVERAGE_TIER', targetDate: '2026-06-24', lanes: [], unplaced: [], overCapacitySeIds: [] });

      const res = await request(app.getHttpServer())
        .post('/api/schedules/distribute-preview')
        .send({ ticketIds: ['t-1'], engineerIds: ['se-1'], strategy: 'COVERAGE_TIER' })
        .expect(200);

      expect(res.body.strategy).toBe('COVERAGE_TIER');
      expect(distribute.project).toHaveBeenCalledWith(
        ['t-1'],
        ['se-1'],
        'COVERAGE_TIER',
        { role: 'ZONAL_MANAGER', zoneId: 1 },
      );
    });
  });

  describe('#275 — POST /api/schedules/assign-batch validation', () => {
    it('rejects a missing or blank reasonCode', async () => {
      await request(app.getHttpServer())
        .post('/api/schedules/assign-batch')
        .send({ lanes: [{ seId: 'se-1', ticketIds: ['t1'] }] })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/schedules/assign-batch')
        .send({ reasonCode: '   ', lanes: [{ seId: 'se-1', ticketIds: ['t1'] }] })
        .expect(400);
      expect(override.assignBatch).not.toHaveBeenCalled();
    });

    it('rejects an empty or malformed lane list', async () => {
      await request(app.getHttpServer())
        .post('/api/schedules/assign-batch')
        .send({ reasonCode: 'why', lanes: [] })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/schedules/assign-batch')
        .send({ reasonCode: 'why', lanes: [{ seId: 'se-1', ticketIds: [] }] })
        .expect(400);
      expect(override.assignBatch).not.toHaveBeenCalled();
    });

    it('trims the reason and forwards the lanes unchanged to the service', async () => {
      override.assignBatch.mockResolvedValue({ lanes: [{ seId: 'se-1', result: 'OK', assigned: 1, alreadyAssigned: 0, skipped: [], batchIds: ['1'] }] });

      const res = await request(app.getHttpServer())
        .post('/api/schedules/assign-batch')
        .send({ reasonCode: '  why this plan  ', lanes: [{ seId: 'se-1', ticketIds: ['t1'] }] })
        .expect(200);

      expect(res.body.lanes[0]).toMatchObject({ seId: 'se-1', result: 'OK', assigned: 1 });
      // The actor is now the request's resolved `RequestActor` rather than a hand-built subset, so it
      // also carries `actingZone` — null here, because this request sends no `X-Acting-As-Zone`. The
      // attribution values themselves are unchanged for a non-acting caller, which is the guarantee
      // that made the change safe; `assign-batch-acting-scope.e2e-spec.ts` pins the acting case.
      expect(override.assignBatch).toHaveBeenCalledWith(
        [{ seId: 'se-1', ticketIds: ['t1'] }],
        'why this plan',
        { role: 'ZONAL_MANAGER', zoneId: 1 },
        {
          userId: '11111111-1111-1111-1111-111111111111',
          role: 'ZONAL_MANAGER',
          actedAsRole: null,
          actingZone: null,
        },
      );
    });
  });
});
