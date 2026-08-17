import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import type { RequestActor } from '../common/request-actor';
import {
  AssignmentThresholdService,
  type AssignmentThresholdView,
  type ThresholdWriteOutcome,
} from './assignment-threshold.service';

interface SetThresholdBody {
  hours?: unknown;
  reason?: unknown;
}

interface LockBody {
  reason?: unknown;
}

interface RevertBody {
  changeId?: unknown;
  reason?: unknown;
}

const trimmedReason = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t === '' ? null : t.slice(0, 500);
};

/**
 * #238 — `/api/settings/assignment-threshold`, the governed surface for "how long a device must be
 * silent before it becomes work for an SE".
 *
 * It is a controller of its own rather than another key under the OH-only `SettingsController`
 * because its authority model differs from the rest of the registry: **read and set** are open to the
 * Operations Head *and* the CSM, while **lock, unlock and revert** are the Operations Head's alone.
 * Expressing that with route-level `@Roles` here keeps the whole authority story readable in one
 * file, and leaves `PUT /api/settings/:key` free to keep refusing this key outright (it is listed in
 * `SPECIALISED_SETTING_WRITERS`, the same guard `dispatch_cron` uses).
 *
 * The ZM can **read** but never write. Reading is necessary — the ZM's ticket queue badges the work
 * auto-dispatch is holding back, and a badge whose threshold the page cannot fetch is not a badge.
 * Writing is withheld for the reason set out in
 * `docs/proposals/zone-engine-customization-2026-07-21.md` §3.1: the ZM is the graded party, and a
 * threshold that moves dispatch volume moves the numbers they are graded on. `view()` returns
 * `canEdit: false` for them, so the UI renders the same control read-only rather than hiding it —
 * seeing the policy you work under is not the same as setting it.
 */
@Controller('settings/assignment-threshold')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER')
export class AssignmentThresholdController {
  constructor(private readonly thresholds: AssignmentThresholdService) {}

  @Get()
  @Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER', 'ZONAL_MANAGER')
  get(@CurrentActor() actor: RequestActor): Promise<AssignmentThresholdView> {
    return this.thresholds.view(actor);
  }

  /** Set the threshold. CSM is refused while the key is locked — with the lock's reason, not a bare 403. */
  @Put()
  async set(
    @Body() body: SetThresholdBody = {},
    @CurrentActor() actor: RequestActor,
  ): Promise<AssignmentThresholdView> {
    return this.unwrap(await this.thresholds.set(body?.hours, trimmedReason(body?.reason), actor));
  }

  @Post('lock')
  @Roles('OPERATIONS_HEAD')
  async lock(@Body() body: LockBody = {}, @CurrentActor() actor: RequestActor): Promise<AssignmentThresholdView> {
    return this.unwrap(await this.thresholds.setLock(true, trimmedReason(body?.reason), actor));
  }

  @Delete('lock')
  @Roles('OPERATIONS_HEAD')
  async unlock(@Body() body: LockBody = {}, @CurrentActor() actor: RequestActor): Promise<AssignmentThresholdView> {
    return this.unwrap(await this.thresholds.setLock(false, trimmedReason(body?.reason), actor));
  }

  /** Restore the value a past change recorded. Operations-Head only — a revert is an overrule. */
  @Post('revert')
  @Roles('OPERATIONS_HEAD')
  async revert(@Body() body: RevertBody = {}, @CurrentActor() actor: RequestActor): Promise<AssignmentThresholdView> {
    return this.unwrap(await this.thresholds.revert(body?.changeId, trimmedReason(body?.reason), actor));
  }

  /** One place the service's outcome union becomes an HTTP status, so every route refuses alike. */
  private unwrap(outcome: ThresholdWriteOutcome): AssignmentThresholdView {
    switch (outcome.result) {
      case 'OK':
        return outcome.view;
      case 'INVALID':
        throw new BadRequestException({ code: 'INVALID_ASSIGNMENT_THRESHOLD', reason: outcome.reason });
      case 'NOT_FOUND':
        throw new NotFoundException({ code: 'THRESHOLD_CHANGE_NOT_FOUND', reason: outcome.reason });
      case 'FORBIDDEN':
        throw new ForbiddenException({ code: outcome.code, reason: outcome.reason });
    }
  }
}
