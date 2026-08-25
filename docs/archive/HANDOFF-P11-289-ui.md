> **ARCHIVED 2026-08-25 — consumed.** #289's UI half was built in the session that followed this
> handoff; the ruling it carried is now recorded in the issue, `INDEX.md`, `SYSTEM-STATE` §3h and
> `docs/progress/289-override-impact-preview.md`. Nothing here is current.

# HANDOFF — #289's UI half, 2026-08-25 (third session)

Stopped at a safe point. **Everything implemented is committed.** #289's **backend is done and
green**; its **UI half is not started**, and this file exists to carry the one operator ruling that
would otherwise be lost with the conversation.

## Where P11 stands

| Issue | State |
|---|---|
| #282 decision + recovered design | **DONE** — `8b342e3` |
| #283 provenance seams | **DONE** — `ea8f5cd` |
| #284 read layer | **DONE** — §A/§B `ea8f5cd`, §C/§D `f9a06d9` |
| #285 cockpit | **DONE** — `ea8f5cd`; Replay made real by `f9a06d9` |
| #286 crashed-zone re-dispatch | **DONE** — `56ac41e` |
| #287 MV freshness | **DONE** (backend + panel) — panel still uncommitted, see the older handoff's trap 3 |
| #288 escalate-only mid-day unavailability | **NOT STARTED** — policy ruled (#282 R4), ACs written |
| #289 override impact preview | **BACKEND DONE** — see below. **UI half open.** |
| #290 `/assign` visual grammar | **DONE** — `0061ce1` |

## #289 — exactly what is done and what is left

**Done and committed** (backend, 8 service specs + 3 HTTP specs, all green):

- `src/scheduling/override-projection.service.ts` — `projectOverride(batchId, cmd, scope, now)`,
  returning both lanes' `committed → after / capacity`, the run's rank context for the target, the
  stop-order effect, and the two conflict sets. **No `create`, no `update`, no `$transaction`, no
  `$executeRaw` in the file** — the property is asserted by counting rows across every table a real
  move touches, before and after.
- `POST /api/batches/:id/override/preview` — same body, same role gate and same 404 as the confirm it
  precedes. A one-lane action (REMOVE / DEFER / REORDER) is **400 `NOT_PROJECTABLE`**, not an empty
  impact.
- Wired in `scheduling.module.ts` (provider + export).

**Open — the UI half (AC5).**

### The ruling that must not be lost

**AC5 says "the cockpit renders the preview". The operator ruled otherwise, on 2026-08-25, when it
was put to them explicitly:** the impact panel goes on **Schedule Detail** (`/schedules/:engineerId`),
between picking a target SE and Confirm, in the three existing move panels — Swap SE, Reassign,
Split. It does **not** go in the cockpit.

The reason is that the cockpit has no override controls at all; it links out to Schedule Detail, which
is where an operator actually chooses an override today. Building move controls into `/dispatch/today`
would duplicate a surface that already exists, which #282 R5 forbids. The operator was shown that
option and did not take it.

So: **AC5 is satisfied by Schedule Detail, and the issue text's "cockpit" is superseded by that
ruling.** Do not "fix" this by moving the panel into the cockpit.

### What to build

In `apps/admin/src/pages/schedules/ScheduleDetailPage.tsx`, in each of the three move panels
(`open === 'swap'`, `open === 'split'`, and the per-ticket Reassign at ~line 415):

1. A client call — `apiOverridePreview(batchId, cmd)` in `apps/admin/src/api/schedules.ts`, beside
   `apiOverrideBatch`, hitting `POST /batches/:id/override/preview`.
2. A shared `OverrideImpactPanel` component rendering, per the approved design's step 3:
   - **Capacity impact**, both engineers, `7/8 → 6/8` and `5/6 → 6/6`. Over capacity is **amber**
     (#290's grammar — never crimson) and is **stated, never a barrier**: Confirm stays enabled.
   - **System view** — "Sneha ranked #2 for this ticket in the 05:00 run", from `impact.rank`.
     `rank: null` is **unknown, never "unranked"** — say nothing rather than invent a position.
   - **Route** — "Appended as stop 3 on Sneha's chain — her route is not reordered", from
     `impact.route`. `joinsExistingStop` means she already stops there.
   - **Conflicts** — `impact.conflicts.deferred` (and `onSite`, which reads empty until Issue 15).
3. Fetch on target-SE change, not on panel open: the impact is a function of the target.
4. **The existing `OverrideConflictError` 409 path is unchanged** (AC4) — a lost race still
   re-presents as the clean conflict dialog, never an error page. Do not route the preview through it.

### Design reference (read before writing)

`docs/ui/desktop/approved-designs/todays-dispatch-crew-deck.html`, lines ~520-560 — the step-3 panel,
its exact labels and its four rows. The panel is drawn in the cockpit *in the design*; the operator's
2026-08-25 ruling relocates it, and nothing else about it changes.

## Trap that is still live

The older handoff (`HANDOFF-P11-crew-deck.md`) trap 3 still applies: **~30 files of prior-session work
are uncommitted in the tree** (charts, reports, settings, #287's ConfigInEffect panel, #270's admin
half). `HEAD` does not reflect the working tree. Note that `apps/admin/src/api/dispatch-runs.ts` was
committed with `f9a06d9` and no longer carries #270/#287's type-only additions as uncommitted work.

## Test cadence that works here

One test process at a time (the suite shares one Postgres, `fileParallelism: false`). Batched
`npx vitest run @files` rather than `npm test`. A batch reporting `N-1 passed (N)` with
`Worker exited unexpectedly` is **#184** — re-run the missing file alone before believing it; it
happened three times across this session's runs and every one passed in isolation.
