import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AccessTokenClaims } from '../../auth/token.service';

interface ZoneScopedRequest {
  user?: AccessTokenClaims;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
}

/**
 * ZoneScopeGuard — third link in the chain (after AuthGuard attaches `request.user`).
 * A ZONAL_MANAGER may only touch their own zone; targeting another zone via a `:zoneId`
 * route param or `zone_id` query param is rejected with 403 ZONE_SCOPE_VIOLATION.
 * Cross-zone roles (CSM / Operations Head / Warehouse) are not zone-restricted.
 */
@Injectable()
export class ZoneScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ZoneScopedRequest>();
    const user = request.user;

    if (!user || user.role !== 'ZONAL_MANAGER') {
      return true;
    }

    const requestedZone = extractZoneId(request);
    if (requestedZone === undefined) {
      return true; // no explicit zone target on this request
    }

    if (requestedZone !== user.zone_id) {
      throw new ForbiddenException('ZONE_SCOPE_VIOLATION');
    }

    return true;
  }
}

function extractZoneId(request: ZoneScopedRequest): number | undefined {
  const raw = request.params?.zoneId ?? request.query?.zone_id;
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  const value = Number(raw);
  return Number.isNaN(value) ? undefined : value;
}
