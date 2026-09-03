import { Injectable } from '@nestjs/common';
import { AuditService, type AuditActorFields } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

export interface PlannerScope {
  role: string;
  zoneId: number | null;
}

export interface PlannerActor {
  userId: string;
  role: string;
  actedAsRole?: string | null;
  /** The zone whose ZM duty this write is being made under, when the caller is acting (#340). */
  actingZone?: number | null;
}

/**
 * A planner cell's stable identity: SE × plant × date, the same triple the table is unique on. Audit
 * rows key on this rather than on `se_planner.id`, because a cell that is planned, removed and
 * planned again gets a fresh autoincrement each time — keying on the id would scatter one cell's
 * history across as many entities as it had lives, and the whole point of the row is to answer "what
 * happened to *this* cell".
 */
const cellId = (seId: string, plantId: bigint, plannedDate: Date): string =>
  `${seId}:${plantId}:${plannedDate.toISOString().slice(0, 10)}`;

export interface PlannerEntryView {
  id: string;
  seId: string;
  plantId: string;
  plannedDate: string;
}

export interface PlannerPlantView {
  plantId: string;
  name: string;
  zoneId: string;
}

export type UpsertOutcome =
  | { result: 'OK'; entry: PlannerEntryView }
  | { result: 'OUT_OF_SCOPE' }
  | { result: 'NOT_FOUND' };

export type RemoveOutcome = { result: 'OK' } | { result: 'OUT_OF_SCOPE' } | { result: 'NOT_FOUND' };

/**
 * SE Planner CRUD (Issue 14a, ADR-0022). ZM-authored plant-visit intents (SE × plant × date),
 * idempotent on the (se, plant, date) unique. Zone-scoped by the plant's zone: a ZONAL_MANAGER may
 * only plan plants in their own zone; CSM / Operations Head are cross-zone. The Morning Batch reads
 * these as a soft bias (see RecommenderService).
 */
@Injectable()
export class SePlannerService {
  constructor(
    private readonly prisma: PrismaService,
    // Defaulted so the specs that construct this service directly keep working; Nest injects the
    // module singleton, so the default is never used at runtime.
    private readonly audit: AuditService = new AuditService(prisma),
  ) {}

  /** The who/where of a planner write as an audit row wants it (`PlannerActor`'s acting fields are
   *  optional, so they are normalised here rather than at each call site). */
  private auditFields(actor: PlannerActor): AuditActorFields {
    return {
      actorId: actor.userId,
      actorRole: actor.role,
      actedAsRole: actor.actedAsRole ?? null,
      actingZone: actor.actingZone ?? null,
    };
  }

  async upsert(
    input: { seId: string; plantId: string; plannedDate: string },
    scope: PlannerScope,
    actor: PlannerActor,
  ): Promise<UpsertOutcome> {
    const plantId = BigInt(input.plantId);
    const plant = await this.prisma.plant.findUnique({ where: { plantId }, select: { zoneId: true } });
    if (!plant) return { result: 'NOT_FOUND' };
    if (!this.inScope(plant.zoneId, scope)) return { result: 'OUT_OF_SCOPE' };

    const plannedDate = new Date(input.plannedDate);
    // #343 — a planner cell is a dispatch intent the Morning Batch reads as a bias, so a day that went
    // wrong has to be traceable to whoever biased it. Audited in the same transaction as the upsert.
    // The write is idempotent and the audit row is not: re-affirming a cell is still someone saying
    // "yes, this one", and collapsing that into silence would hide a manager overriding a colleague.
    const entry = await this.audit.withAudit(
      {
        ...this.auditFields(actor),
        action: 'PLANNER_ENTRY_SET',
        entityType: 'se_planner',
        entityId: cellId(input.seId, plantId, plannedDate),
        metadata: {
          seId: input.seId,
          plantId: String(plantId),
          plannedDate: plannedDate.toISOString().slice(0, 10),
          zoneId: String(plant.zoneId),
        },
      },
      (tx) =>
        tx.sePlanner.upsert({
          where: { seId_plantId_plannedDate: { seId: input.seId, plantId, plannedDate } },
          create: { seId: input.seId, plantId, plannedDate, createdBy: actor.userId },
          update: {},
        }),
    );
    return { result: 'OK', entry: this.view(entry) };
  }

  async list(range: { dateFrom: string; dateTo: string }, scope: PlannerScope): Promise<PlannerEntryView[]> {
    const entries = await this.prisma.sePlanner.findMany({
      where: {
        plannedDate: { gte: new Date(range.dateFrom), lte: new Date(range.dateTo) },
        ...(scope.role === 'ZONAL_MANAGER' && scope.zoneId != null
          ? { plant: { zoneId: BigInt(scope.zoneId) } }
          : {}),
      },
      orderBy: [{ plannedDate: 'asc' }, { seId: 'asc' }],
    });
    return entries.map((e) => this.view(e));
  }

  /**
   * Zone-scoped, manager-readable plant list — the planner grid's plant picker + cell labels (Issue
   * 14b). A ZONAL_MANAGER sees only their own zone; cross-zone roles (CSM / Operations Head) see all.
   * Distinct from the Ops-Head-only `/api/org/plants`, which a ZM cannot read.
   */
  async listPlants(scope: PlannerScope): Promise<PlannerPlantView[]> {
    const plants = await this.prisma.plant.findMany({
      where:
        scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? { zoneId: BigInt(scope.zoneId) } : undefined,
      orderBy: { plantId: 'asc' },
    });
    return plants.map((p) => ({ plantId: String(p.plantId), name: p.name, zoneId: String(p.zoneId) }));
  }

  /**
   * Delete a cell. `actor` is optional only so the pre-#343 direct callers (specs) keep compiling;
   * every HTTP caller passes one, and an unattributed delete is exactly what this slice removed.
   */
  async remove(id: string, scope: PlannerScope, actor?: PlannerActor): Promise<RemoveOutcome> {
    const entry = await this.prisma.sePlanner.findUnique({
      where: { id: BigInt(id) },
      include: { plant: { select: { zoneId: true } } },
    });
    if (!entry) return { result: 'NOT_FOUND' };
    if (!this.inScope(entry.plant.zoneId, scope)) return { result: 'OUT_OF_SCOPE' };

    const entity = cellId(entry.seId, entry.plantId, entry.plannedDate);
    const metadata = {
      seId: entry.seId,
      plantId: String(entry.plantId),
      plannedDate: entry.plannedDate.toISOString().slice(0, 10),
      entryId: String(entry.id),
      createdBy: entry.createdBy,
    };
    // A removed intent is the half nobody can reconstruct from the table afterwards — the row is gone,
    // so without this the cell's disappearance has no author and no date.
    await this.audit.withAudit(
      {
        ...this.auditFields(actor ?? { userId: 'SYSTEM', role: 'SYSTEM' }),
        action: 'PLANNER_ENTRY_REMOVED',
        entityType: 'se_planner',
        entityId: entity,
        metadata,
      },
      (tx) => tx.sePlanner.delete({ where: { id: entry.id } }),
    );
    return { result: 'OK' };
  }

  private inScope(zoneId: bigint, scope: PlannerScope): boolean {
    if (scope.role === 'ZONAL_MANAGER') return scope.zoneId != null && BigInt(scope.zoneId) === zoneId;
    return true;
  }

  private view(e: { id: bigint; seId: string; plantId: bigint; plannedDate: Date }): PlannerEntryView {
    return {
      id: String(e.id),
      seId: e.seId,
      plantId: String(e.plantId),
      plannedDate: e.plannedDate.toISOString().slice(0, 10),
    };
  }
}
