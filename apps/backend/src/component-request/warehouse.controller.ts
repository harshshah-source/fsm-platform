import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { type DeliveryDestination } from '../generated/prisma/enums';
import { ComponentRequestService, type WmOutcome } from './component-request.service';

const DELIVERY_DESTINATIONS: DeliveryDestination[] = ['SE_LOCATION', 'PLANT_WAREHOUSE'];

interface ShipBody {
  trackingRef?: string;
  deliveryDestination?: DeliveryDestination;
}
interface RejectBody {
  reason?: string;
}

function resolve(outcome: WmOutcome) {
  if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'COMPONENT_REQUEST_NOT_FOUND' });
  if (outcome.result === 'INVALID_STATE') {
    throw new ConflictException({ code: 'COMPONENT_REQUEST_INVALID_STATE', status: outcome.status });
  }
  return { request: outcome.request };
}

/**
 * Warehouse Manager Component-Request queue (Issue 22, `/api/warehouse/requests`). Lists active
 * requests newest-first and drives the WM legs of the lifecycle: Approve → Mark Shipped (tracking +
 * delivery destination) or Reject (mandatory reason). WAREHOUSE_MANAGER only.
 */
@Controller('warehouse/requests')
@UseGuards(AuthGuard, RoleGuard)
export class WarehouseRequestsController {
  constructor(private readonly requests: ComponentRequestService) {}

  @Get()
  @Roles('WAREHOUSE_MANAGER')
  list() {
    return this.requests.queue();
  }

  @Post(':id/approve')
  @Roles('WAREHOUSE_MANAGER')
  async approve(@CurrentUser() user: AccessTokenClaims, @Param('id') id: string) {
    return resolve(await this.requests.approve(id, { userId: user.user_id, role: user.role }));
  }

  @Post(':id/ship')
  @Roles('WAREHOUSE_MANAGER')
  async ship(@CurrentUser() user: AccessTokenClaims, @Param('id') id: string, @Body() body: ShipBody) {
    if (!body.trackingRef) throw new BadRequestException({ code: 'TRACKING_REF_REQUIRED' });
    if (!body.deliveryDestination || !DELIVERY_DESTINATIONS.includes(body.deliveryDestination)) {
      throw new BadRequestException({ code: 'DELIVERY_DESTINATION_REQUIRED' });
    }
    return resolve(
      await this.requests.markShipped(
        id,
        { trackingRef: body.trackingRef, deliveryDestination: body.deliveryDestination },
        { userId: user.user_id, role: user.role },
      ),
    );
  }

  @Post(':id/reject')
  @Roles('WAREHOUSE_MANAGER')
  async reject(@CurrentUser() user: AccessTokenClaims, @Param('id') id: string, @Body() body: RejectBody) {
    if (!body.reason || !body.reason.trim()) throw new BadRequestException({ code: 'REJECTION_REASON_REQUIRED' });
    return resolve(await this.requests.reject(id, body.reason, { userId: user.user_id, role: user.role }));
  }
}
