import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { AuditModule } from './audit/audit.module';
import { AuditTrailController } from './audit/audit-trail.controller';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './common/guards/auth.guard';
import { RoleGuard } from './common/guards/role.guard';
import { ZoneScopeGuard } from './common/guards/zone-scope.guard';
import { DashboardModule } from './dashboard/dashboard.module';
import { DashboardController } from './dashboard/dashboard.controller';
import { OperatingModeController } from './dashboard/operating-mode.controller';
import { ReportsModule } from './reports/reports.module';
import { ReportsController } from './reports/reports.controller';
import { DevicesModule } from './devices/devices.module';
import { DevicesController } from './devices/devices.controller';
import { IngestionModule } from './ingestion/ingestion.module';
import { SnapshotsController } from './ingestion/snapshots.controller';
import { InventoryModule } from './inventory/inventory.module';
import { ComponentBlockedController, MeInventoryController } from './inventory/inventory.controller';
import { WarehouseStockController } from './inventory/warehouse-stock.controller';
import { ShadowUseController } from './inventory/shadow-use.controller';
import { ComponentRequestModule } from './component-request/component-request.module';
import { WarehouseRequestsController } from './component-request/warehouse.controller';
import { ComponentRequestController } from './component-request/component-request.controller';
import { MeComponentRequestsController } from './component-request/me-component-requests.controller';
import { EngineersModule } from './engineers/engineers.module';
import { EngineersController } from './engineers/engineers.controller';
import { LeaveRequestController } from './engineers/leave-request.controller';
import { MeLeaveRequestsController } from './engineers/me-leave-requests.controller';
import { MeAvailabilityController } from './engineers/me-availability.controller';
import { RoleBackupModule } from './roles/role-backup.module';
import { RoleBackupController } from './roles/role-backup.controller';
import { NotificationsModule } from './notifications/notifications.module';
import { NotificationsController } from './notifications/notifications.controller';
import { MeController } from './me/me.controller';
import { MeModule } from './me/me.module';
import { MeTicketsModule } from './me-tickets/me-tickets.module';
import { MeTicketsController } from './me-tickets/me-tickets.controller';
import { OrgModule } from './org/org.module';
import { PlannerModule } from './planner/planner.module';
import { SePlannerController } from './planner/se-planner.controller';
import { CommonKitAdminController } from './org/common-kit.controller';
import { CompaniesAdminController } from './org/companies.controller';
import { PlantsAdminController } from './org/plants.controller';
import { ScoringWeightsAdminController } from './org/scoring-weights.controller';
import {
  EngineersAdminController,
  SeCoverageAdminController,
} from './org/se-coverage.controller';
import { GeographyController } from './org/geography.controller';
import { SeTerritoryAdminController } from './org/se-territory.controller';
import { SlaRulesAdminController } from './org/sla-rules.controller';
import { TierOverridesAdminController } from './org/tier-overrides.controller';
import { TiersAdminController } from './org/tiers.controller';
import { UsersAdminController } from './org/users.controller';
import { ZoneMappingAdminController } from './org/zone-mapping.controller';
import { ZonesAdminController } from './org/zones.controller';
import { PrismaModule } from './prisma/prisma.module';
import { SettingsController } from './settings/settings.controller';
import { SettingsModule } from './settings/settings.module';
import { RecommenderModule } from './recommender/recommender.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { BusinessSweepSchedulerModule } from './scheduling/business-sweep-scheduler.module';
import { SchedulesController } from './scheduling/schedules.controller';
import { BatchesController } from './scheduling/batches.controller';
import { DispatchRunsController } from './scheduling/dispatch-runs.controller';
import { IntradayUpdatesController } from './scheduling/intraday-updates.controller';
import { IntradayModule } from './intraday/intraday.module';
import { CrossZoneModule } from './cross-zone/cross-zone.module';
import { SharedPoolModule } from './shared-pool/shared-pool.module';
import { SharedPoolController } from './shared-pool/shared-pool.controller';
import { SoftStateModule } from './soft-state/soft-state.module';
import { SoftStateController } from './soft-state/soft-state.controller';
import { TicketingModule } from './ticketing/ticketing.module';
import { TicketsController } from './ticketing/tickets.controller';
import { TroubleshootController } from './ticketing/troubleshoot.controller';
import { VehicleUnavailabilityController } from './ticketing/vehicle-unavailability.controller';
import { MeVehicleUnavailabilityController } from './ticketing/me-vehicle-unavailability.controller';
import {
  NonOperationalController,
  NonOperationalPublicController,
} from './ticketing/non-operational.controller';
import { RecoveryController } from './ticketing/recovery.controller';
import { InstallController } from './ticketing/install.controller';
import { VerificationModule } from './verification/verification.module';
import { VerificationController } from './verification/verification.controller';
import { VouchersModule } from './vouchers/vouchers.module';
import { ExportsModule } from './exports/exports.module';
import { PlantDeactivationModule } from './plant-deactivation/plant-deactivation.module';
import { VouchersController } from './vouchers/vouchers.controller';
import { MeVouchersController } from './vouchers/me-vouchers.controller';
import { ZonesController } from './zones/zones.controller';
import { MediaModule } from './media/media.module';
import { MediaController } from './media/media.controller';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    SettingsModule,
    AuditModule,
    OrgModule,
    IngestionModule,
    TicketingModule,
    DevicesModule,
    RecommenderModule,
    SchedulingModule,
    BusinessSweepSchedulerModule,
    IntradayModule,
    CrossZoneModule,
    SharedPoolModule,
    MeModule,
    MeTicketsModule,
    PlannerModule,
    DashboardModule,
    ReportsModule,
    SoftStateModule,
    VerificationModule,
    InventoryModule,
    ComponentRequestModule,
    EngineersModule,
    RoleBackupModule,
    NotificationsModule,
    VouchersModule,
    ExportsModule,
    PlantDeactivationModule,
    MediaModule,
  ],
  controllers: [
    HealthController,
    MeController,
    SettingsController,
    ZonesController,
    ZonesAdminController,
    ZoneMappingAdminController,
    PlantsAdminController,
    UsersAdminController,
    CompaniesAdminController,
    TiersAdminController,
    TierOverridesAdminController,
    EngineersAdminController,
    SeCoverageAdminController,
    SeTerritoryAdminController,
    GeographyController,
    SlaRulesAdminController,
    ScoringWeightsAdminController,
    CommonKitAdminController,
    SnapshotsController,
    TicketsController,
    DevicesController,
    TroubleshootController,
    VehicleUnavailabilityController,
    MeVehicleUnavailabilityController,
    NonOperationalController,
    NonOperationalPublicController,
    RecoveryController,
    InstallController,
    SchedulesController,
    BatchesController,
    DispatchRunsController,
    IntradayUpdatesController,
    SharedPoolController,
    MeTicketsController,
    SePlannerController,
    DashboardController,
    OperatingModeController,
    ReportsController,
    SoftStateController,
    VerificationController,
    ComponentBlockedController,
    MeInventoryController,
    WarehouseStockController,
    ShadowUseController,
    WarehouseRequestsController,
    ComponentRequestController,
    MeComponentRequestsController,
    EngineersController,
    LeaveRequestController,
    MeLeaveRequestsController,
    MeAvailabilityController,
    RoleBackupController,
    NotificationsController,
    AuditTrailController,
    VouchersController,
    MeVouchersController,
    MediaController,
  ],
  providers: [
    AuthGuard,
    RoleGuard,
    ZoneScopeGuard,
    HealthService,
    // Global exception filter (#98): sanitized 500s + correlation id for every route, HttpException
    // contracts (e.g. `{ code }`) preserved verbatim.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Global guard chain (#99), in order: every route authenticates by default (@Public opts out),
    // then @Roles allow-lists, then ZM zone clamping. Per-controller @UseGuards stays valid (re-runs
    // are idempotent) — but forgetting it no longer exposes a route.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RoleGuard },
    { provide: APP_GUARD, useClass: ZoneScopeGuard },
    // Global validation (#99): DTO-classed routes get whitelist + forbidNonWhitelisted + transform;
    // interface-typed bodies are untouched (Nest skips non-class metatypes), so contracts don't drift.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
  ],
})
export class AppModule {}
