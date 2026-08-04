import { BadRequestException, Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
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
  async update(
    @Param('key') key: string,
    @Body() body: { value: unknown },
    @CurrentActor() actor: RequestActor,
  ): Promise<{ key: string; value: unknown }> {
    const outcome = await this.settings.set(key, body.value, actor);
    // #213 — a key with a specialised writer (validation + live re-registration) is refused here rather
    // than half-applied. The response names the endpoint that owns it.
    if ('result' in outcome) {
      throw new BadRequestException({
        code: 'USE_DISPATCH_SCHEDULE_ENDPOINT',
        key: outcome.key,
        endpoint: outcome.endpoint,
      });
    }
    return outcome;
  }
}
