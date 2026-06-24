import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  CommonKitService,
  type CommonKitView,
  type UpsertCommonKitInput,
} from './common-kit.service';

/** Operations-Head-owned Common Kit definition (`/api/org/common-kit`). AC#3. */
@Controller('org/common-kit')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD')
export class CommonKitAdminController {
  constructor(private readonly commonKit: CommonKitService) {}

  @Get()
  list(): Promise<CommonKitView[]> {
    return this.commonKit.list();
  }

  @Post()
  upsert(
    @Body() body: UpsertCommonKitInput,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<CommonKitView> {
    return this.commonKit.upsert(body, user);
  }
}
