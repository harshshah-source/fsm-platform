import { BadRequestException, Injectable } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { PrismaService } from '../prisma/prisma.service';

export interface ScoringWeightView {
  weightSetRef: string;
  component: string;
  weight: number;
  active: boolean;
}

export interface UpsertScoringWeightInput {
  weightSetRef: string;
  component: string;
  weight: number;
  active?: boolean;
}

/** Operations-Head-owned, versioned Recommender scoring weights (`priority_rule_config`). */
@Injectable()
export class ScoringWeightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(weightSetRef?: string): Promise<ScoringWeightView[]> {
    const rows = await this.prisma.priorityRuleConfig.findMany({
      where: weightSetRef === undefined ? undefined : { weightSetRef },
      orderBy: { id: 'asc' },
    });
    return rows.map(toScoringWeightView);
  }

  /** Upserts one weight by (weightSetRef, component), audited (AC#6). Bad inputs → 400. */
  async upsert(input: UpsertScoringWeightInput, actor: RequestActor): Promise<ScoringWeightView> {
    if (typeof input.weightSetRef !== 'string' || input.weightSetRef.trim() === '') {
      throw new BadRequestException('weightSetRef is required');
    }
    if (typeof input.component !== 'string' || input.component.trim() === '') {
      throw new BadRequestException('component is required');
    }
    if (typeof input.weight !== 'number' || !Number.isFinite(input.weight)) {
      throw new BadRequestException('weight must be a finite number');
    }
    const active = input.active ?? true;
    return this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'SCORING_WEIGHT_UPDATED',
        entityType: 'priority_rule_config',
        entityId: `${input.weightSetRef}:${input.component}`,
      },
      async (tx) =>
        toScoringWeightView(
          await tx.priorityRuleConfig.upsert({
            where: {
              weightSetRef_component: {
                weightSetRef: input.weightSetRef,
                component: input.component,
              },
            },
            create: {
              weightSetRef: input.weightSetRef,
              component: input.component,
              weight: input.weight,
              active,
            },
            update: { weight: input.weight, active },
          }),
        ),
    );
  }
}

function toScoringWeightView(row: {
  weightSetRef: string;
  component: string;
  weight: unknown;
  active: boolean;
}): ScoringWeightView {
  return {
    weightSetRef: row.weightSetRef,
    component: row.component,
    weight: Number(row.weight),
    active: row.active,
  };
}
