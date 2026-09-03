import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import type { RequestActor } from '../common/request-actor';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  type CreateUserInput,
  type UpdateUserInput,
  UsersService,
  type UserView,
} from './users.service';

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

  /**
   * The one edit door for an existing account: status, role and zone (#362). Deliberately one route
   * rather than a second `/role` endpoint — an OH who moves a manager to another zone and demotes
   * them in the same breath should not be able to land half of that, and the last-Operations-Head
   * guard has to see the *whole* proposed end state to judge it.
   */
  @Patch(':userId')
  update(
    @Param('userId') userId: string,
    @Body() body: UpdateUserInput,
    @CurrentActor() actor: RequestActor,
  ): Promise<UserView> {
    return this.users.update(userId, body, actor);
  }
}
