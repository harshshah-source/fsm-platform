import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AccessTokenClaims, TokenService } from '../../auth/token.service';

/** Minimal shape of the bits of the HTTP request this guard reads and augments. */
interface AuthableRequest {
  headers: { authorization?: string };
  user?: AccessTokenClaims;
}

/**
 * AuthGuard — first link in the guard chain (AuthGuard → RoleGuard → ZoneScopeGuard
 * → IdempotencyInterceptor). Rejects callers without a valid Bearer token and, on
 * success, attaches the verified claims to `request.user` for downstream guards and
 * the `@CurrentUser()` decorator.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  canActivate(context: ExecutionContext): boolean {
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
