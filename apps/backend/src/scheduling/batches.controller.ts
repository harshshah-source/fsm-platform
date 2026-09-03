import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import type { RequestActor } from '../common/request-actor';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { ManagerScope } from '../common/manager-scope';
import { toBigIntId } from '../common/parse-id';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { DispatchTransparencyQueryService, type DispatchBatchDetail } from './dispatch-transparency-query.service';
import { OverrideProjectionService, type OverrideImpact } from './override-projection.service';
import { asOverrideCommand, OverrideCommandDto } from './dto/override-command.dto';
import { OverrideService, type OverrideOutcome } from './override.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * The `/api/batches/*` surface. The ZM override endpoint (Issue 13a, LLD §5.4) dispatches every
 * override action to the engine; each commits immediately and flips the batch to OVERRIDDEN. The
 * transparency read (Issue 123) resolves a batch BY ITS OWN ID — the run is derived, not required,
 * because most live batches have no `run_id` at all. Both are manager-roled and zone-scoped (a ZM
 * gets NOT_FOUND for an out-of-zone batch).
 *
 * ## #239 (Console scope) — why all three reads/writes here take `@CurrentScope()`
 *
 * These three hand-built their scope from the claims, which structurally cannot carry
 * `X-Acting-As-Zone`. Across separate pages that was confusing. On the Scheduler Console it is
 * **incorrect**: the deck, the candidate column and the target-SE picker are all acting-clamped, and
 * an override committed pan-India beside them would let a CSM acting in one zone move work in another
 * from a screen that never showed it — and record an audit row that cannot say they were acting.
 *
 * The judgement #239 asks for, made explicitly rather than swept: **acting narrows, and narrowing a
 * write can only reduce reach.** A CSM acting as zone 7 who genuinely needs to override in zone 9 stops
 * acting first, which is the same thing every read on this product already requires of them. Audit
 * attribution is unaffected — that has always come from `RequestActor`, not from this scope.
 */
@Controller('batches')
@UseGuards(AuthGuard, RoleGuard)
export class BatchesController {
  constructor(
    private readonly override: OverrideService,
    private readonly query: DispatchTransparencyQueryService,
    private readonly projection: OverrideProjectionService,
  ) {}

  @Get(':batchId')
  @Roles(...MANAGER_ROLES)
  async batchDetail(
    @CurrentScope() scope: ManagerScope,
    @Param('batchId') batchId: string,
  ): Promise<DispatchBatchDetail> {
    const id = toBigIntId(batchId);
    if (id === null) throw new NotFoundException({ code: 'DISPATCH_BATCH_NOT_FOUND' });
    const detail = await this.query.getBatchDetail(id, scope);
    if (!detail) throw new NotFoundException({ code: 'DISPATCH_BATCH_NOT_FOUND' });
    return detail;
  }

  /**
   * #289 — what the proposed override would do, before it is done (design step 3, #282 R1).
   *
   * The **same body** the confirm takes, so the preview and the write cannot drift apart into two
   * vocabularies: an operator previews `{action, ticketId, newSeId, reasonCode}` and confirms the
   * identical object. A `POST` because the body is a command, not because anything is written —
   * `OverrideProjectionService` contains no mutation at all, pinned by a spec that counts rows across
   * every table a real move touches.
   *
   * An action with only one lane (REMOVE / DEFER / REORDER) is **refused**, not answered with an empty
   * impact: "both lanes' capacity" has no meaning there, and zeros would read as "this move costs
   * nothing".
   */
  @Post(':id/override/preview')
  @HttpCode(200)
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  async previewOverride(
    @CurrentScope() scope: ManagerScope,
    @Param('id') id: string,
    @Body() body: OverrideCommandDto,
  ): Promise<OverrideImpact> {
    const batchId = toBigIntId(id);
    if (batchId === null) throw new NotFoundException({ code: 'BATCH_NOT_FOUND' });
    // The preview must resolve under **exactly** the scope the commit will use, or an operator can be
    // shown an impact for a move the write then refuses.
    const impact = await this.projection.projectOverride(batchId, asOverrideCommand(body), scope);
    if (impact.result === 'NOT_FOUND') throw new NotFoundException({ code: 'BATCH_NOT_FOUND' });
    if (impact.result === 'NOT_PROJECTABLE') {
      throw new BadRequestException({
        code: 'NOT_PROJECTABLE',
        message: `${impact.action} moves no work between engineers — there is no two-lane impact to preview.`,
      });
    }
    return impact;
  }

