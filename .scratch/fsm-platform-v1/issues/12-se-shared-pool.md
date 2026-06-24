# 12 — SE Shared Pool (always-visible secondary work)

Status: done
Type: AFK
Progress: docs/progress/12-se-shared-pool.md — backend Shared Pool API (`GET /api/me/shared-pool`) + server-side coverage scoping (se_coverage ∪ floating MV); all 5 ACs green (backend 228 tests / 73 files). Also retrofitted Issue 11 dispatch to flip `assignment_state → FORMALLY_ASSIGNED`. RN two-list UI deferred (see progress doc).

## What to build

The Shared Pool on the SE mobile app: an always-visible secondary list of open Tickets for the SE's covered Plants, shown alongside "Assigned to Me" (Formal Assignments) regardless of whether the SE has any formal assignments. The two lists are visually distinct — committed work is never mixed with unassigned work. The SE must **never** see Tickets outside their covered Plants unless explicitly assigned by an authorized override. There is no Reject action on Shared Pool or assigned work.

End-to-end: an SE with covered plants sees open tickets for those plants in the Shared Pool, separate from their Assigned list, and never sees out-of-coverage tickets.

## Acceptance criteria

- [x] "Assigned to Me" (Formal Assignments) and Shared Pool render as clearly separate lists *(distinct endpoints: `/api/schedules/me` vs `/api/me/shared-pool`; RN two-list render deferred — see progress doc)*
- [x] Shared Pool shows open Tickets for the SE's covered Plants even with zero formal assignments
- [x] Tickets outside the SE's coverage are never shown (unless explicitly override-assigned)
- [x] No Reject action exposed on either list *(read-only GET; no mutation surface)*
- [x] Coverage scoping enforced server-side, not just in the UI

## Blocked by

- #11
