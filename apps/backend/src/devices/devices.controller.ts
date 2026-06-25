import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { type DealType } from '../generated/prisma/enums';
import { DeviceService, type DeviceView } from './device.service';

const DEAL_TYPES: readonly DealType[] = ['RECURRING', 'ONE_TIME'];
const READ_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * Device master surface (Issue 49, `/api/devices`). `GET :deviceId` is the manager-roled read path
 * (#35 reads `deal_type` from here); `PATCH :deviceId/deal-type` is the **Operations-Head-only**
 * audited manual tag (CONTEXT: Operations Head is the configurator). Other roles are gated out.
 */
@Controller('devices')
@UseGuards(AuthGuard, RoleGuard)
export class DevicesController {
  constructor(private readonly devices: DeviceService) {}

  @Get(':deviceId')
  @Roles(...READ_ROLES)
  async get(@Param('deviceId') deviceId: string): Promise<DeviceView> {
    const id = this.parseId(deviceId);
    const device = await this.devices.getDevice(id);
    if (!device) throw new NotFoundException({ code: 'DEVICE_NOT_FOUND' });
    return device;
  }

  @Patch(':deviceId/deal-type')
  @Roles('OPERATIONS_HEAD')
  async tagDealType(
    @CurrentUser() user: AccessTokenClaims,
    @Param('deviceId') deviceId: string,
    @Body() body: { dealType: DealType },
  ): Promise<DeviceView> {
    if (!DEAL_TYPES.includes(body.dealType)) throw new BadRequestException({ code: 'INVALID_DEAL_TYPE' });
    const out = await this.devices.setDealType(this.parseId(deviceId), body.dealType, {
      userId: user.user_id,
      role: user.role,
      actedAsRole: null,
    });
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'DEVICE_NOT_FOUND' });
    return out.device;
  }

  private parseId(deviceId: string): bigint {
    if (!/^\d+$/.test(deviceId)) throw new BadRequestException({ code: 'INVALID_DEVICE_ID' });
    return BigInt(deviceId);
  }
}
