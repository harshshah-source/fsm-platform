import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import type { RequestActor } from '../common/request-actor';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { type CreateUserInput, UsersService, type UserView } from './users.service';

/** Operations-Head-owned user account management (`/api/org/users`). AC#4. */
@Controller('org/users')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD')
export class UsersAdminController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(): Promise<UserView[]> {
    return this.users.list();
  }

  @Post()
  create(
    @Body() body: CreateUserInput,
    @CurrentActor() actor: RequestActor,
  ): Promise<UserView> {
    return this.users.create(body, actor);
  }

  @Patch(':userId')
  setStatus(
    @Param('userId') userId: string,
    @Body() body: { status: string },
    @CurrentActor() actor: RequestActor,
  ): Promise<UserView> {
    return this.users.setStatus(userId, body.status, actor);
  }
}
