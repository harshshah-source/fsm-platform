import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
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
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<UserView> {
    return this.users.create(body, user);
  }

  @Patch(':userId')
  setStatus(
    @Param('userId') userId: string,
    @Body() body: { status: string },
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<UserView> {
    return this.users.setStatus(userId, body.status, user);
  }
}
