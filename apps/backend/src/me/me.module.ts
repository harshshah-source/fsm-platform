import { Module } from '@nestjs/common';
import { MeProfileService } from './me-profile.service';

/**
 * Supplies `MeProfileService` (#161's `/api/me` SE profile enrichment). `MeController` itself is
 * registered directly on `AppModule` (existing convention — see `app.module.ts`), not here; this
 * module only supplies its provider. `PrismaModule` is `@Global()`, so it isn't imported here.
 */
@Module({
  providers: [MeProfileService],
  exports: [MeProfileService],
})
export class MeModule {}
