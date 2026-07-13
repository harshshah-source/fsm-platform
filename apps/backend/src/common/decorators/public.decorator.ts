import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opt-out of the global AuthGuard (#99). Every route is authenticated by default; the ONLY
 * legitimately tokenless surfaces are login/refresh, the health probes, and the customer
 * non-op confirmation link. Adding this anywhere else must be a conscious decision — the
 * route-guard sweep test (`test/global-guard-validation.e2e-spec.ts`) fails until its public
 * allowlist is edited to match.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
