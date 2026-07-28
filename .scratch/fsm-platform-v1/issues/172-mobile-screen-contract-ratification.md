# 172 — Mobile screen-contract ratification (image vs PRD conflicts)

Status: ready-for-human
Type: HITL · Docs / governance

Filed 2026-07-28 (`docs/status/mobile-backend-freeze-plan-2026-07-28.md` §1.3, F4.1, D-5).
Gates the field lists in **#161**, **#163**, **#173** — build those against a contested spec and the
endpoints get built to the wrong shape.

## The problem

A field-level derivation of all 10 mobile reference images against the PRD and workflow found
**12 disagreements**. Under the CLAUDE.md parity gate the images are authority, but several change
*what an endpoint must return*, so they must be settled before the contract freezes.

The material ones:

1. **Home screen content.** PRD §479 / §503 Flow 1 describe an ordered day-plan **ticket list**;
   `home-dashboard.png` shows **no list at all** — 4 KPI tiles (`STARTED`/`COMPLETED`/`VERIFIED`/
   `FAILED`), a Next-Visit card, a **7-day completed/assigned bar chart**, and a Plant Workload grid,
   with the list behind an `Open Ticket Pool` button. Issue #55 follows the PRD. **This is the
   expensive one** — the KPI tiles and the chart need per-ticket status and a historical day-series,
   neither of which any SE endpoint can produce.
2. **Inventory scope.** PRD §617 Flow 12 scopes it to read-only van stock; `inventory.png` shows a
   **Zone Warehouse** row, per-row **`Request`** buttons, `Scan Serial`, `Use Part`, and an active
   component-requests list. Issue #60 follows the PRD. Drives **#173**.
3. **Verification checks.** PRD §531 / CONTEXT §9 describe **three** phases; `verification.png` lists
   **five** named checks plus a `Device Guard` card; the code has a single aggregate `phase`
   (`verification-query.service.ts:100-108`). Three-way disagreement.
4. **Tickets list grouping.** PRD §497 wants Shared Pool visually separate from Assigned; the image
   groups by **urgency** (`Visit Now` / `Other Tickets`) with a Plant-wise/Priority toggle and no
   Assigned/Pool distinction.
5. **Ticket numbers.** Every image renders `TCK-#####`; PRD §541/§564 writes `Ticket #XXXXX`; the
   schema has only a UUID (`schema.prisma:2027`). See D-4 / **#161**.
6. **Kit badge placement** — PRD §619 and #55 put it on Home; Home's image has no kit badge, the
   Inventory image has the kit data.
7. **Photo slots** — PRD §513.4 says unstructured "photo refs"; the image shows 4 fixed labelled
   slots (`Before/After/Part/Plate`). Vouchers: PRD §597.3 says "at least 1 photo", image shows 3
   labelled document types. Drives **#81**.
8. **Troubleshoot notes fields** — PRD lists three text fields, the image shows two
   (`ISSUE REMARKS`, `COMPLETION NOTE`); which maps to `diagnosisNotes` is unstated.
9. **Issue-Found / Action-Taken pickers** — the image shows fixed 10+10 tiles; `actionTakenCategory`
   is an **unvalidated free string** server-side (`troubleshoot.controller.ts:38`). Neither doc
   enumerates the labels.
10. **Profile scope** — PRD §479 says "profile details, app settings"; the image shows a 3-level
    reporting hierarchy including the **ZM's phone and email**.
11. **Daily Status** — issue **#88 is `needs-info`** on the grounds that its metric set is unknown.
    `daily-status.png` specifies it precisely: 4 counters + completion % + day rows in the
    Tickets-list row shape, with **historical date selection** (which `/schedules/me` cannot do).
    **Closeable on evidence — do not escalate.**
12. **Dead reference paths** — all 22 mobile issues cite `docs/ui/mobile/<name>.png.png`; the files
    on disk are single-extension `.png`. Every `## Reference` line is a dead path.

## What to do

- Resolve 1–10 case by case (image wins by default under the parity gate; say so explicitly where it
  does not, and record why).
- Fix the 22 `.png.png` reference paths.
- Close #88's `needs-info` against the image and rewrite its ACs.
- Record each resolution where the consuming issue will see it (#55, #56, #57, #59, #60, #61, #88).
- Six screens have **no reference image** (Recovery, Install, Intraday offer, Leave, Availability,
  409). Decide whether to commission mockups — these are precisely where a field gets discovered
  mid-build (D-9).

## Acceptance criteria

- [ ] Each of the 12 conflicts has a recorded decision and a pointer from the consuming issue
- [ ] The 22 reference paths resolve to real files
- [ ] #88 is out of `needs-info` with ACs derived from its image
- [ ] A decision exists on mockups for the 6 imageless screens

## UI surfaces

n/a (governance; it fixes what other issues' UI sections point at).

## Reference

- All 10 files in `docs/ui/mobile/`.

## Blocked by

- Operator decisions. **Blocks the field lists in #161, #163, #173.**
