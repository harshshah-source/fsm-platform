import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { SCORING_COMPONENTS } from '../recommender/scoring';
import type { RequestActor } from '../common/request-actor';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  ScoringWeightsService,
  type ScoringWeightView,
  type UpsertScoringWeightInput,
} from './scoring-weights.service';

/** Operations-Head-owned Recommender scoring weights (`/api/org/scoring-weights`). AC#3. */
@Controller('org/scoring-weights')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD')
export class ScoringWeightsAdminController {
  constructor(private readonly scoringWeights: ScoringWeightsService) {}

  /**
   * #266 — the closed vocabulary of components the recommender actually reads.
   *
   * Served rather than duplicated in the admin so the picker and the validation that rejects a bad
   * component cannot drift into disagreeing: `scoring.ts` is the one definition and both sides read
   * it. Declared above no param route on this controller, so it needs no ordering guard — but see
   * #273 for the case where it did.
   */
  @Get('components')
  components(): { components: string[] } {
    return { components: [...SCORING_COMPONENTS] };
  }

  @Get()
  list(@Query('weightSetRef') weightSetRef?: string): Promise<ScoringWeightView[]> {
    return this.scoringWeights.list(weightSetRef);
  }

  @Post()
  upsert(
    @Body() body: UpsertScoringWeightInput,
    @CurrentActor() actor: RequestActor,
  ): Promise<ScoringWeightView> {
    return this.scoringWeights.upsert(body, actor);
  }
}
