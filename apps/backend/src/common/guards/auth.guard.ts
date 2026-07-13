import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenClaims, TokenService } from '../../auth/token.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/** Minimal shape of the bits of the HTTP request this guard reads and augments. */
interface AuthableRequest {
  headers: { authorization?: string };
  user?: AccessTokenClaims;
}

/**
 * AuthGuard — first link in the guard chain (AuthGuard → RoleGuard → ZoneScopeGuard
 * → IdempotencyInterceptor). Rejects callers without a valid Bearer token and, on
 * success, attaches the verified claims to `request.user` for downstream guards and
 * the `@CurrentUser()` decorator. Registered globally as `APP_GUARD` (#99): every route
 * authenticates by default; `@Public()` on the handler or controller opts out.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthableRequest>();
    const header = request.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException();
    }

    try {
      request.user = this.tokens.verifyAccessToken(header.slice('Bearer '.length));
    } catch {
      throw new UnauthorizedException();
    }

    return true;
  }
}
