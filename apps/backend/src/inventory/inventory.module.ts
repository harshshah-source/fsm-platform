import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ComponentCatalogService } from './component-catalog.service';
import { InventoryService } from './inventory.service';
import { ShadowUseService } from './shadow-use.service';
import { WarehouseStockService } from './warehouse-stock.service';

/**
 * Inventory — Van Stock + Common Kit + the Component-Blocked Queue (Issue 21, schema D12). Reads van
 * stock / kit completeness (Recommender Common-Kit Hard Filter, SE mobile Home badge) and surfaces
 * tickets dropped for an incomplete kit. Consumption / transactions land with Issues 22/24.
 * `ComponentBlockedController` / `MeInventoryController` are registered in AppModule, as is
 * `ComponentCatalogController` (#352) — whose service is exported below for it.
 */
@Module({
  imports: [PrismaModule],
  providers: [InventoryService, ShadowUseService, WarehouseStockService, ComponentCatalogService],
  exports: [InventoryService, ShadowUseService, WarehouseStockService, ComponentCatalogService],
})
export class InventoryModule {}
