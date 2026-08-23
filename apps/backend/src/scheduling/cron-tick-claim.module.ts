import { Module } from '@nestjs/common';
import { CronTickClaimService } from './cron-tick-claim.service';

/**
 * #263 — a leaf module supplying {@link CronTickClaimService} to every scheduler in the app.
 *
 * It imports nothing (`PrismaModule` is `@Global`), so it cannot participate in a cycle no matter who
 * imports it — which matters, because its consumers live in five feature modules that already import
 * each other in one direction or another (`IngestionModule → OrgModule → …`).
 *
 * It is a normal module rather than another `@Global` one on purpose. An explicit import in each of
 * the five is the record of which modules run scheduled work, and that list is exactly the thing #229
 * showed nobody can reconstruct from prose.
 */
@Module({
  providers: [CronTickClaimService],
  exports: [CronTickClaimService],
})
export class CronTickClaimModule {}
