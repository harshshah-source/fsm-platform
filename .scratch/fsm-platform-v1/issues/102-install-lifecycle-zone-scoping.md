# 102 — Install-lifecycle zone scoping (close cross-zone privilege escalation)
Status: ready-for-agent
Type: AFK

> Source: `docs/audits/2026-07-03-backend-production-readiness-audit.md` — HIGH #9. Verified
> still-open 2026-07-07: `ticketing/install-lifecycle.service.ts` `load()` and `getInstallView()`
> are `findUnique` by `ticketId` with **no zone predicate**; `scheduleInstall` / `markOnSite` /
> `markFitted` / `getInstallView` check role or assigned-SE only. The create/CSV paths already pass
> scope, and dashboard/reports/verification clamp ZM zone correctly — the install *transitions*
> dropped it.

## What to build

Add zone scoping to the install lifecycle so a zone-1 ZM cannot schedule SEs onto, transition, or
read install tickets in zone 2, and an SE cannot read arbitrary install tickets' serials. Mirror the
zone-clamp pattern the create/CSV path and the other manager services already use — resolve the
ticket's zone (via plant → zone) and reject/notFound when a ZM actor's zone doesn't match. CSM/OH
retain cross-zone authority; the assigned SE retains its own-ticket access.

## Acceptance criteria

- [ ] `scheduleInstall`, `markOnSite`, `markFitted`, and `getInstallView` clamp a ZONAL_MANAGER actor to their home zone; a ZM acting on an out-of-zone install ticket gets FORBIDDEN/NOT_FOUND consistent with the rest of the codebase.
- [ ] The install-ticket read path (serial visibility, AC#5) does not leak out-of-zone serials to a ZM/SE outside scope.
- [ ] CSM/OH cross-zone authority and assigned-SE own-ticket access are preserved (no regression on the existing install e2e).
- [ ] Tests cover: ZM in-zone success, ZM out-of-zone denial for each transition + the read, CSM/OH cross-zone success.

## UI surfaces
n/a (backend; the admin Install UI #69 already scopes by the ZM's zone and is unaffected)

## Reference
n/a

## Blocked by
None — can start immediately.
