import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { ConfigActor } from '../common/config-actor';
import { $Enums } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** API shape of a company. BigInt id surfaced as a JSON-safe number. */
export interface CompanyView {
  companyId: number;
  name: string;
  companyTier: string;
  companyPriorityRank: string;
  opsOverride: boolean;
}

export interface CreateCompanyInput {
  name: string;
  companyTier: string;
  companyPriorityRank: string;
}

const TIERS = new Set<string>(Object.values($Enums.CompanyTier));
/** Priority rank is a single uppercase letter (A / B / C …) — schema D1 tie-break. */
const RANK = /^[A-Z]$/;

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<CompanyView[]> {
    const rows = await this.prisma.company.findMany({ orderBy: { companyId: 'asc' } });
    return rows.map(toCompanyView);
  }

  /** Creates a company (tier + priority rank), audited (AC#6). Bad tier/rank → 400. */
  async create(input: CreateCompanyInput, actor: ConfigActor): Promise<CompanyView> {
    if (!TIERS.has(input.companyTier)) {
      throw new BadRequestException(`Invalid company tier: ${input.companyTier}`);
    }
    if (!RANK.test(input.companyPriorityRank)) {
      throw new BadRequestException(
        `Invalid company priority rank: ${input.companyPriorityRank}`,
      );
    }
    return this.audit.withAudit(
      {
        actorId: actor.user_id,
        actorRole: actor.role,
        actedAsRole: actor.acted_as_role ?? null,
        action: 'COMPANY_CREATED',
        entityType: 'company_master',
        entityId: input.name,
      },
      async (tx) =>
        toCompanyView(
          await tx.company.create({
            data: {
              name: input.name,
              companyTier: input.companyTier as $Enums.CompanyTier,
              companyPriorityRank: input.companyPriorityRank,
            },
          }),
        ),
    );
  }
}

function toCompanyView(row: {
  companyId: bigint;
  name: string;
  companyTier: string;
  companyPriorityRank: string;
  opsOverride: boolean;
}): CompanyView {
  return {
    companyId: Number(row.companyId),
    name: row.name,
    companyTier: row.companyTier,
    companyPriorityRank: row.companyPriorityRank,
    opsOverride: row.opsOverride,
  };
}
