import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { istWindowStart } from '../common/ist-day';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { BadRequestException } from '@nestjs/common';
import {
  type BulkUnassignHistoryRow,
  type BulkUnassignRequest,
  type ExecuteOutcome,
  type PreviewResult,
  BulkUnassignService,
} from './bulk-unassign.service';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import type { RequestActor } from '../common/request-actor';
import { DayPlanQueryService, type DayPlanView } from './day-plan-query.service';
import { BUSINESS_TIMEZONE } from './dispatch-cron';
import { DispatchRunService, type DispatchInFlight, type DispatchRunSummary } from './dispatch-run.service';
import { DispatchScheduleService, type DispatchScheduleView } from './dispatch-schedule.service';
import {
  OverrideService,
  type AssignBatchLane,
  type AssignBatchResult,
  type AssignOutcome,
  type PlantAssignSummary,
} from './override.service';
import {
  SchedulerPreviewService,
  type HoldOutcome,
  type ReleaseOutcome,
  type SchedulerPreviewResult,
} from './scheduler-preview.service';
import {
  AssignableWorkQueryService,
  type AssignableWorkView,
} from './assignable-work-query.service';
import { CandidateQueryService, type CandidatesView } from './candidate-query.service';
import { DistributeProjectionService, type DistributeResult, type DistributeStrategy } from './distribute-projection.service';
import {
  ZmScheduleQueryService,
  type ZmScheduleDetail,
  type ZmScheduleRow,
  type ZoneEngineerRow,
} from './zm-schedule-query.service';

/**
 * The zone scope a `/schedules` request runs under, with acting folded in.
 *
 * A CSM / Operations Head acting in a zone (`X-Acting-As-Zone`) is read **and written** as that
 * zone's ZM. Before this there were two postures on one controller: the console's reads collapsed
 * (inline, four times over) while every write built its scope straight from the claims — so an
 * Operations Head acting in a zone saw that zone's pool and committed against a pan-India scope. On
 * the console specifically, the read and the write are two halves of one operator action, and they
 * cannot disagree about which zone the operator is standing in.
 *
 * **This can only ever narrow.** With no header it is byte-identical to the old expression; a ZM
 * cannot widen, because {@link RequestActor} only carries an `actingZone` for the two acting-capable
 * roles. No `@Roles()` guard changes, so no role gains reach it did not have.
 *
 * #239 owns replacing this with its shared `@CurrentScope()` decorator across every manager surface;
 * the semantics here are deliberately identical so that swap is a mechanical no-op. It is kept local
 * rather than imported so this slice carries no dependency on #239's own unlanded files.
 */
function scopeFor(user: AccessTokenClaims, actor: RequestActor): { role: string; zoneId: number | null } {
  return actor.actingZone !== null
    ? { role: 'ZONAL_MANAGER', zoneId: actor.actingZone }
    : { role: user.role, zoneId: user.zone_id };
}

/**
 * `?plantIds=1,2,3` → `bigint[]`. Deliberately lenient about junk: an unparseable id is dropped
 * rather than 400-ing the whole request, because the console asks for the plants it is showing and a
 * single bad id must not blank the column for the rest of them. Duplicates collapse.
 */
