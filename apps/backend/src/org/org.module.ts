import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CommonKitService } from './common-kit.service';
import { CompaniesService } from './companies.service';
import { GeographyService } from './geography.service';
import { PlantEligibleFloatingSeService } from './plant-eligible-floating-se.service';
import { PlantEligibilityRefreshScheduler } from './plant-eligibility-refresh-scheduler.service';
import { PlantsService } from './plants.service';
import { ScoringWeightsService } from './scoring-weights.service';
import { SeCoverageService } from './se-coverage.service';
import { SeTerritoryService } from './se-territory.service';
import { SlaRulesService } from './sla-rules.service';
import { TierOverrideExpiryService } from './tier-override-expiry.service';
import { TierOverridesService } from './tier-overrides.service';
import { TiersService } from './tiers.service';
import { UsersService } from './users.service';
import { ZoneMappingService } from './zone-mapping.service';
import { ZonesService } from './zones.service';

// Operations-Head-owned org/reference data services (zones, plants, users, companies, SE
// coverage, SLA rules, scoring weights, common kit). Controllers are registered in AppModule
// so the guard chain resolves.
const services = [
  ZonesService,
  PlantsService,
  UsersService,
  CompaniesService,
  SeCoverageService,
  SeTerritoryService,
  PlantEligibleFloatingSeService,
  GeographyService,
  SlaRulesService,
  ScoringWeightsService,
  CommonKitService,
  ZoneMappingService,
  TiersService,
  TierOverridesService,
  TierOverrideExpiryService,
];

@Module({
  imports: [AuditModule],
  providers: [
    ...services,
    // The periodic MV-refresh scheduler (Issue 138 slice 3). Factory-provided — like
    // DispatchSchedulerService — so its optional `config` param reads the environment rather than being
    // DI-resolved. Its `@Cron` is discovered by the global ScheduleModule explorer.
    {
      provide: PlantEligibilityRefreshScheduler,
      useFactory: (eligibility: PlantEligibleFloatingSeService) => new PlantEligibilityRefreshScheduler(eligibility),
      inject: [PlantEligibleFloatingSeService],
    },
  ],
  exports: services,
})
export class OrgModule {}
