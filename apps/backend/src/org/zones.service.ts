import { ConflictException, Injectable } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** API shape of a zone. `zoneId` is surfaced as a number (Prisma BigInt → JSON-safe). */
export interface ZoneView {
  zoneId: number;
  name: string;
  zonalManagerUserId: string | null;
}

@Injectable()
export class ZonesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<ZoneView[]> {
    const rows = await this.prisma.zone.findMany({ orderBy: { zoneId: 'asc' } });
    return rows.map(toZoneView);
  }

  /** Creates a zone inside an audited transaction (Issue 02 AC#6). Duplicate name → 409. */
  async create(name: string, actor: RequestActor): Promise<ZoneView> {
    try {
      return await this.audit.withAudit(
        {
          ...auditActor(actor),
          action: 'ZONE_CREATED',
          entityType: 'zones',
          entityId: name,
        },
        async (tx) => toZoneView(await tx.zone.create({ data: { name } })),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Zone name already exists: ${name}`);
      }
      throw err;
    }
  }
}

function toZoneView(row: {
  zoneId: bigint;
  name: string;
  zonalManagerUserId: string | null;
}): ZoneView {
  return {
    zoneId: Number(row.zoneId),
    name: row.name,
    zonalManagerUserId: row.zonalManagerUserId,
  };
}
