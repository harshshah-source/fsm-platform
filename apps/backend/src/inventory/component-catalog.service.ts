import { Injectable } from '@nestjs/common';
import type { ComponentCatalogItem } from '@fsm/shared';
import { PrismaService } from '../prisma/prisma.service';

export type { ComponentCatalogItem } from '@fsm/shared';

/**
 * The component catalog (`component_master`) — #352, the catalog half of **#173**.
 *
 * `component_master` is the identity table every other inventory row points at: `se_van_stock`,
 * `common_kit_definition`, `zone_warehouse_stock`, `inventory_transactions` and `component_requests`
 * are all keyed on `component_id`. Until this slice it had no read endpoint at all, which is why the
 * SE's troubleshoot form could only ever send a boolean "something was missing" — there was no way for
 * a client to turn a part into the id the wire contract needs.
 *
 * **There is no `active` column, and this does not invent one.** The survey brief asked for "active
 * rows"; `component_master` has `name`, `category` and `serial_tracked` and nothing else. Filtering on
 * a flag that does not exist would mean either adding a column (another agent owns `schema.prisma`
 * this round) or silently filtering on a proxy — so the catalog is returned whole, and retiring a part
 * stays an unowned question. Filed as a follow-up rather than guessed at.
 */
@Injectable()
export class ComponentCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every catalog component, by name — the order a picker lists them in. */
  async list(): Promise<ComponentCatalogItem[]> {
    const rows = await this.prisma.componentMaster.findMany({ orderBy: { name: 'asc' } });
    return rows.map((r) => ({
      componentId: String(r.componentId),
      name: r.name,
      category: r.category,
      serialTracked: r.serialTracked,
    }));
  }
}
