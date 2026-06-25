import { BadRequestException, Injectable } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { PrismaService } from '../prisma/prisma.service';

export interface SlaRuleView {
  scope: string;
  key: string;
  submitWithinMinutes: number | null;
  verifyWithinMinutes: number | null;
  escalateAfterMinutes: number | null;
}

export interface UpsertSlaRuleInput {
  scope: string;
  key: string;
  submitWithinMinutes?: number | null;
  verifyWithinMinutes?: number | null;
  escalateAfterMinutes?: number | null;
}

const SCOPES = new Set(['bucket', 'company_tier']);

/** Operations-Head-owned SLA windows (`sla_rule_config`), keyed by (scope, key). */
@Injectable()
export class SlaRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<SlaRuleView[]> {
    const rows = await this.prisma.slaRuleConfig.findMany({ orderBy: { id: 'asc' } });
    return rows.map(toSlaRuleView);
  }

  /** Upserts one rule by (scope, key), audited (AC#6). Bad scope / negative window → 400. */
  async upsert(input: UpsertSlaRuleInput, actor: RequestActor): Promise<SlaRuleView> {
    if (!SCOPES.has(input.scope)) {
      throw new BadRequestException(`Invalid SLA scope: ${input.scope}`);
    }
    const windows = {
      submitWithinMinutes: normalize(input.submitWithinMinutes),
      verifyWithinMinutes: normalize(input.verifyWithinMinutes),
      escalateAfterMinutes: normalize(input.escalateAfterMinutes),
    };
    return this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'SLA_RULE_UPDATED',
        entityType: 'sla_rule_config',
        entityId: `${input.scope}:${input.key}`,
      },
      async (tx) =>
        toSlaRuleView(
          await tx.slaRuleConfig.upsert({
            where: { scope_key: { scope: input.scope, key: input.key } },
            create: { scope: input.scope, key: input.key, ...windows },
            update: windows,
          }),
        ),
    );
  }
}

/** Validates an optional SLA window: undefined → null, otherwise a positive integer. */
function normalize(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new BadRequestException('SLA windows must be positive integers');
  }
  return value;
}

function toSlaRuleView(row: {
  scope: string;
  key: string;
  submitWithinMinutes: number | null;
  verifyWithinMinutes: number | null;
  escalateAfterMinutes: number | null;
}): SlaRuleView {
  return {
    scope: row.scope,
    key: row.key,
    submitWithinMinutes: row.submitWithinMinutes,
    verifyWithinMinutes: row.verifyWithinMinutes,
    escalateAfterMinutes: row.escalateAfterMinutes,
  };
}
