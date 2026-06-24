import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface PlannerScope {
  role: string;
  zoneId: number | null;
}

export interface PlannerActor {
  userId: string;
  role: string;
}

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
  constructor(private readonly prisma: PrismaService) {}

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
    const entry = await this.prisma.sePlanner.upsert({
      where: { seId_plantId_plannedDate: { seId: input.seId, plantId, plannedDate } },
      create: { seId: input.seId, plantId, plannedDate, createdBy: actor.userId },
      update: {},
    });
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

  async remove(id: string, scope: PlannerScope): Promise<RemoveOutcome> {
    const entry = await this.prisma.sePlanner.findUnique({
      where: { id: BigInt(id) },
      include: { plant: { select: { zoneId: true } } },
    });
    if (!entry) return { result: 'NOT_FOUND' };
    if (!this.inScope(entry.plant.zoneId, scope)) return { result: 'OUT_OF_SCOPE' };
    await this.prisma.sePlanner.delete({ where: { id: entry.id } });
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
