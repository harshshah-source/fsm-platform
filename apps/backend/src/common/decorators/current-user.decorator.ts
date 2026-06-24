import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AccessTokenClaims } from '../../auth/token.service';

/** Returns the verified token claims that AuthGuard attached to the request. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenClaims => {
    const request = ctx.switchToHttp().getRequest<{ user: AccessTokenClaims }>();
    return request.user;
  },
);
