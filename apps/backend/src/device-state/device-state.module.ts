import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { DeviceStateService } from './device-state.service';

/**
 * DeviceState (schema D5). Gives `DeviceStateService` a proper Nest home so it can be injected and
 * triggered at runtime (the integration pipeline), instead of only being hand-constructed in tests.
 * Depends on `SettingsService` for the configurable inactivity threshold; Prisma is global.
 */
@Module({
  imports: [SettingsModule],
  providers: [DeviceStateService],
  exports: [DeviceStateService],
})
export class DeviceStateModule {}
