import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import type { ManagerScope } from '../common/manager-scope';
import type { RequestActor } from '../common/request-actor';
import { toBigIntId } from '../common/parse-id';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import type { AssignOutcome, OverrideOutcome } from './override.service';
import { SameDayUpdateService, type IntradayUpdateRow } from './same-day-update.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * The `/api/intraday-updates/*` ZM manual same-day surface (Issue 31). `GET` is the Intra-day Queue
 * read (MANUAL_ZM_UPDATE rows, zone-scoped); `add` / `remove` / `reorder` apply an immediate same-day
 * change to an SE's current Day Plan (no SE Acceptance) and log it to the queue. Distinct from the
 * system-triggered CRITICAL insertion (Issue 29). Manager-roled + zone-scoped by the service.
 */
@Controller('intraday-updates')
@UseGuards(AuthGuard, RoleGuard)
export class IntradayUpdatesController {
  constructor(private readonly sameDay: SameDayUpdateService) {}

  @Get()
  @Roles(...MANAGER_ROLES)
  list(@CurrentScope() scope: ManagerScope): Promise<IntradayUpdateRow[]> {
    return this.sameDay.listIntradayUpdates(scope);
  }

  @Post('add')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async add(
    @CurrentScope() scope: ManagerScope,
    @CurrentActor() actor: RequestActor,
    @Body() body: { ticketId: string; seId: string; confirm?: boolean; reasonCode?: string },
  ): Promise<AssignOutcome> {
    if (!body.ticketId || !body.seId) throw new BadRequestException({ code: 'TICKET_AND_SE_REQUIRED' });
    const out = await this.sameDay.addTicket(
      body.ticketId,
      body.seId,
      scope,
      actor,
      new Date(),
      { confirm: body?.confirm, reasonCode: body?.reasonCode },
    );
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_OR_SE_NOT_FOUND' });
    if (out.result === 'ALREADY_ASSIGNED') throw new ConflictException({ code: 'TICKET_ALREADY_ASSIGNED' });
    // #249 — same refusal and same vocabulary as `POST /schedules/assign`. Adding work mid-shift is
    // still creating a Formal Assignment, so a held ticket needs the same explicit decision here.
    if (out.result === 'CONFLICT_DEFERRED') {
      throw new ConflictException({
        code: 'CONFLICT_DEFERRED',
        message: 'Ticket is held to a future vehicle-return date — resend with confirm=true and a reason.',
        ticketId: out.ticketId,
        deferredUntil: out.deferredUntil,
        vuReport: out.vuReport,
      });
    }
    if (out.result === 'REASON_REQUIRED') {
      throw new BadRequestException({ code: 'DEFERRAL_OVERRIDE_REASON_REQUIRED' });
    }
    return out;
  }

  @Post('remove')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async remove(
    @CurrentScope() scope: ManagerScope,
    @CurrentActor() actor: RequestActor,
    @Body() body: { batchId: string; ticketId: string; reasonCode: string; confirm?: boolean },
  ): Promise<OverrideOutcome> {
    if (!body.batchId || !body.ticketId) throw new BadRequestException({ code: 'BATCH_AND_TICKET_REQUIRED' });
    if (!body.reasonCode) throw new BadRequestException({ code: 'REASON_REQUIRED' });
    // #310 (CB-9) — a batch id that is not a number names no batch. The presence checks above always
    // ran; the parse did not, so `{ batchId: 'abc' }` was a 500 rather than this file's own 404.
    const batchId = toBigIntId(body.batchId);
    if (batchId === null) throw new NotFoundException({ code: 'BATCH_OR_TICKET_NOT_FOUND' });
    const out = await this.sameDay.removeTicket(
      batchId,
      body.ticketId,
      body.reasonCode,
      body.confirm ?? false,
      scope,
      actor,
    );
    return this.mapOverride(out);
  }

  @Post('reorder')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async reorder(
    @CurrentScope() scope: ManagerScope,
    @CurrentActor() actor: RequestActor,
    @Body() body: { batchId: string; stopSequence: number; reasonCode: string },
  ): Promise<OverrideOutcome> {
    if (!body.batchId || body.stopSequence == null) throw new BadRequestException({ code: 'BATCH_AND_SEQUENCE_REQUIRED' });
    if (!body.reasonCode) throw new BadRequestException({ code: 'REASON_REQUIRED' });
    const batchId = toBigIntId(body.batchId);
    if (batchId === null) throw new NotFoundException({ code: 'BATCH_OR_TICKET_NOT_FOUND' });
    const out = await this.sameDay.reorder(
      batchId,
      body.stopSequence,
      body.reasonCode,
      scope,
      actor,
    );
    return this.mapOverride(out);
  }

  private mapOverride(out: OverrideOutcome): OverrideOutcome {
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'BATCH_OR_TICKET_NOT_FOUND' });
    if (out.result === 'CONFLICT_ON_SITE') {
      throw new ConflictException({
        code: 'UPDATE_ON_SITE_CONFLICT',
        message: 'SE holds ON_SITE on affected work — resend with confirm=true and a reason code.',
        ticketIds: out.ticketIds,
      });
    }
    // #249 — unreachable from `remove`/`reorder` (neither is a move action), mapped anyway: an
    // outcome variant returned as a 200 body because nobody translated it is the failure mode this
    // switch exists to prevent.
    if (out.result === 'CONFLICT_DEFERRED') {
      throw new ConflictException({
        code: 'CONFLICT_DEFERRED',
        message: 'Affected work is held to a future vehicle-return date — resend with confirm=true and a reason code.',
        ticketIds: out.ticketIds,
      });
    }
    return out;
  }
}
