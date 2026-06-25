import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import type { RequestActor } from '../common/request-actor';
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
    @CurrentActor() actor: RequestActor,
  ): Promise<{ key: string; value: unknown }> {
    return this.settings.set(key, body.value, actor);
  }
}
