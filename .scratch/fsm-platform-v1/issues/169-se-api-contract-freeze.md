# 169 — SE API contract freeze (error shapes, shared types, versioning, conventions)

Status: ready-for-agent
Type: AFK · Backend + `@fsm/shared` (2 HITL sub-decisions, flagged)

Filed 2026-07-28 (`docs/status/mobile-backend-freeze-plan-2026-07-28.md` §2 tier F1).
**This issue is the freeze itself** — the thing the whole programme buys. Everything here is
unfixable, or breaking, after a client ships to 1,000 handsets that cannot be recalled.

## Why this is not "nice to have"

The 07-28 plan ranked contract stability **N22 / low / unfiled**. That was wrong by its own logic:
it argued pagination and idempotency must land pre-client because they are cheap now and breaking
later, then failed to apply the identical argument to response shapes and error codes — which are
*more* exposed (no OTA, no version gate, no recall) and *cheaper* to protect. Promoted to
foundational.

## What to build

**1. Error-shape normalisation.** Today a client cannot write one `parseError()`:
- Controller errors are `{code}` with **no `statusCode`, no `message`**; guard/pipe/filter errors are
  `{message, statusCode}` with **no code** (`auth.guard.ts:45,51`, `role.guard.ts:32`).
- `ZONE_SCOPE_VIOLATION` arrives in `body.message` from the guard (`zone-scope.guard.ts:37`, a bare
  string throw) and in `body.code` from controllers (`se-planner.controller.ts:64`).
- `SE_NOT_FOUND` is **404** on `engineers.controller.ts:225` and **400** on `vouchers.controller.ts:96`.
- Install emits bare `NOT_FOUND`/`WRONG_STATE`/`FORBIDDEN`; recovery namespaces the identical
  conditions (`RECOVERY_*`). Three names exist for "the thing at `:id` isn't there".
- Install/recovery 409s carry `{code}` only — the client cannot tell *which* state blocked it —
  while troubleshoot's carries five fields.

