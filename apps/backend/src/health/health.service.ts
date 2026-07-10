import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ReadinessResult {
  status: 'ok' | 'error';
  db: 'up' | 'down';
}

/**
 * Backing checks for the general health probes (#98 leg 4). Liveness is a pure "process is up" answer
 * with no dependencies; readiness confirms the one hard dependency — the database — is reachable.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Cheap DB round-trip; `down` (never a thrown error) so the probe can map it to 503 cleanly. */
  async readiness(): Promise<ReadinessResult> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'up' };
    } catch (err) {
      this.logger.error(`readiness DB check failed: ${err instanceof Error ? err.message : String(err)}`);
      return { status: 'error', db: 'down' };
    }
  }
}
