import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AccessTokenClaims } from '../../auth/token.service';
import { ACTING_CAPABLE_ROLES, type ActingContext } from '../../auth/acting-context';
import { PrismaService } from '../../prisma/prisma.service';
import { RoleBackupService } from '../../roles/role-backup.service';

/** What this guard reads, and the one field it adds. */
export interface ActingRequest {
  user?: AccessTokenClaims;
  headers: Record<string, string | string[] | undefined>;
  acting?: ActingContext;
}

/**
 * ActingContextGuard (#339) — resolves `X-Acting-As-Zone` **once per request**, into `request.acting`.
 *
 * Two problems, one guard.
 *
 * **It is a gate, not a parse.** Before this, acting was granted to any CSM or Operations Head whose
 * header parsed as a number: `role_unavailability` was never consulted at all (CONTEXT.md §15's whole
 * cascade sat in `RoleBackupService.currentActingRoleForZone` with no callers), an unknown zone id was
 * accepted, and a non-numeric one became `NaN` → null → **pan-India** — the widest scope in the system,
 * reachable by typing nonsense into a header. Now: the zone must exist, and a CSM must actually hold
 * that zone's ZM duty. An Operations Head may act anywhere, because pan-India authority is already
 * theirs by role — the header changes what they *see*, never what they are allowed to reach.
 *
 * **It resolves once.** `manager-scope.ts` and `request-actor.ts` each re-parsed the header
 * independently, so this check bound to any one of them would have left the other two ungated. The
 * lookup is also async (two queries) and the two decorators that consume it are synchronous
 * `createParamDecorator`s — a guard is the only place in the request lifecycle that can do the work
 * *and* keep those decorators. That is the architecture decision recorded in the issue.
 *
 * Registered globally after `AuthGuard` (it needs `request.user`) and before `RoleGuard`, so a route's
 * `@Roles` check and everything downstream see a request whose acting claim has already been proven.
 * A `@Public` route has no user and is left alone; a request with no header costs nothing.
 */
@Injectable()
export class ActingContextGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roleBackup: RoleBackupService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ActingRequest>();
    const user = request.user;
    if (!user) return true; // @Public — AuthGuard already decided, and there is nobody to act as

    const raw = request.headers['x-acting-as-zone'];
    request.acting = await this.resolve(user, Array.isArray(raw) ? raw[0] : raw);
    return true;
  }

  private async resolve(user: AccessTokenClaims, raw: string | undefined): Promise<ActingContext> {
    const notActing: ActingContext = { actorRole: user.role, actedAsRole: null, actingZone: null };
    if (raw === undefined || raw === '') return notActing;
    // A role that cannot act ignores the header exactly as it always has — it is not an error for a
    // ZM's client to send it (the admin shell sends it whenever acting state is set), and refusing
    // would turn a harmless header into a broken session for the one role that cannot widen anyway.
    if (!ACTING_CAPABLE_ROLES.has(user.role)) return notActing;

    const zoneId = parseZoneId(raw);
    if (zoneId === null) throw new BadRequestException({ code: 'ACTING_ZONE_INVALID' });
    const zone = await this.prisma.zone.findUnique({ where: { zoneId: BigInt(zoneId) }, select: { zoneId: true } });
    if (!zone) throw new BadRequestException({ code: 'ACTING_ZONE_INVALID' });

    if (user.role === 'CENTRAL_SERVICE_MANAGER') {
      // The cascade decides, not the claim: a CSM holds a zone's ZM duty only while that ZM is out
      // AND the CSM tier itself is not out (in which case the duty has already passed to Operations
      // Head, and a CSM standing in would be acting for a role they no longer hold).
      const holder = await this.roleBackup.currentActingRoleForZone(zoneId);
      if (holder !== 'CENTRAL_SERVICE_MANAGER') throw new ForbiddenException({ code: 'ACTING_NOT_PERMITTED' });
    }

    return { actorRole: user.role, actedAsRole: user.role, actingZone: zoneId };
  }
}

/**
 * A zone id is a positive integer or it is nothing. `Number('abc')` is `NaN` and `Number('')` is `0`;
 * both used to survive as "no zone", which is why a typo read as pan-India.
 */
function parseZoneId(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}
