import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import type { RequestActor } from '../common/request-actor';
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
    @CurrentActor() actor: RequestActor,
  ): Promise<CommonKitView> {
    return this.commonKit.upsert(body, actor);
  }
}
