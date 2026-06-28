import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module';
import { AuditTrailController } from './audit/audit-trail.controller';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './common/guards/auth.guard';
import { RoleGuard } from './common/guards/role.guard';
import { ZoneScopeGuard } from './common/guards/zone-scope.guard';
import { DashboardModule } from './dashboard/dashboard.module';
import { DashboardController } from './dashboard/dashboard.controller';
import { ReportsModule } from './reports/reports.module';
import { ReportsController } from './reports/reports.controller';
import { DevicesModule } from './devices/devices.module';
import { DevicesController } from './devices/devices.controller';
import { IngestionModule } from './ingestion/ingestion.module';
import { SnapshotsController } from './ingestion/snapshots.controller';
import { InventoryModule } from './inventory/inventory.module';
import { ComponentBlockedController, MeInventoryController } from './inventory/inventory.controller';
import { ShadowUseController } from './inventory/shadow-use.controller';
import { ComponentRequestModule } from './component-request/component-request.module';
import { WarehouseRequestsController } from './component-request/warehouse.controller';
import { ComponentRequestController } from './component-request/component-request.controller';
import { EngineersModule } from './engineers/engineers.module';
import { EngineersController } from './engineers/engineers.controller';
import { LeaveRequestController } from './engineers/leave-request.controller';
import { RoleBackupModule } from './roles/role-backup.module';
import { RoleBackupController } from './roles/role-backup.controller';
import { NotificationsModule } from './notifications/notifications.module';
import { NotificationsController } from './notifications/notifications.controller';
import { MeController } from './me/me.controller';
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
import { UsersAdminController } from './org/users.controller';
import { ZonesAdminController } from './org/zones.controller';
import { PrismaModule } from './prisma/prisma.module';
import { SettingsController } from './settings/settings.controller';
import { SettingsModule } from './settings/settings.module';
import { RecommenderModule } from './recommender/recommender.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { SchedulesController } from './scheduling/schedules.controller';
import { BatchesController } from './scheduling/batches.controller';
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
import {
  NonOperationalController,
  NonOperationalPublicController,
} from './ticketing/non-operational.controller';
import { RecoveryController } from './ticketing/recovery.controller';
import { InstallController } from './ticketing/install.controller';
import { VerificationModule } from './verification/verification.module';
import { VerificationController } from './verification/verification.controller';
import { VouchersModule } from './vouchers/vouchers.module';
import { VouchersController } from './vouchers/vouchers.controller';
import { ZonesController } from './zones/zones.controller';

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
    IntradayModule,
    CrossZoneModule,
    SharedPoolModule,
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
  ],
  controllers: [
    MeController,
    SettingsController,
    ZonesController,
    ZonesAdminController,
    PlantsAdminController,
    UsersAdminController,
    CompaniesAdminController,
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
    NonOperationalController,
    NonOperationalPublicController,
    RecoveryController,
    InstallController,
    SchedulesController,
    BatchesController,
    IntradayUpdatesController,
    SharedPoolController,
    SePlannerController,
    DashboardController,
    ReportsController,
    SoftStateController,
    VerificationController,
    ComponentBlockedController,
    MeInventoryController,
    ShadowUseController,
    WarehouseRequestsController,
    ComponentRequestController,
    EngineersController,
    LeaveRequestController,
    RoleBackupController,
    NotificationsController,
    AuditTrailController,
    VouchersController,
  ],
  providers: [AuthGuard, RoleGuard, ZoneScopeGuard],
})
export class AppModule {}
