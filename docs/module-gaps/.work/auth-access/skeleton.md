# skeleton — Auth, Roles & Acting-Scope (auth-access)
generated 2026-09-02 · 0 TEQ · source: gapscope.profile.json

## admin routes (declared)
- `/login` — AppRoutes.tsx:64 → <LoginPage>

## backend endpoints
### apps/backend/src/auth/auth.controller.ts  `@Controller('auth')`
- `POST /api/auth/login` → `login()` :21
- `POST /api/auth/refresh` → `refresh()` :34
- `POST /api/auth/logout` → `logout()` :43

### apps/backend/src/roles/role-backup.controller.ts  `@Controller('')`
- `POST /api/role-unavailability` → `mark()` :41
- `GET /api/reports/csm-approval-share` → `report()` :59

### apps/backend/src/me/me.controller.ts  `@Controller('me')`
- `GET /api/me` → `me()` :15

## backend units (services / schedulers / jobs)
- `apps/backend/src/auth/acting-context.ts` — if():29 · if():36
- `apps/backend/src/auth/auth-fixture-seed.ts` — for():125
- `apps/backend/src/auth/auth.service.ts` — class AuthService:9 · login():17 · refresh():25 · logout():44
- `apps/backend/src/auth/credential-seed.ts` — if():18
- `apps/backend/src/auth/dev-seed.config.ts` — if():50 · if():56 · if():66 · if():77
- `apps/backend/src/auth/dev-seed.ts` — if():61 · if():65
- `apps/backend/src/auth/prisma-refresh-token-store.ts` — class PrismaRefreshTokenStore:38 · issue():41 · consume():67 · revoke():85 · revokeAllForUser():98
- `apps/backend/src/auth/prisma-user-store.ts` — class PrismaUserStore:18 · findById():21 · validateCredentials():32
- `apps/backend/src/auth/token.service.ts` — class TokenService:17 · signAccessToken():24 · verifyAccessToken():35 · if():73
- `apps/backend/src/roles/role-backup.service.ts` — class RoleBackupService:41 · markUnavailable():44 · isRoleUnavailable():64 · currentActingRoleForZone():77 · csmBackupShareByZone():88
- `apps/backend/src/me/me-profile.service.ts` — class MeProfileService:11 · getSeProfile():17

## admin UI files
- `apps/admin/src/auth/AuthProvider.tsx` — 166 loc · **no data hook**
- `apps/admin/src/auth/ProtectedRoute.tsx` — 21 loc · **no data hook**
- `apps/admin/src/auth/RoleRoute.tsx` — 21 loc · **no data hook**

## admin api client calls (apps/admin/src/api)

## mobile screens
- `apps/mobile/src/auth/AppEntry.tsx` — 29 loc
- `apps/mobile/src/auth/AuthProvider.tsx` — 89 loc
- `apps/mobile/src/auth/LoginScreen.tsx` — 254 loc
- `apps/mobile/src/auth/SessionScreen.tsx` — 23 loc
- `apps/mobile/src/auth/tokenStore.ts` — 29 loc

## tests touching this module
- `apps/backend/test/auth.e2e-spec.ts`
- `apps/backend/test/shared-auth-se-canonical-seed.e2e-spec.ts`
- `apps/backend/test/shared-auth-se-fixture-guard.spec.ts`
- `apps/mobile/src/auth/AuthProvider.test.tsx`
