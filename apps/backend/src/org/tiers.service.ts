import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** API shape of a tier — the canonical list + order as data (Issue 157 AC-1). */
export interface TierView {
  name: string;
  rank: number;
}

@Injectable()
export class TiersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<TierView[]> {
    return this.prisma.tier.findMany({ orderBy: { rank: 'asc' } });
  }
}
