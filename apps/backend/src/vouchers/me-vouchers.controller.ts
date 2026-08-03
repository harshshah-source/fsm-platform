import { Controller, Get, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { MeVouchersService, type MeVouchersView } from './me-vouchers.service';

/** `GET /api/me/vouchers` (#163 item 1) — see `MeVouchersService`'s doc comment for the contract. */
@Controller('me/vouchers')
@UseGuards(AuthGuard, RoleGuard)
export class MeVouchersController {
  constructor(private readonly vouchers: MeVouchersService) {}

  @Get()
  @Roles('SERVICE_ENGINEER')
  list(@CurrentUser() user: AccessTokenClaims): Promise<MeVouchersView> {
    return this.vouchers.getMyVouchers(user.user_id);
  }
}
