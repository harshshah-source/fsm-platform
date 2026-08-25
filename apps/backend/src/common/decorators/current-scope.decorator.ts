import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AccessTokenClaims } from '../../auth/token.service';
import { resolveManagerScope, type ManagerScope } from '../manager-scope';

/** Request shape this decorator reads: the claims AuthGuard attached + the acting-zone header. */
interface ScopedRequest {
  user: AccessTokenClaims;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * The read scope for a manager surface — `{ role, zoneId }` with the `X-Acting-As-Zone` header folded
 * in (see {@link resolveManagerScope}). Controllers inject this instead of hand-building
 * `{ role: user.role, zoneId: user.zone_id }` from `@CurrentUser()`, which silently ignored acting.
 */
export const CurrentScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ManagerScope => {
    const request = ctx.switchToHttp().getRequest<ScopedRequest>();
    const header = request.headers['x-acting-as-zone'];
    return resolveManagerScope(request.user, Array.isArray(header) ? header[0] : header);
  },
);
