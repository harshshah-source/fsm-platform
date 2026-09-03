import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Patch, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import type { ManagerScope } from '../common/manager-scope';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import type { RequestActor } from '../common/request-actor';
import {
  type FulfillmentSla,
  type WarehouseStockRow,
  WarehouseStockService,
} from './warehouse-stock.service';

const READ_ROLES = ['WAREHOUSE_MANAGER', 'ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;
const WRITE_ROLES = ['WAREHOUSE_MANAGER', 'OPERATIONS_HEAD'] as const;

interface SetStockBody {
  zoneId?: number | string;
  componentId?: number | string;
  onHand?: number;
  reserved?: number;
  lowStockThreshold?: number;
}

/**
 * Zone-warehouse stock surface (Issue 73, `/api/inventory/warehouse-stock`). WM/managers read per-zone
 * SKU levels (zone-scoped for a ZM) + the Component-Request Fulfilment-SLA KPI; the Warehouse Manager /
 * Operations Head set/adjust on-hand, reserved and the low-stock threshold (audited).
 */
@Controller('inventory')
@UseGuards(AuthGuard, RoleGuard)
export class WarehouseStockController {
  constructor(private readonly stock: WarehouseStockService) {}

  @Get('warehouse-stock')
  @Roles(...READ_ROLES)
  list(@CurrentScope() scope: ManagerScope): Promise<WarehouseStockRow[]> {
    return this.stock.listStock(scope);
  }

  @Get('warehouse-stock/fulfillment-sla')
  @Roles(...READ_ROLES)
  fulfillmentSla(): Promise<FulfillmentSla> {
    return this.stock.fulfillmentSla();
  }

  @Patch('warehouse-stock')
  @HttpCode(200)
  @Roles(...WRITE_ROLES)
  async setStock(@CurrentActor() actor: RequestActor, @Body() body: SetStockBody): Promise<WarehouseStockRow> {
    const zoneId = parseId(body.zoneId, 'zoneId');
    const componentId = parseId(body.componentId, 'componentId');
    for (const [field, v] of [
      ['onHand', body.onHand],
      ['reserved', body.reserved],
      ['lowStockThreshold', body.lowStockThreshold],
    ] as const) {
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
        throw new BadRequestException({ code: 'INVALID_QUANTITY', field });
      }
    }
    if (body.onHand === undefined && body.reserved === undefined && body.lowStockThreshold === undefined) {
      throw new BadRequestException({ code: 'NOTHING_TO_UPDATE' });
    }
    const out = await this.stock.setStock(
      zoneId,
      componentId,
      { onHand: body.onHand, reserved: body.reserved, lowStockThreshold: body.lowStockThreshold },
      { userId: actor.userId, role: actor.role, actedAsRole: actor.actedAsRole ?? null },
    );
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'ZONE_OR_COMPONENT_NOT_FOUND' });
    return out.row;
  }
}

function parseId(raw: number | string | undefined, field: string): bigint {
  if (raw === undefined || !/^\d+$/.test(String(raw))) throw new BadRequestException({ code: 'INVALID_ID', field });
  return BigInt(String(raw));
}