  @Post(':id/override')
  @HttpCode(200)
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  async overrideBatch(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @CurrentScope() scope: ManagerScope,
    @Param('id') id: string,
    @Body() body: OverrideCommandDto,
  ): Promise<OverrideOutcome> {
    // #310 (CB-9) — the sibling handlers above have always wrapped this; only the write door did not,
    // so `POST /batches/abc/override` was a 500 on input the caller types.
    const batchId = toBigIntId(id);
    if (batchId === null) throw new NotFoundException({ code: 'BATCH_NOT_FOUND' });
    const outcome = await this.override.override(
      batchId,
      asOverrideCommand(body),
      scope,
      // `actedAsRole` was hard-coded null here, so an override committed by an acting CSM recorded as
      // an ordinary CSM action and the acting was lost from the ticket's history. `RequestActor`
      // already resolves it for every other audited write; this one simply never asked.
      //
      // #340 — and it is passed whole. Re-copying two of its fields dropped `actingZone`, so the row
      // named the acting role but not the zone, and the one reader of that pair (the CSM-backup-share
      // report) still could not see it.
      actor,
    );
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'BATCH_NOT_FOUND' });
    if (outcome.result === 'CONFLICT_ON_SITE') {
      throw new ConflictException({
        code: 'OVERRIDE_ON_SITE_CONFLICT',
        message: 'SE holds ON_SITE on affected work — resend with confirm=true and a reason code.',
        ticketIds: outcome.ticketIds,
      });
    }
    // #249 — mirrors the ON_SITE mapping exactly, deliberately: one confirm vocabulary for every
    // override, so a client that already handles one handles the other without new machinery.
    if (outcome.result === 'CONFLICT_DEFERRED') {
      throw new ConflictException({
        code: 'CONFLICT_DEFERRED',
        message: 'Affected work is held to a future vehicle-return date — resend with confirm=true and a reason code.',
        ticketIds: outcome.ticketIds,
      });
    }
    // A 400, not a 409: there is no `confirm` that makes this legal. A day that has already been
    // cannot be planned into, so the client's job is to pick another date, not to insist.
    // 501-shaped in meaning but 400 in code, deliberately: the request is well-formed HTTP that this
    // build cannot honour, and a client that sees 400 + a code retries nothing, which is right.
    if (outcome.result === 'UNSUPPORTED_ACTION') {
      throw new BadRequestException({
        code: 'UNSUPPORTED_ACTION',
        message: `This server does not support the override action "${outcome.action}". The admin app may be newer than the API — reload after the next backend deploy.`,
        action: outcome.action,
      });
    }
    // #310 — the defer twin of `TARGET_DATE_IN_PAST`, and a 400 for the same reason: no `confirm`
    // makes a date that holds nothing hold something. Named separately because the rule differs —
    // a move onto today is legal, a defer to today is not.
    if (outcome.result === 'INVALID_DATE') {
      throw new BadRequestException({
        code: 'INVALID_DATE',
        message: `${outcome.field} must be a future IST day — ${outcome.value} is not after today (${outcome.today}). A deferral names the day the work comes back, and today's runs would pick it up again immediately.`,
        field: outcome.field,
      });
    }
    if (outcome.result === 'TARGET_DATE_IN_PAST') {
      throw new BadRequestException({
        code: 'TARGET_DATE_IN_PAST',
        message: `Cannot move work to ${outcome.targetDate} — that operating day has already passed (today is ${outcome.today}).`,
        targetDate: outcome.targetDate,
        today: outcome.today,
      });
    }
    return outcome;
  }
}
