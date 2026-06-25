import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import type { RequestActor } from '../common/request-actor';
import { type UnableToCollectReason } from '../generated/prisma/enums';
import { type RecoveryOutcome, type RecoveryView, RecoveryService } from './recovery.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;
const UNABLE_REASONS: readonly UnableToCollectReason[] = ['COMPANY_REFUSED', 'VEHICLE_UNREACHABLE', 'DEVICE_MISSING', 'OTHER'];

/** JSON-safe recovery view (BigInt deviceId → string). */
interface RecoveryDto extends Omit<RecoveryView, 'deviceId'> {
  deviceId: string;
}

/**
 * Recovery Ticket field-workflow surface (Issue 36, `/api/recovery`). Managers schedule (dispatch) a
 * recovery to an SE; the assigned SE drives on-site → collected (Collection Form) or reports
 * unable-to-collect; the Warehouse Manager confirms receipt (auto-close). Uses `@CurrentActor()` so
 * acting attribution is audited (#47). The ZM decision queue read is exposed here; its actions land
 * with Issue 37.
 */
@Controller('recovery')
@UseGuards(AuthGuard, RoleGuard)
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  @Post(':id/schedule')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async schedule(@CurrentActor() actor: RequestActor, @Param('id') id: string, @Body() body: { seId?: string }): Promise<RecoveryDto> {
    if (!body.seId) throw new BadRequestException({ code: 'SE_ID_REQUIRED' });
    return this.map(await this.recovery.scheduleRecovery(id, body.seId, actor));
  }

  @Post(':id/on-site')
  @HttpCode(200)
  @Roles('SERVICE_ENGINEER')
  async onSite(@CurrentActor() actor: RequestActor, @Param('id') id: string): Promise<RecoveryDto> {
    return this.map(await this.recovery.markOnSite(id, actor));
  }

  @Post(':id/collected')
  @HttpCode(200)
  @Roles('SERVICE_ENGINEER')
  async collected(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() body: { deviceSerial?: string; conditionNotes?: string },
  ): Promise<RecoveryDto> {
    return this.map(
      await this.recovery.markCollected(id, { deviceSerial: body.deviceSerial ?? '', conditionNotes: body.conditionNotes ?? '' }, actor),
    );
  }

  @Post(':id/unable-to-collect')
  @HttpCode(200)
  @Roles('SERVICE_ENGINEER')
  async unable(@CurrentActor() actor: RequestActor, @Param('id') id: string, @Body() body: { reasonCode?: UnableToCollectReason }): Promise<RecoveryDto> {
    if (!body.reasonCode || !UNABLE_REASONS.includes(body.reasonCode)) throw new BadRequestException({ code: 'INVALID_REASON' });
    return this.map(await this.recovery.markUnableToCollect(id, { reasonCode: body.reasonCode }, actor));
  }

  @Post(':id/receipt')
  @HttpCode(200)
  @Roles('WAREHOUSE_MANAGER')
  async receipt(@CurrentActor() actor: RequestActor, @Param('id') id: string): Promise<RecoveryDto> {
    return this.map(await this.recovery.confirmWarehouseReceipt(id, actor));
  }

  @Get('awaiting-receipt')
  @Roles('WAREHOUSE_MANAGER', ...MANAGER_ROLES)
  async awaitingReceipt(): Promise<RecoveryDto[]> {
    const rows = await this.recovery.awaitingReceipt();
    return rows.map(toDto);
  }

  @Get('zm-queue')
  @Roles(...MANAGER_ROLES)
  async zmQueue(): Promise<RecoveryDto[]> {
    const rows = await this.recovery.zmDecisionQueue();
    return rows.map(toDto);
  }

  private map(out: RecoveryOutcome): RecoveryDto {
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'RECOVERY_NOT_FOUND' });
    if (out.result === 'FORBIDDEN') throw new ForbiddenException({ code: 'RECOVERY_FORBIDDEN' });
    if (out.result === 'WRONG_STATE') throw new ConflictException({ code: 'RECOVERY_WRONG_STATE' });
    if (out.result === 'INVALID_SERIAL') throw new BadRequestException({ code: 'INVALID_DEVICE_SERIAL' });
    if (out.result === 'NOTES_REQUIRED') throw new BadRequestException({ code: 'CONDITION_NOTES_REQUIRED' });
    if (out.result === 'INVALID_REASON') throw new BadRequestException({ code: 'INVALID_REASON' });
    return toDto(out.ticket);
  }
}

function toDto(ticket: RecoveryView): RecoveryDto {
  return { ...ticket, deviceId: String(ticket.deviceId) };
}
