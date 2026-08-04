# 212 — Repoint admin to `/api/v1` and retire the unversioned alias

Status: ready-for-agent
Type: AFK · Admin (+ closes [#169](./169-se-api-contract-freeze.md)'s last structural AC)
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04
Blocked by: nothing

## Root cause

#169 introduced `/api/v1` as a *deliberately time-boxed* migration alias rather than a hard switch,
because 90 backend specs and every admin API module called the unversioned path. Mobile pins `/v1`;
admin never moved. The alias was always meant to be removed once admin was repointed, and that
follow-up was never filed — so a migration window with no end date now looks like a permanent design.

**This is not "the unversioned path is a bug".** It was ratified. This issue is its intended closing
move, included in the epic because audit 2's section E flagged the drift between #169's stated scope
and its real state.

## Findings closed

Audit 2 **E** (the `/api/v1` scope finding).

## Evidence — verified 2026-08-04

- `apps/backend/src/app.config.ts:18` — `setGlobalPrefix('api')`; `:27-30` —
  `enableVersioning({ type: VersioningType.URI, defaultVersion: ['1', VERSION_NEUTRAL] })`. No
  controller carries its own `@Version`, so both paths are two URL registrations of the **same
  handler** — byte-identical responses. Pinned by `test/api-versioning.e2e-spec.ts:34-52`.
- Mobile pins v1: `apps/mobile/src/api/client.ts:92`.
- **Admin does not, in 35 separate modules**, each declaring its own
  `const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api'` — `api/http.ts:9`,
  `api/client.ts:3`, and 33 more (`tickets.ts:4`, `schedules.ts:5`, `engineers.ts:6`,
  `dashboard.ts:4`, … `dispatch-runs.ts:6`, `engineersAdmin.ts:6`), plus `apps/admin/.env.example:2`.
- **The trap:** `apps/admin/src/api/http.ts:67` gates the whole 401 interceptor on
  `url.startsWith(BASE_URL)`. A *partial* repoint silently disables refresh-and-retry for exactly the
  modules that moved — failing open, with no error.
- Ratified as temporary: `mobile-backend-freeze-plan-2026-07-28.md:165`;
  `mobile-backend-independent-assessment-2026-07-28.md:318` ("`/api/v1` now. It costs a prefix today
  and is unobtainable later"); `#169:149-152` — "**the neutral alias is the migration window — do not
  remove it until the admin client is repointed, which is a deliberate follow-up, not a tidy-up**".
- `#169:77` AC: "Routes served under `/api/v1`; the un-versioned path either redirects or is retired
  deliberately" — currently unticked, and unachievable until this lands.
- `#169:41`'s body text ("no `enableVersioning`") is stale — corrected by [#211](./211-status-truth-doc-hygiene.md).

## Scope

**In:** collapse the 35 duplicated `BASE_URL` declarations to one shared constant, point it at
`/api/v1`, verify the 401 interceptor still fires for every module, then remove `VERSION_NEUTRAL` so
the unversioned path stops being served.

**Out:** changing any response shape (there is none to change — same handlers). Versioning *policy*
beyond v1 — no `/v2` exists and none is proposed. The backend e2e suite's own use of the unversioned
path: update it in the same change, but it is not the point of the issue.

**Sequencing matters:** repoint admin and confirm it green **before** removing the alias. Removing
the alias first breaks every admin page and 90 backend specs at once.

## Acceptance criteria

- [ ] Exactly one `BASE_URL` definition exists in `apps/admin/src`, and it targets `/api/v1`
- [ ] The 401 refresh-and-retry interceptor demonstrably still fires for a request from a module that
      previously declared its own base URL (this is the failure mode that fails open — test it)
- [ ] The admin app is fully functional on `/api/v1` before the alias is removed
- [ ] `VERSION_NEUTRAL` is removed and `/api/health` (unversioned) 404s, while `/api/v1/health` serves
- [ ] `test/api-versioning.e2e-spec.ts` is updated to assert the *new* contract rather than the
      migration-window one
- [ ] `#169`'s AC at `:77` is ticked, with the "retired deliberately" branch recorded as the outcome

## Verification

```bash
cd apps/admin && npx vitest run && npx tsc --noEmit
cd apps/backend && node scripts/run-tests.mjs test/api-versioning.e2e-spec.ts test/global-guard-validation.e2e-spec.ts
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/health      # expect 404 after removal
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/v1/health   # expect 200
```
Then click through the admin app against a running backend — 35 modules moved; the type checker will
not catch a wrong runtime URL.

## Risk if deferred

Low operational risk today — both paths work. The real cost is that the migration window never
closes: the alias becomes load-bearing by habit, `#169` cannot close, and the "unobtainable later"
argument that justified versioning in the first place quietly stops applying. There is also a live
trap: anyone repointing *some* modules disables the 401 interceptor for them without any error.

## Size estimate

S-M. Mechanical, wide, and needs a click-through because the compiler cannot verify a URL string.
