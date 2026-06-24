import { Controller, Get, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  type CommonKitStatus,
  type ComponentBlockedRow,
  InventoryService,
  type VanStockItem,
} from './inventory.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * Component-Blocked Queue (Issue 21, `/api/component-blocked`) — the ZM read-only view of tickets the
 * Recommender dropped for an incomplete Common Kit, with the missing parts, WM action status, and a
 * "Warehouse Overdue" flag once a row ages past 7 days. Zone-scoped server-side.
 */
@Controller('component-blocked')
@UseGuards(AuthGuard, RoleGuard)
export class ComponentBlockedController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @Roles(...MANAGER_ROLES)
  list(@CurrentUser() user: AccessTokenClaims): Promise<ComponentBlockedRow[]> {
    return this.inventory.componentBlockedQueue({ role: user.role, zoneId: user.zone_id });
  }
}

/**
 * SE inventory surface (`/api/me/van-stock`) — the authenticated SE's carried components + Common-Kit
 * completeness, for the mobile Home badge. Scoped to the caller's own id.
 */
@Controller('me')
@UseGuards(AuthGuard, RoleGuard)
export class MeInventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('van-stock')
  @Roles('SERVICE_ENGINEER')
  async vanStock(
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<{ stock: VanStockItem[]; commonKit: CommonKitStatus }> {
    const [stock, commonKit] = await Promise.all([
      this.inventory.vanStockFor(user.user_id),
      this.inventory.commonKitStatus(user.user_id),
    ]);
    return { stock, commonKit };
  }
}
