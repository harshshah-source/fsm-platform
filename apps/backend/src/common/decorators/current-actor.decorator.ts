import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AccessTokenClaims } from '../../auth/token.service';
import { resolveRequestActor, type RequestActor } from '../request-actor';

/** Request shape this decorator reads: the claims AuthGuard attached + the acting-zone header. */
interface ActorRequest {
  user: AccessTokenClaims;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Resolves the request's {@link RequestActor} once at the controller seam — the caller's real
 * role plus any acting attribution (`acted_as_role` / `acting_zone`) derived from the
 * `X-Acting-As-Zone` header. Controllers inject this (instead of `@CurrentUser()`) wherever the
 * value is handed to an audited service, so acting attribution actually reaches the audit row.
 */
export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestActor => {
    const request = ctx.switchToHttp().getRequest<ActorRequest>();
    const header = request.headers['x-acting-as-zone'];
    return resolveRequestActor(request.user, Array.isArray(header) ? header[0] : header);
  },
);
