import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SharedPoolModule } from '../shared-pool/shared-pool.module';
import { MeTicketDetailService } from './me-ticket-detail.service';
import { MeTicketFormsService } from './me-ticket-forms.service';
import { MeTicketsQueryService } from './me-tickets-query.service';

/**
 * #161 — the SE ticket-read surface: the merged list (item 2, `me-tickets-query.service.ts`), the
 * per-ticket detail read (item 1, `me-ticket-detail.service.ts`), and the own-forms read (item 3,
 * `me-ticket-forms.service.ts`). `MeTicketsController` itself is registered directly on `AppModule`
 * (existing convention for this controller — see `app.module.ts`), not here; this module only
 * supplies its providers.
 */
@Module({
  imports: [PrismaModule, SharedPoolModule],
  providers: [MeTicketsQueryService, MeTicketDetailService, MeTicketFormsService],
  exports: [MeTicketsQueryService, MeTicketDetailService, MeTicketFormsService],
})
export class MeTicketsModule {}
