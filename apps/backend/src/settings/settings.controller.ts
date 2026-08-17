import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
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
    if ('result' in outcome) {
      // #238 — a locked key refuses every writer but the Operations Head, with the lock's own reason
      // so the refusal is a decision the reader can understand rather than a permissions error.
      if (outcome.result === 'LOCKED') {
        throw new ConflictException({
          code: 'SETTING_LOCKED',
          key: outcome.key,
          lockedByRole: outcome.lockedByRole,
          lockReason: outcome.lockReason,
        });
      }
      // #213 — a key with a specialised writer (validation + live re-registration) is refused here
      // rather than half-applied. The response names the endpoint that owns it.
      throw new BadRequestException({
        code: 'USE_SPECIALISED_SETTING_ENDPOINT',
        key: outcome.key,
        endpoint: outcome.endpoint,
      });
    }
    return outcome;
  }
}