function parsePlantIds(raw: string | undefined): bigint[] {
  if (!raw) return [];
  const out: bigint[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const id = BigInt(trimmed);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

interface BulkUnassignRequestBody {
  mode: 'PREVIEW' | 'EXECUTE';
  scope: 'ZONE' | 'PAN_INDIA';
  zoneId?: number;
  reasonCode: string;
  previewToken?: string;
}

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * The refusal an operator reads (#213): *"dispatch already running for this zone, started HH:MM by X"*.
 * The time is rendered in `Asia/Kolkata` — the zone the person reading it is working in — because a UTC
 * stamp here would be read as a local one and quietly mislead by 5h30m.
 */
function describeDispatchConflict(inFlight: DispatchInFlight[]): string {
  const at = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: BUSINESS_TIMEZONE,
    }).format(new Date(iso));
  const one = (f: DispatchInFlight) => `zone ${f.zoneId}, started ${at(f.startedAt)} IST by ${f.actor}`;
  return inFlight.length === 1
    ? `dispatch already running for this zone (${one(inFlight[0])})`
    : `dispatch already running for this zone — ${inFlight.map(one).join('; ')}`;
}

/**
 * The `/api/schedules/*` surface. `me` (SE) returns the authenticated SE's dispatched Day Plan
 * (Issue 11). The manager-roled monitoring reads (Issue 13a) — the per-SE schedule list and the
 * ordered-stop detail with Recommender reasoning — are zone-scoped for a ZM; CSM / Operations Head
 * see all zones. `assign` is the Grouped Critical Work Queue one-click assign. Overrides go through
 * the batches controller.
 */
@Controller('schedules')
@UseGuards(AuthGuard, RoleGuard)
export class SchedulesController {
  constructor(
    private readonly dayPlan: DayPlanQueryService,
    private readonly zm: ZmScheduleQueryService,
    private readonly override: OverrideService,
    private readonly dispatchRun: DispatchRunService,
    private readonly bulkUnassign: BulkUnassignService,
    private readonly dispatchSchedule: DispatchScheduleService,
    private readonly schedulerPreview: SchedulerPreviewService,
    private readonly assignableWork: AssignableWorkQueryService,
    private readonly candidateQuery: CandidateQueryService,
    private readonly distribute: DistributeProjectionService,
  ) {}

  /**
   * #213 — the daily dispatch schedule, Operations-Head-owned. Declared before `:engineerId` so the
   * static path is not captured by the param route.
   *
   * This lives here rather than on the generic settings registry because writing it is not just storing
   * a value: the expression is validated with the same parser that will run it, and the live cron job is
   * re-registered so the change takes effect without a restart. `PUT /api/settings/dispatch_cron` is
   * refused and points here, so there is exactly one door.
   */
  @Get('dispatch-schedule')
  @Roles('OPERATIONS_HEAD')
  dispatchScheduleGet(): Promise<DispatchScheduleView> {
    return this.dispatchSchedule.current();
  }

  @Put('dispatch-schedule')
  @Roles('OPERATIONS_HEAD')
  async dispatchSchedulePut(
    @CurrentActor() actor: RequestActor,
    @Body() body: { cron?: unknown } = {},
  ): Promise<DispatchScheduleView> {
    const outcome = await this.dispatchSchedule.setCron(body?.cron, actor);
    // Rejected at write time, with the reason the parser gave — the previous schedule is untouched and
    // still firing, which is the guarantee that makes this safe to expose to an operator.
    if (outcome.result === 'INVALID') {
      throw new BadRequestException({ code: 'INVALID_CRON_EXPRESSION', reason: outcome.reason });
    }
    return outcome.schedule;
  }

  /**
   * Issue 113 — manual override for the daily Recommender → Day-Plan dispatch run: force a run now
   * without waiting for the cron. Reuses the exact `runForActiveZones` path the scheduler tick drives.
   * #179 slice 2 — optional `zoneId` narrows the run to a single zone (the bulk-unassign rebalance's
   * "Run dispatch" button, zone-scoped); omitted → every active zone, unchanged from before.
   */
  @Post('dispatch-run')
  @HttpCode(200)
  @Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER')
  async dispatchRunNow(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Body() body: { zoneId?: number; reason?: string } = {},
  ): Promise<DispatchRunSummary> {
    // MANUAL + actor land on the dispatch_runs ledger row and its audit bracket; #213 adds the
    // optional operator "why" beside them.
    const outcome = await this.dispatchRun.runForActiveZones(new Date(), {
      trigger: 'MANUAL',
      actorUserId: user.user_id,
      actorRole: user.role,
      zoneId: body.zoneId != null ? BigInt(body.zoneId) : undefined,
      reason: typeof body.reason === 'string' ? body.reason : null,
    });
    // #213 — a populated refusal, not a queued run, a silent no-op, or a bare 409: the operator is told
    // which zone, when the holding run started (in IST, the zone they work in) and who started it.
    if (outcome.result === 'CONFLICT') {
      throw new ConflictException({
        code: 'DISPATCH_ALREADY_RUNNING',
        message: describeDispatchConflict(outcome.inFlight),
        inFlight: outcome.inFlight,
      });
    }
    return outcome.summary;
  }

  /**
   * #213 — which zones currently have a run in flight, so admin can disable the Run-dispatch button and
   * show why *before* anyone presses it, rather than letting them discover the conflict by pressing
   * twice. Same role gate as the trigger it guards.
   *
   * #259 — the answer is now read from the claim ledger, so it is truthful about a run this instance
   * did not start and about one that was in flight across a restart. Same response shape.
   */
  @Get('dispatch-run/in-flight')
  @Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER')
  async dispatchInFlight(): Promise<{ inFlight: DispatchInFlight[] }> {
    return { inFlight: await this.dispatchRun.inFlightZones() };
  }

  /**
   * #179 — OH bulk unassign (zone / Pan-India), mid-day rebalance. OH-only (D6, #119 precedent) —
   * deliberately narrower than `dispatch-run`'s OH+CSM. `mode: PREVIEW` returns per-zone class
   * counts + a signed token; `mode: EXECUTE` performs the unassign (Pan-India requires the token).
   */
  @Post('bulk-unassign')
  @HttpCode(200)
  @Roles('OPERATIONS_HEAD')
  async bulkUnassignRoute(
    @CurrentUser() user: AccessTokenClaims,
    @Body() body: BulkUnassignRequestBody,
  ): Promise<PreviewResult | ExecuteOutcome> {
    if (body.scope === 'ZONE' && body.zoneId == null) throw new BadRequestException({ code: 'ZONE_ID_REQUIRED' });
    if (!body.reasonCode) throw new BadRequestException({ code: 'REASON_CODE_REQUIRED' });

    const req: BulkUnassignRequest = {
      scope: body.scope,
      zoneId: body.zoneId != null ? BigInt(body.zoneId) : undefined,
      reasonCode: body.reasonCode,
      previewToken: body.previewToken,
    };

    if (body.mode === 'PREVIEW') return this.bulkUnassign.preview(req);

    const outcome = await this.bulkUnassign.execute(req, { userId: user.user_id, role: user.role });
    if (outcome.result === 'TOKEN_REQUIRED') throw new ConflictException({ code: 'PREVIEW_TOKEN_REQUIRED' });
    if (outcome.result === 'TOKEN_INVALID') throw new ConflictException({ code: 'PREVIEW_TOKEN_INVALID' });
    if (outcome.result === 'TOKEN_STALE') throw new ConflictException({ code: 'PREVIEW_TOKEN_STALE', freshPreview: outcome.freshPreview });
    return outcome;
  }

  /** #179 slice 4 — the admin page's history list, `BULK_UNASSIGN_ZONE` audit rows newest first. */
  @Get('bulk-unassign/history')
  @Roles('OPERATIONS_HEAD')
  bulkUnassignHistory(): Promise<BulkUnassignHistoryRow[]> {
    return this.bulkUnassign.history();
  }

  /**
   * #251 — the Scheduler Preview: what the next run would do for an IST calendar date.
   *
   * Declared before `:engineerId` so the static path is not captured by the param route — the same
   * ordering constraint `dispatch-schedule` and `bulk-unassign/history` above are placed for, and the
   * one `schedules-route-conflicts.e2e-spec.ts` pins.
   *
   * Writes nothing: it runs the real recommender with #250's dry-run flag, which is count-pinned to
   * write zero rows. Read scope is server-side — ZM sees their own zone, CSM/OH every active zone.
   */
  @Get('preview')
  @Roles(...MANAGER_ROLES)
  schedulerPreviewGet(
    @CurrentUser() user: AccessTokenClaims,
    @Query('date') date?: string,
  ): Promise<SchedulerPreviewResult> {
    // A bare `YYYY-MM-DD` means an IST calendar day; `istWindowStart` is the one parser for that, and
    // it returns Invalid Date rather than rolling a nonexistent date over silently.
    const target = date ? istWindowStart(date) : new Date();
    if (Number.isNaN(target.getTime())) {
      throw new BadRequestException({ code: 'INVALID_DATE', message: 'date must be YYYY-MM-DD.' });
    }
    return this.schedulerPreview.preview(target, { role: user.role, zoneId: user.zone_id });
  }

  /**
   * #251 — hold an OPEN + UNASSIGNED ticket out of the runs before `heldUntil`.
   *
   * The one genuinely new write path in this slice: the existing hold writer (`DEFER_TICKET`) needs a
   * live batch row, so an undispatched ticket could not be held at all before now. `heldUntil` is the
   * day the ticket **returns** — `notDeferredOn` is inclusive — so holding it off tomorrow means
   * naming the day after.
   */
  @Post('holds')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async placeHold(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Body() body: { ticketId?: string; heldUntil?: string; reasonCode?: string; confirm?: boolean },
  ): Promise<HoldOutcome> {
    if (!body?.ticketId || !body?.heldUntil || !body?.reasonCode?.trim()) {
      throw new BadRequestException({ code: 'INVALID_HOLD', message: 'ticketId, heldUntil and reasonCode are required.' });
    }
    const heldUntil = istWindowStart(body.heldUntil);
    if (Number.isNaN(heldUntil.getTime())) {
      throw new BadRequestException({ code: 'INVALID_DATE', message: 'heldUntil must be YYYY-MM-DD.' });
    }

    const outcome = await this.schedulerPreview.placeHold(
      body.ticketId,
      heldUntil,
      body.reasonCode.trim(),
      scopeFor(user, actor),
      actor,
      { confirm: body.confirm === true },
    );
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    // Returned as a 409 body rather than thrown away: the client needs the return-date context to
    // show the operator what they would be overwriting before offering the confirm.
    if (outcome.result === 'NOT_HOLDABLE') throw new ConflictException({ code: 'TICKET_NOT_HOLDABLE', ...outcome });
    if (outcome.result === 'CONFLICT_VEHICLE_UNAVAILABLE') {
      throw new ConflictException({ code: 'CONFLICT_VEHICLE_UNAVAILABLE', ...outcome });
    }
    return outcome;
  }

  /** #251 — release a hold; the ticket re-enters the very next run. */
  @Post('holds/release')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async releaseHold(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Body() body: { ticketId?: string },
  ): Promise<ReleaseOutcome> {
    if (!body?.ticketId) throw new BadRequestException({ code: 'INVALID_RELEASE', message: 'ticketId is required.' });
    const outcome = await this.schedulerPreview.releaseHold(
      body.ticketId,
      scopeFor(user, actor),
      actor,
    );
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    return outcome;
  }

  @Get('me')
  @Roles('SERVICE_ENGINEER')
  me(@CurrentUser() user: AccessTokenClaims): Promise<DayPlanView> {
    return this.dayPlan.getDayPlan(user.user_id);
  }

  @Post('assign')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async assign(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Body() body: { ticketId: string; seId: string; confirm?: boolean; reasonCode?: string },
  ): Promise<AssignOutcome> {
    const outcome = await this.override.assignTicket(
      body.ticketId,
      body.seId,
      scopeFor(user, actor),
      actor,
      new Date(),
      'CRITICAL_ASSIGN',
      false,
      { confirm: body?.confirm, reasonCode: body?.reasonCode },
    );
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_OR_SE_NOT_FOUND' });
    if (outcome.result === 'ALREADY_ASSIGNED') throw new ConflictException({ code: 'TICKET_ALREADY_ASSIGNED' });
    // #249 — the ticket is held to a future vehicle-return date. A business 409 carrying the dates the
    // confirm dialog has to show, mirroring the ON_SITE conflict the client already knows how to answer.
    if (outcome.result === 'CONFLICT_DEFERRED') {
      throw new ConflictException({
        code: 'CONFLICT_DEFERRED',
        message: 'Ticket is held to a future vehicle-return date — resend with confirm=true and a reason.',
        ticketId: outcome.ticketId,
        deferredUntil: outcome.deferredUntil,
        vuReport: outcome.vuReport,
      });
    }
    if (outcome.result === 'REASON_REQUIRED') {
      throw new BadRequestException({ code: 'DEFERRAL_OVERRIDE_REASON_REQUIRED' });
    }
    return outcome;
  }

  /**
   * Manual multi-plant SE assignment (Issue 122b, driven from the Device Detail page): assigns every
   * OPEN + UNASSIGNED ticket at the selected plants to the SE via the same assignTicket primitive.
   */
  @Post('assign-plants')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async assignPlants(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Body() body: { seId: string; plantIds: string[] },
  ): Promise<PlantAssignSummary> {
    if (!body?.seId || !Array.isArray(body.plantIds) || body.plantIds.length === 0)
      throw new BadRequestException({ code: 'SE_AND_PLANTS_REQUIRED' });
    const outcome = await this.override.assignPlants(
      body.plantIds.map(String),
      body.seId,
      scopeFor(user, actor),
      actor,
    );
    if ('result' in outcome) throw new NotFoundException({ code: 'SE_NOT_FOUND' });
    return outcome;
  }

  /**
   * #275 — the Assign Work Console's review-and-commit write. One transaction per engineer lane, one
   * result row per lane; `assignPlants` above is now a shorthand over this same primitive. `reasonCode`
   * is mandatory — it is the one thing a manual multi-engineer plan must always be able to answer
   * ("why"), recorded once per lane regardless of how many tickets it touches or how many were skipped.
   */
  @Post('assign-batch')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async assignBatchRoute(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Body() body: { reasonCode?: string; lanes?: AssignBatchLane[] },
  ): Promise<AssignBatchResult> {
    if (!body?.reasonCode || body.reasonCode.trim() === '')
      throw new BadRequestException({ code: 'REASON_REQUIRED' });
    if (!Array.isArray(body.lanes) || body.lanes.length === 0)
      throw new BadRequestException({ code: 'LANES_REQUIRED' });
    for (const lane of body.lanes) {
      if (!lane?.seId || !Array.isArray(lane.ticketIds) || lane.ticketIds.length === 0)
        throw new BadRequestException({ code: 'LANE_SE_AND_TICKETS_REQUIRED' });
    }
    return this.override.assignBatch(
      body.lanes,
      body.reasonCode.trim(),
      scopeFor(user, actor),
      actor,
    );
  }

  /**
   * #284 §D — `?date=YYYY-MM-DD` narrows to the plans covering that IST operating day.
   *
   * **Additive**: no parameter is the all-live list this route has always returned, because callers
   * depend on it (AC10). The page that says "today" is the one that passes the parameter — a default
   * of today would silently narrow every existing caller, which is a behaviour change dressed as a fix.
   * Same `INVALID_DATE` shape and the same `istWindowStart` parser as `GET /schedules/preview`.
   */
  @Get()
  @Roles(...MANAGER_ROLES)
  list(@CurrentUser() user: AccessTokenClaims, @Query('date') date?: string): Promise<ZmScheduleRow[]> {
    if (date != null && date !== '') {
      const target = istWindowStart(date);
      if (Number.isNaN(target.getTime())) {
        throw new BadRequestException({ code: 'INVALID_DATE', message: 'date must be YYYY-MM-DD.' });
      }
      return this.zm.listSchedules({ role: user.role, zoneId: user.zone_id }, { date: target });
    }
    return this.zm.listSchedules({ role: user.role, zoneId: user.zone_id });
  }

  // Static route — must be declared before `:engineerId` so it is not captured as a param.
  @Get('engineers')
  @Roles(...MANAGER_ROLES)
  zoneEngineers(@CurrentUser() user: AccessTokenClaims): Promise<ZoneEngineerRow[]> {
    return this.zm.listZoneEngineers({ role: user.role, zoneId: user.zone_id });
  }

  /**
   * #273 — the Assign Work Console's work pool: company → plant, with the counts a dispatcher needs
   * *before* choosing anything. Built on the one `assignableTickets` predicate `assignPlants` writes
   * through, so the number shown is the number the commit will move.
   *
   * **Acting-zone is honoured here rather than deferred to #239.** Every sibling read on this
   * controller builds its scope straight off the claims, which structurally cannot carry acting — so
   * an Operations Head acting in a zone would open the console and be handed the pan-India pool. That
   * is not a cosmetic mismatch on a screen whose entire purpose is "what is left in *this* zone", so
   * the collapse is applied inline, from the committed `RequestActor` the controller already resolves.
   * #239 owns converting the rest of `/schedules` and will replace this with its shared `@CurrentScope()`
   * helper; the behaviour is deliberately identical so that swap is a one-line no-op.
   */
  @Get('assignable-work')
  @Roles(...MANAGER_ROLES)
  assignableWorkPool(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
  ): Promise<AssignableWorkView> {
    const scope = scopeFor(user, actor);
    return this.assignableWork.listForScope(scope);
  }

  /**
   * #274 — the Assign Work Console's candidate column: for each requested plant, the engine's own
   * ordered candidate list. Same acting-zone collapse and same reason as the pool above; the two reads
   * feed one screen and must be scoped identically or the column offers engineers for work the pool
   * never showed.
   */
  @Get('candidates')
  @Roles(...MANAGER_ROLES)
  candidates(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Query('plantIds') plantIds?: string,
  ): Promise<CandidatesView> {
    const scope = scopeFor(user, actor);
    return this.candidateQuery.listForPlants(parsePlantIds(plantIds), scope);
  }

  /**
   * #275 — resolve the console's plant-shaped draft into the ticket ids `assign-batch` needs, right
   * before the review screen shows a diff. Same predicate as the work pool and `assignPlants`, so the
   * ids resolved here are exactly the tickets a commit will move — never a second count to disagree
   * with the one already on screen.
   */
  @Get('assignable-tickets')
  @Roles(...MANAGER_ROLES)
  assignableTicketIds(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Query('plantIds') plantIds?: string,
  ): Promise<{ plantId: string; ticketIds: string[] }[]> {
    const scope = scopeFor(user, actor);
    return this.assignableWork.ticketIdsForPlants(scope, parsePlantIds(plantIds));
  }

  /**
   * #276 — Distribute: several plants across several engineers, projected before anything enters the
   * draft. RBAC is #272 open question 3, ruled 2026-08-24 (operator): all managers, the same
   * `MANAGER_ROLES` ladder as the console's own draft/commit — not the narrower `dispatch-run` ladder
   * the issue text raised as the closer precedent.
   */
  @Post('distribute-preview')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  distributePreview(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Body() body: { ticketIds?: string[]; engineerIds?: string[]; strategy?: DistributeStrategy },
  ): Promise<DistributeResult> {
    if (!Array.isArray(body?.ticketIds) || body.ticketIds.length === 0)
      throw new BadRequestException({ code: 'TICKET_IDS_REQUIRED' });
    if (!Array.isArray(body?.engineerIds) || body.engineerIds.length === 0)
      throw new BadRequestException({ code: 'ENGINEER_IDS_REQUIRED' });
    if (!['COVERAGE_TIER', 'CAPACITY_HEADROOM', 'PLANT_WHOLE'].includes(body.strategy as string))
      throw new BadRequestException({ code: 'STRATEGY_REQUIRED' });
    const scope = scopeFor(user, actor);
    return this.distribute.project(body.ticketIds, body.engineerIds, body.strategy!, scope);
  }

  @Get(':engineerId')
  @Roles(...MANAGER_ROLES)
  async detail(
    @CurrentUser() user: AccessTokenClaims,
    @Param('engineerId', new ParseUUIDPipe()) engineerId: string,
  ): Promise<ZmScheduleDetail> {
    const detail = await this.zm.getScheduleDetail(engineerId, { role: user.role, zoneId: user.zone_id });
    if (!detail) throw new NotFoundException({ code: 'SCHEDULE_NOT_FOUND' });
    return detail;
  }
}
