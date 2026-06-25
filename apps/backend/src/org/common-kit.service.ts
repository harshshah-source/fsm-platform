import { BadRequestException, Injectable } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { PrismaService } from '../prisma/prisma.service';

export interface CommonKitView {
  id: number;
  componentId: number;
  minQty: number;
  active: boolean;
}

export interface UpsertCommonKitInput {
  componentId: number;
  minQty: number;
  active?: boolean;
}

/**
 * Operations-Head-owned Common Kit definition (`common_kit_definition`) — components every SE
 * carries; input to the Recommender Common-Kit Hard Filter (Issue 21). The FK to
 * `component_master` is deferred until that table lands; `componentId` is a plain bigint here.
 */
@Injectable()
export class CommonKitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<CommonKitView[]> {
    const rows = await this.prisma.commonKitDefinition.findMany({ orderBy: { id: 'asc' } });
    return rows.map(toCommonKitView);
  }

  /** Upserts one kit component by componentId, audited (AC#6). Bad componentId / minQty → 400. */
  async upsert(input: UpsertCommonKitInput, actor: RequestActor): Promise<CommonKitView> {
    if (!Number.isInteger(input.componentId) || input.componentId <= 0) {
      throw new BadRequestException('componentId must be a positive integer');
    }
    if (!Number.isInteger(input.minQty) || input.minQty <= 0) {
      throw new BadRequestException('minQty must be a positive integer');
    }
    const active = input.active ?? true;
    return this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'COMMON_KIT_UPDATED',
        entityType: 'common_kit_definition',
        entityId: String(input.componentId),
      },
      async (tx) => {
        // Ensure the kit component exists in component_master (Issue 21 FK). Operations Head adds a kit
        // component by id; register a placeholder master row if it is not yet known.
        await tx.componentMaster.upsert({
          where: { componentId: BigInt(input.componentId) },
          create: { componentId: BigInt(input.componentId), name: `component-${input.componentId}` },
          update: {},
        });
        return toCommonKitView(
          await tx.commonKitDefinition.upsert({
            where: { componentId: BigInt(input.componentId) },
            create: { componentId: BigInt(input.componentId), minQty: input.minQty, active },
            update: { minQty: input.minQty, active },
          }),
        );
      },
    );
  }
}

function toCommonKitView(row: {
  id: bigint;
  componentId: bigint;
  minQty: number;
  active: boolean;
}): CommonKitView {
  return {
    id: Number(row.id),
    componentId: Number(row.componentId),
    minQty: row.minQty,
    active: row.active,
  };
}
