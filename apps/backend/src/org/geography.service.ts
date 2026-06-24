import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface RegionView {
  regionId: number;
  name: string;
  state: string;
}
export interface DistrictView {
  districtId: number;
  name: string;
  state: string;
  regionId: number | null;
}

/**
 * Admin-geography reads (`regions` / `districts`) backing the Floating-SE territory hierarchical
 * selector (Issue 09). States → regions → districts, each filterable by its parent so the UI can
 * cascade State → Region → District. Reference data (Operations-Head/seed-owned); read-only here.
 */
@Injectable()
export class GeographyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Distinct states across regions and districts, sorted. */
  async listStates(): Promise<string[]> {
    const [regions, districts] = await Promise.all([
      this.prisma.region.findMany({ select: { state: true }, distinct: ['state'] }),
      this.prisma.district.findMany({ select: { state: true }, distinct: ['state'] }),
    ]);
    return [...new Set([...regions, ...districts].map((r) => r.state))].sort();
  }

  async listRegions(state?: string): Promise<RegionView[]> {
    const rows = await this.prisma.region.findMany({
      where: state === undefined ? undefined : { state },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({ regionId: Number(r.regionId), name: r.name, state: r.state }));
  }

  async listDistricts(state?: string, regionId?: number): Promise<DistrictView[]> {
    const rows = await this.prisma.district.findMany({
      where: {
        ...(state === undefined ? {} : { state }),
        ...(regionId === undefined ? {} : { regionId: BigInt(regionId) }),
      },
      orderBy: { name: 'asc' },
    });
    return rows.map((d) => ({
      districtId: Number(d.districtId),
      name: d.name,
      state: d.state,
      regionId: d.regionId === null ? null : Number(d.regionId),
    }));
  }
}
