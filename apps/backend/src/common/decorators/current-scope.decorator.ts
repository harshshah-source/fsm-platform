import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { type ActingContext, notActing } from '../../auth/acting-context';
import type { AccessTokenClaims } from '../../auth/token.service';
import { resolveManagerScope, type ManagerScope } from '../manager-scope';

/** Request shape this decorator reads: the claims `AuthGuard` attached + the acting context
 *  `ActingContextGuard` proved (#339). */
interface ScopedRequest {
  user: AccessTokenClaims;
  acting?: ActingContext;
}

/**
 * The read scope for a manager surface — `{ role, zoneId }` with the request's proven acting context
 * folded in (see {@link resolveManagerScope}). Controllers inject this instead of hand-building
 * `{ role: user.role, zoneId: user.zone_id }` from `@CurrentUser()`, which silently ignored acting.
 *
 * #339 — reads `request.acting`, which `ActingContextGuard` has already gated; no acting context
 * means not acting, deliberately, rather than a re-parse of the header.
 */
export const CurrentScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ManagerScope => {
    const request = ctx.switchToHttp().getRequest<ScopedRequest>();
    return resolveManagerScope(request.user, request.acting ?? notActing(request.user.role));
  },
);
