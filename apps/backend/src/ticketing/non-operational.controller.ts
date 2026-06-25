import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import type { RequestActor } from '../common/request-actor';
import { type NonOpReason } from '../generated/prisma/enums';
import {
  type NonOpMarkingView,
  type NonOpQueueRow,
  NonOperationalService,
} from './non-operational.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;
const REASONS: readonly NonOpReason[] = [
  'VEHICLE_SCRAPPED',
  'VEHICLE_SOLD',
  'VEHICLE_ACCIDENT',
  'COMPANY_PAUSED',
  'DEVICE_REPLACEMENT_PENDING',
  'COMPLIANCE_HOLD',
  'OTHER',
];

interface RequestBody {
  deviceId: string;
  reasonCode: NonOpReason;
  reasonText?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

/** JSON-safe marking view (BigInt deviceId → string; dates serialise as ISO via JSON). */
interface MarkingDto extends Omit<NonOpMarkingView, 'deviceId'> {
  deviceId: string;
}
interface QueueDto extends Omit<NonOpQueueRow, 'deviceId'> {
  deviceId: string;
}

/**
 * Non-Operational dual-confirmation surface (Issue 35, `/api/non-op`). Managers request a marking and
 * perform the manager confirmation leg; Operations Head can override-confirm after 7 days. Uses
 * `@CurrentActor()` so a CSM/Operations-Head acting in a ZM's zone has `acted_as_role` audited (#47).
 */
@Controller('non-op')
@UseGuards(AuthGuard, RoleGuard)
export class NonOperationalController {
  constructor(private readonly nonOp: NonOperationalService) {}

  @Post()
  @Roles(...MANAGER_ROLES)
  async request(@CurrentActor() actor: RequestActor, @Body() body: RequestBody): Promise<MarkingDto> {
    const deviceId = parseDeviceId(body.deviceId);
    if (!REASONS.includes(body.reasonCode)) throw new BadRequestException({ code: 'INVALID_REASON' });
    const effectiveFrom = parseDate(body.effectiveFrom, 'INVALID_EFFECTIVE_FROM');
    const effectiveTo = parseDate(body.effectiveTo, 'INVALID_EFFECTIVE_TO');

    const out = await this.nonOp.requestMarking(
      { deviceId, reasonCode: body.reasonCode, reasonText: body.reasonText ?? null, effectiveFrom, effectiveTo },
      actor,
    );
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'DEVICE_NOT_FOUND' });
    if (out.result === 'INVALID_REASON_TEXT') throw new BadRequestException({ code: 'REASON_TEXT_REQUIRED' });
    if (out.result === 'CONFLICT') throw new ConflictException({ code: 'ACTIVE_MARKING_EXISTS' });
    return toMarkingDto(out.marking);
  }

  @Get('queue')
  @Roles(...MANAGER_ROLES)
  async queue(): Promise<QueueDto[]> {
    const rows = await this.nonOp.queue();
    return rows.map((r) => ({ ...r, deviceId: String(r.deviceId) }));
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async confirm(@CurrentActor() actor: RequestActor, @Param('id') id: string): Promise<MarkingDto> {
    const out = await this.nonOp.confirmByManager(id, actor);
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'MARKING_NOT_FOUND' });
    if (out.result === 'FORBIDDEN') throw new ForbiddenException({ code: 'CONFIRM_FORBIDDEN' });
    if (out.result === 'ALREADY') throw new ConflictException({ code: 'NOT_AWAITING' });
    return toMarkingDto(out.marking);
  }

  @Post(':id/override-confirm')
  @HttpCode(200)
  @Roles('OPERATIONS_HEAD')
  async override(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ): Promise<MarkingDto> {
    const out = await this.nonOp.overrideConfirm(id, actor, body.reason ?? '');
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'MARKING_NOT_FOUND' });
    if (out.result === 'FORBIDDEN') throw new ForbiddenException({ code: 'OVERRIDE_FORBIDDEN' });
    if (out.result === 'ALREADY') throw new ConflictException({ code: 'NOT_AWAITING' });
    if (out.result === 'REASON_REQUIRED') throw new BadRequestException({ code: 'OVERRIDE_REASON_REQUIRED' });
    if (out.result === 'TOO_EARLY') throw new ConflictException({ code: 'OVERRIDE_TOO_EARLY' });
    return toMarkingDto(out.marking);
  }
}

/**
 * Public customer-confirmation link (Issue 35 AC#6). The customer clicks the one-time tokenised email
 * link — no auth — to confirm the marking. Deliberately outside the guarded controller.
 */
@Controller('non-op')
export class NonOperationalPublicController {
  constructor(private readonly nonOp: NonOperationalService) {}

  @Get('confirm')
  async confirmByToken(@Query('token') token?: string): Promise<{ confirmed: true }> {
    if (!token) throw new BadRequestException({ code: 'TOKEN_REQUIRED' });
    const out = await this.nonOp.confirmByCustomerToken(token);
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'TOKEN_NOT_FOUND' });
    if (out.result === 'EXPIRED') throw new GoneException({ code: 'TOKEN_EXPIRED' });
    if (out.result === 'ALREADY') throw new ConflictException({ code: 'NOT_AWAITING' });
    return { confirmed: true };
  }
}

function parseDeviceId(raw: string): bigint {
  if (raw === undefined || raw === null || !/^\d+$/.test(String(raw))) {
    throw new BadRequestException({ code: 'INVALID_DEVICE_ID' });
  }
  return BigInt(raw);
}

function parseDate(raw: string | null | undefined, code: string): Date | undefined {
  if (raw == null || raw === '') return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new BadRequestException({ code });
  return d;
}

function toMarkingDto(marking: NonOpMarkingView): MarkingDto {
  return { ...marking, deviceId: String(marking.deviceId) };
}
