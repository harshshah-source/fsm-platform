import { Module } from '@nestjs/common';
import { SeAvailabilityService } from '../engineers/se-availability.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SoftInactiveCountService } from '../reports/soft-inactive-count.service';
import { CandidateSelectionService } from './candidate-selection.service';
import { RecommenderService } from './recommender.service';

/**
 * Recommender (Issue 10). The candidate-selection engine: strict-precedence routing (ADR-0001),
 * Hard Filters (ADR-0003), canonical sort (ADR-0017), weighted scoring + Plant Cluster Multiplier,
 * and the persisted `recommendations` explainability record. Dispatch / Day-Plan grouping (Issue 11)
 * builds on `RecommenderService`. The pure functions (canonical-sort / hard-filters / scoring) are
 * imported directly where needed and need no provider.
 */
@Module({
  imports: [PrismaModule],
  providers: [CandidateSelectionService, RecommenderService, InventoryService, SeAvailabilityService, SoftInactiveCountService],
  exports: [CandidateSelectionService, RecommenderService],
})
export class RecommenderModule {}
