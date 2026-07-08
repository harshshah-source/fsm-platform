import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from './user-store';

/**
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * DEVELOPMENT-ONLY SCAFFOLD — REMOVE WITH ISSUE #91 (Postgres-backed auth).
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Why this exists. The temporary {@link InMemoryUserStore} hard-codes each zone-scoped dev user's
 * `zoneId` (e.g. the dev Zonal Manager → `zoneId: 1`). But `zones.zone_id` is an autoincrement PK,
 * and different datasets seed different zones (org-seed: North/South; Book harness:
 * EAST/NORTH/SOUTH/WEST). So the frozen literal `1` only coincidentally matches a real seeded zone,
 * and a dev Zonal Manager cannot reach zone-scoped dashboards once non-trivial org data is loaded.
 *
 * This resolver lets the dev login adopt a *live* seeded zone instead of the frozen literal — WITHOUT
 * touching credentials, the JWT format, the `{user_id, role, zone_id}` claim shape, the guard chain,
 * or RBAC. It only rewrites the `zone_id` reference value for a synthetic dev user that has ALREADY
 * been authenticated against the in-memory store. Authentication itself stays 100% in-memory; this is
 * NOT database-backed auth (that is Issue #91).
 *
 * Opt-in, default-off. Controlled by the `DEV_AUTH_ZONE` env var:
 *   • unset (default — production, CI, every existing test): behaviour is byte-identical to today.
 *       NO database query runs; the user's static seed `zoneId` is returned unchanged.
 *   • "first":        resolve the lowest-id seeded zone (tracks ANY dataset with zero further edits).
 *   • "<zone name>":  case-insensitive lookup by `zones.name` (e.g. "NORTH").
 *   • "<number>":     use that literal zone id (explicit escape hatch).
 * If a configured value resolves to nothing (empty DB / unknown name), it falls back to the user's
 * static seed `zoneId` and logs a dev warning — login never fails because of this scaffold.
 *
 * Fleet-wide roles (`zoneId === null`: Operations Head / CSM / Warehouse Manager) are never touched.
 *
 * Removal (Issue #91): delete this file, its provider registration in `auth.module.ts`, the
 * `DevZoneResolver` injection + `resolveZoneId` call in `auth.service.ts`, and the `DEV_AUTH_ZONE`
 * line in `.env.example`. Once login reads real `users` rows, `zone_id` comes from `users.zone_id`
 * and this scaffold has no reason to exist.
 */
@Injectable()
export class DevZoneResolver {
  private readonly logger = new Logger(DevZoneResolver.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the effective `zone_id` claim for a dev user. Identity to the user's static `zoneId`
   * unless `DEV_AUTH_ZONE` is set and the user is zone-scoped.
   */
  async resolveZoneId(user: AuthenticatedUser): Promise<number | null> {
    // Fleet-wide roles are never zone-scoped — pass through untouched (also skips the DB entirely).
    if (user.zoneId === null) return null;

    const setting = process.env.DEV_AUTH_ZONE?.trim();
    if (!setting) return user.zoneId; // default OFF → today's exact behaviour, no DB read.

    const resolved = await this.lookup(setting);
    if (resolved === null) {
      this.logger.warn(
        `DEV_AUTH_ZONE="${setting}" did not resolve to a seeded zone; ` +
          `falling back to static dev zoneId=${user.zoneId}. (Dev scaffold — Issue #91.)`,
      );
      return user.zoneId;
    }
    return resolved;
  }

  private async lookup(setting: string): Promise<number | null> {
    // Numeric literal → use directly (escape hatch; no DB round-trip needed).
    if (/^\d+$/.test(setting)) return Number(setting);

    const zone =
      setting.toLowerCase() === 'first'
        ? await this.prisma.zone.findFirst({
            orderBy: { zoneId: 'asc' },
            select: { zoneId: true },
          })
        : await this.prisma.zone.findFirst({
            where: { name: { equals: setting, mode: 'insensitive' } },
            select: { zoneId: true },
          });

    return zone ? Number(zone.zoneId) : null;
  }
}
