import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { RoleGuard } from '../src/common/guards/role.guard';
import { DayPlanQueryService } from '../src/scheduling/day-plan-query.service';
import { OverrideService } from '../src/scheduling/override.service';
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
});
