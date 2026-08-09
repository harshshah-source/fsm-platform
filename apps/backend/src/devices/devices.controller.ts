import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { type DealType, type SlaBucket } from '../generated/prisma/enums';
import { DeviceDetailService, type DeviceCycleView, type DeviceDowntimeTrend } from './device-detail.service';
import {
  DeviceService,
  type DeviceFilterOptions,
  type DeviceListPage,
  type DeviceSort,
  type DeviceStatusFilter,
  type DeviceView,
} from './device.service';

const DEAL_TYPES: readonly DealType[] = ['RECURRING', 'ONE_TIME'];
const SORTS: readonly DeviceSort[] = ['LONGEST_INACTIVE', 'NEWEST_ACTIVITY', 'SLA_SEVERITY', 'DEVICE_ID', 'PRIORITY'];
const STATUS_FILTERS: readonly DeviceStatusFilter[] = ['ALL', 'INACTIVE', 'ACTIVE', 'NEVER_REPORTED'];
const READ_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * Device master surface (Issue 49, `/api/devices`). `GET :deviceId` is the manager-roled read path
 * (#35 reads `deal_type` from here); `PATCH :deviceId/deal-type` is the **Operations-Head-only**
 * audited manual tag (CONTEXT: Operations Head is the configurator). Other roles are gated out.
 */
@Controller('devices')
@UseGuards(AuthGuard, RoleGuard)
export class DevicesController {
  constructor(
    private readonly devices: DeviceService,
    private readonly deviceDetail: DeviceDetailService,
  ) {}

  /**
   * Device Detail list (FE-22). Manager read, zone-scoped; optional `search`, `limit`, `offset`, plus
   * `sort` and the `status` / `bucket` / `zoneId` / `companyId` filters. Returns `{ rows, total }` so the
   * UI can page through the whole fleet (one page is only the top slice of a much larger set).
   */
  @Get()
  @Roles(...READ_ROLES)
  list(
    @CurrentUser() user: AccessTokenClaims,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('sort') sort?: string,
    @Query('status') status?: string,
    @Query('bucket') bucket?: string,
    @Query('zoneId') zoneId?: string,
    @Query('companyId') companyId?: string,
    @Query('plantId') plantId?: string,
    @Query('criticalPlus') criticalPlus?: string,
  ): Promise<DeviceListPage> {
    return this.devices.listDevices(
      { role: user.role, zoneId: user.zone_id },
      {
        search,
        limit: limit === undefined ? undefined : Number(limit),
        offset: offset === undefined ? undefined : Number(offset),
        sort: SORTS.includes(sort as DeviceSort) ? (sort as DeviceSort) : undefined,
        status: STATUS_FILTERS.includes(status as DeviceStatusFilter) ? (status as DeviceStatusFilter) : undefined,
        bucket: (bucket as SlaBucket) || undefined,
        zoneId: zoneId === 'UNZONED' ? 'UNZONED' : zoneId ? Number(zoneId) : undefined,
        companyId: companyId ? Number(companyId) : undefined,
        plantId: plantId ? Number(plantId) : undefined,
        criticalPlus: criticalPlus === 'true' || criticalPlus === '1',
      },
    );
  }

  /** Distinct zones + companies present in the caller's scope — the source for the list's filter dropdowns. */
  @Get('filter-options')
  @Roles(...READ_ROLES)
  filterOptions(@CurrentUser() user: AccessTokenClaims): Promise<DeviceFilterOptions> {
    return this.devices.filterOptions({ role: user.role, zoneId: user.zone_id });
  }

  @Get(':deviceId')
  @Roles(...READ_ROLES)
  async get(@Param('deviceId') deviceId: string): Promise<DeviceView> {
    const id = this.parseId(deviceId);
    const device = await this.devices.getDevice(id);
    if (!device) throw new NotFoundException({ code: 'DEVICE_NOT_FOUND' });
    return device;
  }

  /** Device Detail — lifetime Failure-Cycle list (Issue 44). ZM own-zone only; CSM / Operations Head all. */
  @Get(':deviceId/cycles')
  @Roles(...READ_ROLES)
  async cycles(@CurrentUser() user: AccessTokenClaims, @Param('deviceId') deviceId: string): Promise<{ deviceId: string; cycles: DeviceCycleView[] }> {
    const out = await this.deviceDetail.deviceCycles(this.parseId(deviceId), { role: user.role, zoneId: user.zone_id });
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'DEVICE_NOT_FOUND' });
    return { deviceId: out.deviceId, cycles: out.cycles };
  }

  /** Lifetime Downtime Trend — monthly series + lifetime totals + root-cause trend (Issue 44). */
  @Get(':deviceId/downtime-trend')
  @Roles(...READ_ROLES)
  async downtimeTrend(@CurrentUser() user: AccessTokenClaims, @Param('deviceId') deviceId: string): Promise<DeviceDowntimeTrend> {
    const out = await this.deviceDetail.downtimeTrend(this.parseId(deviceId), { role: user.role, zoneId: user.zone_id });
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'DEVICE_NOT_FOUND' });
    return out.trend;
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

  // Device ids are opaque strings from AutoPlant (`tb_vehiclemaster.device_id` varchar(255)) —
  // leading-zero IMEIs and alphanumeric vendor ids are valid, so we only reject the empty id.
  private parseId(deviceId: string): string {
    const id = deviceId.trim();
    if (id === '') throw new BadRequestException({ code: 'INVALID_DEVICE_ID' });
    return id;
  }
}
