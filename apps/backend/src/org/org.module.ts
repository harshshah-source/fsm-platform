import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CommonKitService } from './common-kit.service';
import { CompaniesService } from './companies.service';
import { GeographyService } from './geography.service';
import { PlantEligibleFloatingSeService } from './plant-eligible-floating-se.service';
import { PlantsService } from './plants.service';
import { ScoringWeightsService } from './scoring-weights.service';
import { SeCoverageService } from './se-coverage.service';
import { SeTerritoryService } from './se-territory.service';
import { SlaRulesService } from './sla-rules.service';
import { UsersService } from './users.service';
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
];

@Module({
  imports: [AuditModule],
  providers: services,
  exports: services,
})
export class OrgModule {}
