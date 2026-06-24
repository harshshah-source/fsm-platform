import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/** Declares the role allow-list for a route or controller. Read by RoleGuard. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
