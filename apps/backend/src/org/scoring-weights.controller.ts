import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
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

  @Get()
  list(@Query('weightSetRef') weightSetRef?: string): Promise<ScoringWeightView[]> {
    return this.scoringWeights.list(weightSetRef);
  }

  @Post()
  upsert(
    @Body() body: UpsertScoringWeightInput,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ScoringWeightView> {
    return this.scoringWeights.upsert(body, user);
  }
}
