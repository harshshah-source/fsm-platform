import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import type { RequestActor } from '../common/request-actor';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  SlaRulesService,
  type SlaRuleView,
  type UpsertSlaRuleInput,
} from './sla-rules.service';

/** Operations-Head-owned SLA rule config (`/api/org/sla-rules`). AC#3. */
@Controller('org/sla-rules')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD')
export class SlaRulesAdminController {
  constructor(private readonly slaRules: SlaRulesService) {}

  @Get()
  list(): Promise<SlaRuleView[]> {
    return this.slaRules.list();
  }

  @Put()
  upsert(
    @Body() body: UpsertSlaRuleInput,
    @CurrentActor() actor: RequestActor,
  ): Promise<SlaRuleView> {
    return this.slaRules.upsert(body, actor);
  }
}
