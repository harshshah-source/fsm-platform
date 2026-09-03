import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { type ActingContext, notActing } from '../../auth/acting-context';
import type { AccessTokenClaims } from '../../auth/token.service';
import { resolveRequestActor, type RequestActor } from '../request-actor';

/** Request shape this decorator reads: the claims `AuthGuard` attached + the acting context
 *  `ActingContextGuard` proved (#339). */
interface ActorRequest {
  user: AccessTokenClaims;
  acting?: ActingContext;
}

/**
 * Resolves the request's {@link RequestActor} once at the controller seam — the caller's real
 * role plus any acting attribution (`acted_as_role` / `acting_zone`) derived from the
 * acting context. Controllers inject this (instead of `@CurrentUser()`) wherever the value is handed
 * to an audited service, so acting attribution actually reaches the audit row.
 *
 * #339 — the attribution is whatever `ActingContextGuard` *proved*, never a re-parse of the header
 * here. A request that reaches a controller with no acting context is not acting: falling back to
 * re-deriving it would restore the ungated grant the guard exists to remove.
 */
export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestActor => {
    const request = ctx.switchToHttp().getRequest<ActorRequest>();
    return resolveRequestActor(request.user, request.acting ?? notActing(request.user.role));
  },
);
