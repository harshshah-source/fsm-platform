# Handoff — FSM mobile AFK backlog (session ending 2026-08-04)

> ⚠️ **ARCHIVED / CONSUMED 2026-08-09.** Every issue this handoff hands off is closed — #68, #71,
> #77, #85, #86, #87 all landed 2026-08-04/05, and its open question (surface RECOVERY via the merged
> `/me/tickets` list rather than a new day-plan path) was answered by building it that way. Current
> state is in [`INDEX.md`](../../.scratch/fsm-platform-v1/INDEX.md)'s session log and each issue file;
> two environment notes below (`docs/progress/184-*.md`, which does not exist, and the uncommitted
> test-infra) are live findings owned by [#190](../../.scratch/fsm-platform-v1/issues/190-184-deliverables-uncommitted.md).

## Standing directive (still in force)

This session operates under an AFK mandate: work mobile issues from **#54 onward**, continuously,
slice by slice. Standing constraints, unchanged for the next session:

- **TDD discipline** (red → green) per `CLAUDE.md`'s `/tdd` skill for every slice.
- **Commit and push between slices** — never leave more than one slice of work uncommitted. Fetch
  before every push (concurrent sessions are a real, observed risk on this repo/branch — see below).
- Stage explicit file paths only, **never** `git add -A`/`.`. **Never** commit `pnpm-lock.yaml` or
  `pnpm-workspace.yaml` (entangled with issue #190's deliberately-uncommitted patch state — see
  `C:\Users\User\.claude-company2\projects\C--fsm-platform-backup\memory\project_190_lockfile_entanglement.md`).
- Non-retrofittables (X-Device-Id, X-App-Version, slot-bearing photo shapes) must be right first
  time — no OTA for the pilot (#170).
- Photo handling follows D-12: multipart to `POST /api/media/upload` (built this session, #81),
  opaque `photoRef`, #172 Decision 6 named slots.
- `employeeCode` is **cancelled**, not deferred — never render an ID under an engineer's name.
- Every new scoped route needs a "correct role, wrong SE" test.
- Don't block on full-suite green — run tests scoped to touched files (see "known flakiness" below
  for why a full/standalone run can mislead you).
- **Business-rule / UI-location derivation risk**: when an issue's AC assumes a screen shape or data
  field that doesn't actually exist in the ratified contract, **stop and ask** via `AskUserQuestion`
  with a recommended default — do not silently guess. This happened twice this session (#55's KPI
  tiles, #66's "plant group" UI) and both times the user's answer unblocked immediate progress.

## What shipped this session

All on branch `feat/autoplant-integration`, pushed through commit `ca8bebb`. Full narrative detail,
decisions, and "not built" notes for each are in `.scratch/fsm-platform-v1/INDEX.md`'s session-log
table (search for `2026-08-04`) and each issue's own file under `.scratch/fsm-platform-v1/issues/`.
Do not re-read those files preemptively — this list is just the index:

| Issue | What | Key commit(s) |
|---|---|---|
| #59 | Mobile Verification screen (checks list, Device Guard) | `acabda1`, `8dd56a4` |
| #81 | Media Upload API (backend) — unblocked photo ACs on #58/#61/#71 | `bf72b0c` |
| #61 | Vouchers tab (capture form + My Vouchers list) | `a6fcd48` |
| #63 | Full-screen Business 409 conflict result (`ConflictScreen`) | `7b26532` |
| #64 | Vehicle Unavailability filing + transporter tap-to-call | `545e28d` |
| #171 | Transporter contact data (Shape A) — prerequisite for #64 | `545e28d` (same commit) |
| #66 | Same-day plan update cues (Newly Added / Removed badges) | `f8fc979` |

Each issue's `.md` file has its Status line and Acceptance Criteria checkboxes updated to match
reality. `INDEX.md`'s session-log table has one row per issue closed.

**Deliberately not built** (each documented in its own issue file, not re-litigated here):
offline drafting (#61, blocked on #17), Shadow-Use end-to-end demonstration (#63, blocked on #101 —
`TroubleshootSubmitRequest` still has no `consumedComponents` field), the #171 OH/CSM admin
maintenance surface for `transporters.contact_phone` (a separate, larger admin-app feature), and the
readiness-hint AC on #64 (explicitly deferred to #65 by the issue itself).

## Repo state right now

- Branch `feat/autoplant-integration`, HEAD = `ca8bebb`, exactly in sync with `origin` (no unpushed
  or unpulled commits) as of this handoff.
- `git status` shows uncommitted changes to `apps/backend/scripts/run-tests.mjs`,
  `apps/backend/vitest.config.ts`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, plus untracked
  `apps/backend/test/crash-diagnostics.ts`, `audit/verify-run1.txt`, `patches/` — **none of these are
  mine**; they were present at the start of this session (likely another concurrent Claude Code
  session's in-progress work per the observed pattern below). Leave them alone; don't stage or
  discard them without investigating first.
- **Concurrent sessions confirmed active on this same repo/branch/working-dir during this session** —
  admin/dashboard files and new issue files repeatedly appeared in `git status` mid-turn that I never
  touched (e.g. commits `77dc6b9`, `dc1cc0d` on the `#193` zone drill-down / SLA ramp work landed by
  someone else during this session). **Always run `git status --short` immediately before staging**,
  and stage only the exact file paths your own slice touched — see
  `C:\Users\User\.claude-company2\projects\C--fsm-platform-backup\memory\project_concurrent_sessions.md`.

## Next issue: #68 — SE mobile Recovery screens

`.scratch/fsm-platform-v1/issues/68-mobile-recovery-se-screens.md`. Status `ready-for-agent`, but its
own 2026-07-28 comment flags three things to verify **before** writing code (this is exactly the
"verify contract against source" step that caught real staleness in #57/#59/#63 earlier this
session):

1. **"RECOVERY appears in the Day Plan as a first-class work type"** — flagged as *not satisfiable*
   at comment time: `/api/schedules/me` only reads TROUBLESHOOT day-plan batches; RECOVERY dispatch
   (`POST /api/recovery/:id/schedule`) sets `assignedSeId` directly with no batch row. The comment
   calls this a **design decision, not a field gap**. Working theory going in (not yet confirmed):
   sidestep the literal "Day Plan" framing — an assigned RECOVERY ticket should already surface via
   `GET /api/me/tickets` (#56, the merged list `TicketsScreen` already renders) since that read
   already covers all `workType`s per its own doc comment. If so, build the Recovery card into
   `TicketDetailScreen` reached via the Tickets tab, without needing a change to `/schedules/me`. If
   the merged list does *not* actually surface RECOVERY tickets when only `assignedSeId` is set (no
   batch row), that's the real premise blocker — stop and ask, per the standing directive above,
   rather than inventing a new day-plan path.
2. **Expected device serial readability** — comment says no SE-facing `GET /api/recovery/:id`
   existed at comment time, so the SE would type a serial blind against an exact-match check
   (`recovery.service.ts:124`, `deviceSerial === String(ticket.deviceId)`). **Likely stale**: check
   whether `MeTicketDetailView.deviceId` (from `me-ticket-detail.service.ts`, built well before this
   session and confirmed working throughout — e.g. #63/#64 both read from it) already gives the SE
   the expected serial to display in the Collection Form. If it does, this gap is already closed and
   the comment is outdated — verify against current source, don't trust the 07-28 date.
3. **Error codes** — the issue's own AC text pins `INVALID_SERIAL`, but grep
   `recovery.controller.ts` for the actual codes: comment says the real ones are
   `INVALID_DEVICE_SERIAL` and (missing from the issue's own list) `CONDITION_NOTES_REQUIRED`. Use
   whatever `recovery.controller.ts` actually emits today, not the issue's stale text.

The user was mid-conversation confirming whether to proceed on the "sidestep #1 via the merged list"
theory, or stop and confirm the Day Plan question first, when this handoff was requested — **that
question is still open, pick it back up with the user before building.**

After #68, the remaining `ready-for-agent` mobile issues in ascending order are: #71 (Install SE
screens — also unblocked by #81's Media Upload API now), #77 (Intraday accept/decline), #85
(Notifications), #86 (Leave request), #87 (Availability/soft-unavailable), #89 (Push notifications).
#88 (Profile/Daily Status) is `needs-info`, not `ready-for-agent` — don't start it without checking
what info is missing first.

## Known environment gotchas (already solved once each this session — don't rediscover)

- **`pnpm add`/`npx expo install` fails with `EUNSUPPORTEDPROTOCOL`** when expo's installer shells
  out to `npm install` in this pnpm workspace (`workspace:*` protocol unsupported by npm). Fix:
  `npx expo install <pkg>` still correctly writes the SDK-compatible version range into
  `package.json` even though the trailing `npm install` step fails — then run
  `pnpm install --filter <app>` yourself to actually install it. See
  `feedback_expo_dependency_versions.md` in memory for the general "always resolve the SDK-correct
  version" rule this compounds with.
- **`apps/backend/test/voucher-controller.e2e-spec.ts` is flaky when run standalone** — it implicitly
  depends on some other e2e spec file (that runs earlier in the same `vitest run` invocation) having
  already created an `EngineerMaster` row for `se.north@fsm.test`; it never creates one itself.
  Confirmed pre-existing (not caused by anything built this session) by checking `git log` on the
  vouchers backend files. Running it alongside `media-controller.e2e-spec.ts` (which does upsert that
  row) makes it pass. Not fixed — out of scope for whatever you're doing unless the user asks.
- **Windows vitest worker crashes** (`Worker exited unexpectedly`) are a known, documented,
  unrelated-to-your-code flake — see `docs/progress/184-vitest-worker-exited-unexpectedly.md` and
  `apps/backend/scripts/run-tests.mjs`'s own doc comment. Re-run before assuming a regression.
- **Nest's `FileInterceptor`** converts a multer file-size-limit breach into its own 413
  `PayloadTooLargeException` *before* any exception filter sees a raw `MulterError` — if you add
  another multipart upload route, you'll need the same locally-scoped filter pattern as
  `apps/backend/src/media/multer-error.filter.ts` to get a clean 400, not a global-filter change.
- Always run `pnpm build` in `packages/shared` after editing `packages/shared/src/index.ts`, before
  the backend or mobile typecheck will see the new types.

## Suggested skills for the next session

- **`tdd`** — the established red-green loop for every slice; every issue this session followed it
  and it should continue exactly as-is (seams = the API client function + the screen component;
  confirm seams before writing tests, same as this session did implicitly by mirroring existing
  test-file patterns).
- **`git-guardrails-claude-code`** — given the confirmed concurrent-session activity on this exact
  branch, lean on this before any push/commit, especially broad-looking `git status` output.
- **`code-review`** (or `review`) — worth invoking once a few more issues land, to get a second pass
  over the accumulated diff before it grows much larger; this session self-reviewed inline but never
  ran a dedicated review pass.
- **`diagnosing-bugs`** — if the voucher-controller flakiness or vitest worker crashes above ever
  need to be root-caused instead of routed around, this is the right skill to reach for.
