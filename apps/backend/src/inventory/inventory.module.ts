import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryService } from './inventory.service';
import { ShadowUseService } from './shadow-use.service';

/**
 * Inventory — Van Stock + Common Kit + the Component-Blocked Queue (Issue 21, schema D12). Reads van
 * stock / kit completeness (Recommender Common-Kit Hard Filter, SE mobile Home badge) and surfaces
 * tickets dropped for an incomplete kit. Consumption / transactions land with Issues 22/24.
 * `ComponentBlockedController` / `MeInventoryController` are registered in AppModule.
 */
@Module({
  imports: [PrismaModule],
  providers: [InventoryService, ShadowUseService],
  exports: [InventoryService, ShadowUseService],
})
export class InventoryModule {}
