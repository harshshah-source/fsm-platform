import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { VerificationQueryService } from './verification-query.service';
import { VerificationService } from './verification.service';

/**
 * GPS three-phase verification (Issue 18). `VerificationService` is the re-entrant worker that drives
 * VERIFICATION_PENDING tickets to CLOSED / FAILED_VERIFICATION / PARTIAL_RECOVERY; `VerificationQueryService`
 * backs the read surface. `VerificationController` is registered in AppModule (same convention as the
 * other feature controllers).
 */
@Module({
  imports: [PrismaModule],
  providers: [VerificationService, VerificationQueryService],
  exports: [VerificationService, VerificationQueryService],
})
export class VerificationModule {}
