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
import { SchedulerPreviewService } from '../src/scheduling/scheduler-preview.service';
import { SchedulesController } from '../src/scheduling/schedules.controller';
import { ZmScheduleQueryService } from '../src/scheduling/zm-schedule-query.service';

describe('Schedules route matching (e2e)', () => {
  let app: INestApplication;
  const dayPlan = { getDayPlan: vi.fn() };
  const override = { assignTicket: vi.fn() };
  const zm = {
    listSchedules: vi.fn(),
    listZoneEngineers: vi.fn(),
    getScheduleDetail: vi.fn(),
  };
  const dispatchSchedule = { current: vi.fn(), setCron: vi.fn() };
  const assignableWork = { listForScope: vi.fn() };
  const candidateQuery = { listForPlants: vi.fn() };

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

});
