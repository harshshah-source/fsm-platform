import { Controller, Get, UseGuards } from '@nestjs/common';
import { ROLES } from '@fsm/shared';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { type ComponentCatalogItem, ComponentCatalogService } from './component-catalog.service';

/**
 * `GET /api/components` — the component catalog (#352, the catalog half of **#173**).
 *
 * Readable by every authenticated role, and deliberately so. The SE needs it to name the part their
 * troubleshoot form is about; the Warehouse Manager needs it to read a request; the ZM sees component
 * names on the Component-Blocked Queue. It is reference data with no zone, no owner and nothing
 * confidential in it — a list of part names — so scoping it would only mean a client holding a partial
 * catalog and rendering a bare id for anything outside it.
 *
 * Read-only. Editing the catalog is warehouse-master-data work that no surface asks for yet; when it
 * lands it is a manager write door and takes `@CurrentScope()` / `@CurrentActor()` (#341).
 */
@Controller('components')
@UseGuards(AuthGuard, RoleGuard)
export class ComponentCatalogController {
  constructor(private readonly catalog: ComponentCatalogService) {}

  @Get()
  @Roles(...ROLES)
  list(): Promise<ComponentCatalogItem[]> {
    return this.catalog.list();
  }
}
