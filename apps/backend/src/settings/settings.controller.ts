import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { SettingsService } from './settings.service';

@Controller('settings')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  list(): Promise<Record<string, unknown>> {
    return this.settings.getAll();
  }

  @Put(':key')
  update(
    @Param('key') key: string,
    @Body() body: { value: unknown },
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<{ key: string; value: unknown }> {
    return this.settings.set(key, body.value, user);
  }
}
