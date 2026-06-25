import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
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

/** Partial update of a company's commercial classification (Issue 46). */
export interface UpdateCompanyInput {
  companyTier?: string;
  companyPriorityRank?: string;
  opsOverride?: boolean;
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
  async create(input: CreateCompanyInput, actor: RequestActor): Promise<CompanyView> {
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
        ...auditActor(actor),
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

  /**
   * Updates a company's commercial classification (tier / priority rank / ops-override), audited
   * (`COMPANY_UPDATED`). Setting `opsOverride = true` is the manual override of CRM/SAP-sourced tier
   * (CONTEXT "Operations Head can override per-company"). Unknown id → 404; bad tier/rank → 400.
   */
  async update(companyId: number, input: UpdateCompanyInput, actor: RequestActor): Promise<CompanyView> {
    if (input.companyTier !== undefined && !TIERS.has(input.companyTier)) {
      throw new BadRequestException(`Invalid company tier: ${input.companyTier}`);
    }
    if (input.companyPriorityRank !== undefined && !RANK.test(input.companyPriorityRank)) {
      throw new BadRequestException(`Invalid company priority rank: ${input.companyPriorityRank}`);
    }
    const existing = await this.prisma.company.findUnique({ where: { companyId: BigInt(companyId) } });
    if (!existing) throw new NotFoundException(`Company not found: ${companyId}`);

    return this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'COMPANY_UPDATED',
        entityType: 'company_master',
        entityId: existing.name,
        metadata: {
          companyTier: input.companyTier ?? null,
          companyPriorityRank: input.companyPriorityRank ?? null,
          opsOverride: input.opsOverride ?? null,
          previous: {
            companyTier: existing.companyTier,
            companyPriorityRank: existing.companyPriorityRank,
            opsOverride: existing.opsOverride,
          },
        },
      },
      async (tx) =>
        toCompanyView(
          await tx.company.update({
            where: { companyId: BigInt(companyId) },
            data: {
              ...(input.companyTier !== undefined ? { companyTier: input.companyTier as $Enums.CompanyTier } : {}),
              ...(input.companyPriorityRank !== undefined ? { companyPriorityRank: input.companyPriorityRank } : {}),
              ...(input.opsOverride !== undefined ? { opsOverride: input.opsOverride } : {}),
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
