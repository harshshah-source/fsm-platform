import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenClaims } from '../../auth/token.service';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * RoleGuard — second link in the chain (after AuthGuard, which attaches `request.user`).
 * Enforces the `@Roles(...)` allow-list declared on the handler or controller. A route
 * with no `@Roles` is unrestricted by role.
 */
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: AccessTokenClaims }>();
    const role = request.user?.role;
    if (!role || !required.includes(role)) {
      throw new ForbiddenException();
    }

    return true;
  }
}