Target: every error is `{code, message?, ...detail}` with `code` always present and always in the
same field, one status per code, and every 409 carrying the discriminating state (align the
`alreadyDone` discriminator with **#164**).

**2. `@fsm/shared` becomes the contract.** It is currently **76 lines** — `ROLES`, `SessionView`,
`LoginRequest`, `LoginResponse`, `SlaBucket`, `SLA_BANDS`. No domain types, and **none of the 54
error codes**, which exist only as inline string literals across 219 throw sites. Move the SE
response types and the full error-code union in, and import them at the throw sites, so a rename is
a compile error across the monorepo instead of a silent field incident.

**3. `/api/v1`.** Flat `setGlobalPrefix('api')` today (`app.config.ts:17`); no `enableVersioning`.
Adding `/v1` after v1 ships *is* the breaking change. Costs a string now.

**4. Serialization conventions**, documented and enforced:
- BigInt → decimal **string** everywhere. Fix `/org/geo/*`, which renders BigInt as JSON **number**
  (`geography.service.ts:39,51,54`) — lossy above 2^53 and contradicting every other route.
- No `String(null)` → the literal `"null"` (`intraday-insertion.service.ts:148-149`).
- One date format. `dateFrom`/`dateTo` are `"YYYY-MM-DD"` (`day-plan-query.service.ts:74-75`) while
  every other date is a full ISO instant; some are pre-stringified, some are raw `Date`.
- Add a `BigInt.prototype.toJSON` guard or a serializer — today one un-stringified BigInt anywhere
  is a `TypeError` in `res.json` ⇒ opaque 500.

**5. Naming.** One geo shape — today `location.lng` (soft-state), `seGps.lon` (troubleshoot),
`gpsLat`/`gpsLng` (VU): three spellings of one datum across three SE writes. Rename `deviceCount`,
which is literally `b.tickets.length` (`day-plan-query.service.ts:67`) while the Home screen renders
it as an inactive-*device* count. Name the derived list state explicitly (`workState`) rather than
overloading `status` — the UI's four filter chips map to none of the three server enums.

**6. Success-status consistency.** Install transitions return 200, soft-state transitions 201, for
the same class of operation. Pick a rule.

**7. Enum vocabularies** served by an endpoint or shared as types: root cause
(`troubleshoot.controller.ts:19-30`), **action taken (currently an unvalidated free string** while
the UI shows a fixed 10-option picker), voucher categories, VU reasons, decline reasons, leave types,
unable-to-collect reasons.

**8. Decide the eight by-omission routes.** `RoleGuard` returns `true` when `@Roles` is absent
(`role.guard.ts:25-27`), so `/api/me`, four notification routes, `/api/org/geo/*` and
`/api/zones/:zoneId` are SE-reachable. Two geo routes are unbounded; `/api/zones/:zoneId` is a stub
returning HTTP 200 `{"zoneId":null}` for garbage. Role-gate or remove — accidental surface must not
freeze. **(HITL sub-decision D-8.)**

## Acceptance criteria

- [ ] Every SE-facing error carries `code` in one field; one status per code; the sweep test pins the full vocabulary
- [ ] All 54 codes and every SE response type live in `@fsm/shared` and are imported at the throw/return sites
- [ ] Routes served under `/api/v1`; the un-versioned path either redirects or is retired deliberately
- [ ] Serialization conventions documented and enforced by a test (BigInt, dates, null)
- [ ] One geo request shape; `deviceCount` renamed; derived list state explicitly named
- [ ] Enum vocabularies obtainable by a client without hardcoding
- [ ] The eight by-omission routes are each deliberately gated, bounded, or removed
- [ ] A written contract document that #54 and the M-series pin against

## UI surfaces

n/a (admin call-site sweep where shared types land).

## Reference

n/a.

## Blocked by

- None. Land with **#174** (validation) and before **#161/#163/#165** freeze their payloads.

## Comments

### 2026-07-28 — vocabularies pinned by #172

Two naming decisions are now settled and belong in this issue's item 5/7 work:

- **`workState`** is the SE list's derived bucket — `'VISIT_NOW' | 'PLAN' | 'IN_WORK' | 'VERIFY'`
  (#172 decision 3). It is the image's row glyph and its filter chips, and it maps to none of the
  three existing server enums (`Ticket.status`, `SoftStateType`, `AssignmentState`) — which is
  exactly why it must be named explicitly rather than overloading `status`.
- **`actionTakenCategory` becomes a server enum** (#172 decision 8). It is currently an unvalidated
  free string (`troubleshoot.controller.ts:38`) while the UI renders a closed 10-option picker.
- **Verification `checks[]`** is a generic `{key, label, state}` array (#172 decision 4), deliberately
  *not* five fixed booleans, so the algorithm can change without a field break. Same principle this
  issue applies elsewhere: the contract exposes shapes, not internals.

### 2026-07-28 — error-code divergences found by the six-screen derivation

The issue files and the code disagree on four codes. **Freeze the code's codes**, then correct the
issue files — a client written from an issue file would branch on strings the server never emits.

| Issue claims | Server actually emits | Site |
|---|---|---|
| `INVALID_SERIAL` (recovery) | **`INVALID_DEVICE_SERIAL`** | `recovery.controller.ts:146` |
| — (unlisted) | **`CONDITION_NOTES_REQUIRED`** | `recovery.controller.ts:147` |
| `INVALID_REASON` (intraday decline) | **`INVALID_REASON_CODE`** | `intraday-insertion.controller.ts:85` |
| — (unlisted, #87) | **`INVALID_WINDOW_START`**, **`INVALID_WINDOW_END`**, **`AVAILABILITY_FORBIDDEN`** | `engineers.controller.ts:214,218,226` |

Note recovery *does* emit `INVALID_REASON` for its own unable-to-collect reason
(`recovery.controller.ts:74`) — so `INVALID_REASON` and `INVALID_REASON_CODE` are **two distinct
live codes** meaning nearly the same thing on different endpoints. Decide whether to unify them
(breaking, cheap now) or freeze both with a documented distinction.

Two more contract facts to pin while here:
- **`SERIAL_REQUIRED` maps only to a blank SIM serial** (`install-lifecycle.service.ts:127`); a blank
  GPS serial falls through to `INVALID_SERIAL` (`:128`). The field→code mapping is undocumented.
- **The 409 `TICKET_ALREADY_CLOSED` body's `status` field is the auto-recovery discriminator** —
  with `CLOSED_AUTO_RECOVERY` there is no winning SE (`troubleshoot-submission.service.ts:266-271`)
  and `winnerSeId` is null. It is already emitted (`troubleshoot.controller.ts:104`) but documented
  nowhere.

**Also:** workflow §26 (`workflow:1728-1754`) lists endpoint paths that do not exist —
`/api/insertions/{id}/accept`, `/api/tickets/{id}/install-fitted`, `/api/tickets/{id}/recovery-collected`,
`/api/me/day-plan`. The shipped routes are `/api/intraday-insertions/:id/accept`,
`/api/install/:id/fitted`, `/api/recovery/:id/collected`, `/api/schedules/me`. Freeze the code's
paths and correct the workflow doc.

### 2026-07-28 — Wave 0: item 3 (`/api/v1`) LANDED ✅ — non-breaking

`configureApp` now calls `enableVersioning({ type: VersioningType.URI, defaultVersion: ['1',
VERSION_NEUTRAL] })` (`app.config.ts`), which registers **every route at both `/api/v1/...` and
`/api/...`**.

Dual-serve rather than a hard switch because the blast radius of switching is total: **90 backend
e2e specs and every `apps/admin` API module** call the unversioned path. The neutral alias is the
migration window — **do not remove it until the admin client is repointed**, which is a deliberate
follow-up, not a tidy-up.

One regression surfaced and was fixed correctly rather than loosened: #99's route-guard sweep keys
its public allowlist on exact paths, so the three `@Public()` routes' `/v1` aliases read as
unguarded routes. The sweep now normalises the version segment out of the key
(`global-guard-validation.e2e-spec.ts`), keeping the allowlist **one conscious list** rather than one
per version — so adding `/v2` later still cannot slip a public alias past it.

New spec `test/api-versioning.e2e-spec.ts` (4 tests, red-first) pins both halves, including that
`/api/...` keeps working — that assertion is what will catch a future change that drops the neutral
alias and silently 404s the admin app.

Items 1, 2, 4–8 of this issue remain open.
