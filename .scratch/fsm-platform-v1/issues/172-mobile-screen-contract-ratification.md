# 172 — Mobile screen-contract ratification (image vs PRD conflicts)

Status: **DONE — fully ratified 2026-07-28.** All twelve items resolved and D-9 closed as
not-taken (see Resolutions). Nothing here is open.
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

- [x] Each of the 12 conflicts has a recorded decision and a pointer from the consuming issue — 4 operator decisions, 4 defaults, 2 withdrawn as non-conflicts, 2 spec holes recorded
- [x] The 22 reference paths resolve to real files — verified: all 10 mobile images resolve; the `.png.png` convention was corrected at its three sources (`CLAUDE.md`, `workflow.md`, `issue-tracker.md`)
- [x] #88 is out of `needs-info` with ACs derived from its image
- [x] A decision exists on mockups for the 6 imageless screens — **D-9 closed as NOT TAKEN**; data-needs specs written into the six issues instead

## UI surfaces

n/a (governance; it fixes what other issues' UI sections point at).

## Reference

- All 10 files in `docs/ui/mobile/`.

## Blocked by

- Operator decisions. **Blocks the field lists in #161, #163, #173.**

---

## Resolutions — 2026-07-28 (operator)

Status: **ratified.** Four decisions taken by the operator; eight defaults applied by the agent and
not vetoed (marked *default* — flag if wrong). All ten reference images were re-read directly
before these were put; two items originally filed as conflicts were **withdrawn** on that evidence.

### Withdrawn — not conflicts (PRD and image agree; only the code/schema is missing)

| Item | Why withdrawn | Owner |
|---|---|---|
| Technical Health / telemetry block | The PRD's Ticket Detail row says verbatim *"Technical Hints (derived) and raw telemetry fields always visible."* The image agrees. Pure gap. | **#84** |
| Transporter tap-to-call | PRD specifies it on both Ticket Detail and Vehicle Unavailability. Image agrees. Pure schema gap. | **#171** |

### Operator decisions

**1. Home — image wins, 7-day chart deferred.**
The image's Plant Workload grid *is* plant-wise batch assignments reorganised, and Next Visit is the
head of the ordered plan, so this was never "list vs no list". Three of the four new data asks fall
out of **per-ticket status**, which #161 already owes: the four KPI tiles (`STARTED/COMPLETED/
VERIFIED/FAILED`), the Next Visit counts (`4 inactive · 3 urgent · 2 in work`), and the Plant
Workload percentages/ratios. `Last sync` is `dataAsOf`, also already on #161.
**Net new cost: one endpoint** — a 7-day per-day assigned/completed series (`4/6, 5/8, 7/10, 6/7,
5/9, 8/11, 9/12` in the image), which nothing today can produce since `/schedules/me` serves only
the current live schedule. **Deferred to [#175](./175-se-work-history-series.md).** Plus a small
`employeeCode` column (`ID - ANV1012`), which exists on neither `User` nor `EngineerMaster`.
→ **#161**, **#55**, **#175**.

> **AMENDED 2026-08-03 — the `employeeCode` column is cancelled, not deferred.** Operator decision:
> the field is **dropped from the Home header entirely** (no column, no substitute identifier). This
> ratification's "small `employeeCode` column" line is therefore withdrawn — the header ships with
> name/role/zone and no `ID - …` line. Recorded here because this document is the frozen screen
> contract a client pins against; a mobile build reading only this file must not add the field.
> Rationale + the full SE-identifier inventory live on **#161**'s 2026-08-03 comment. AutoPlant was
> ruled out as a source from schema (no employee/HR entity exists in it), and no existing identifier
> is both human-readable and identity-shaped, so substitution was rejected rather than unavailable.
> Re-adding it later is purely additive (nullable column + one `/api/me` field) and breaks no shipped
> client — so this is a cancellation of scope, not a blocked dependency.

**2. Inventory — image wins, full surface.**
Overrides PRD Flow 12's explicit *"Read-only — restocking arranged through ZM or Warehouse."*
Rationale: an SE who can see they are down to 1 SIM card and cannot request one becomes a support
call. **#173 stands as filed** — SE-initiated component-request create, van-stock
`minQty`/`status`/`location`/`serialTracked`/`category`, zone-warehouse rows visible to the SE, and
the requests list (read side via #163). **`Use Part` stays deferred behind #101** — wiring a
consumption path arms the non-atomic van-stock decrement and the CONFLICT-path key-persistence
defects.
*Image detail worth keeping:* the three tiles are `13 AVAILABLE / 3 LOW STOCK / 2 HEALTHY` — 13 is
Σ`qty` and 3+2 is the row count split by status, so **one per-row status field unlocks all three
tiles**. → **#173**, **#60**, **#163**.

**3. Tickets list — image wins, merged list.**
Overrides PRD's *"secondary list… shown alongside Assigned Work"*. Coverage scoping is preserved
either way (the image is subtitled *"across all mapped plants"*), so the PRD's hard rule is intact;
only the visual separation goes. **Contract consequence: one endpoint, not two.**

```
GET /api/me/tickets
  -> { items: [{ ticketId, assigned: boolean,
                 workState: 'VISIT_NOW'|'PLAN'|'IN_WORK'|'VERIFY',
                 ...row fields }],
       cursor }
```

The day-plan/shared-pool split becomes an **implementation detail, not a contract boundary**. The
image's row avatar glyph (V/P/W/✓) is exactly `workState`, and the filter chips
`All / Visit Now / Plan / In Work / Verify` are that vocabulary. → **#161**, **#165**, **#56**,
and `workState` naming under **#169**.

**4. Verification — image wins on substance, exposed generically.**
The image shows five named checks plus a Device Guard card and four outcomes including
**`Escalated`**, which is in neither the PRD's three-badge list nor the code's `VerifyOutcome` enum
(it appears in the PRD only as a *ticket* badge, PRD:412). Five fixed booleans would freeze the
verification algorithm's internal steps into a client that cannot be recalled.

```
GET /api/tickets/:id/verification
  -> { outcome, phase, partialDeadline, startedAt, deviceId,
       checks: [{ key, label, state: 'PASS'|'FAIL'|'PENDING' }] }
```

Client renders whatever it is given; the algorithm stays free to change. `deviceId` is required for
the Device Guard card. **Open sub-question for the build:** decide whether `Escalated` becomes a
real verification outcome or is rendered from the ticket's `ESCALATED` state.
→ **#59**, **#161**, **#162** (the same route also needs scoping for *every* role).

### Defaults applied (not vetoed)

| # | Item | Resolution |
|---|---|---|
| 5 | Kit badge placement | **Image** — badge lives on Inventory, not Home (PRD Flow 12 said Home). Zero backend impact. → #55, #60 |
| 6 | Photo slots | **Image** — Troubleshoot has 4 named slots (`Before/After/Part/Plate`), Vouchers has 3 (`Receipt/Photo/Bill`). A flat `string[]` cannot express these, so **#81 must carry slot semantics**. → #81, #58, #61 |
| 7 | Troubleshoot notes fields | **Keep all three server-side.** Map `ISSUE REMARKS`→`rootCauseNotes`, `COMPLETION NOTE`→`actionTakenNotes`; leave `diagnosisNotes` unused by mobile. Nothing breaks, nothing is lost. → #58 |
| 8 | Issue-Found / Action-Taken pickers | **Make `actionTakenCategory` a server enum** — it is currently an unvalidated free string (`troubleshoot.controller.ts:38`) while the UI shows a closed 10-option picker. Serve both vocabularies. → #169 item 7, #174 |

### Spec holes found (not conflicts — the PRD is silent)

**Profile and Daily Status are absent from the PRD's SE screen inventory entirely.** The inventory
lists **17 screens**; neither appears — yet `Profile` is a primary bottom-nav tab in all ten images
and `daily-status.png` exists. Grep confirms zero PRD/workflow mentions of either as an SE screen.

- **Profile** renders **21 discrete data points**, including a 3-level reporting hierarchy with the
  ZM's name, phone and email, against a `GET /api/me` that returns four primitives. This is why
  #161's `/api/me` enrichment is larger than it first looked.
- **Daily Status** — **#88's `needs-info` is closed on image evidence**: four counters
  (assigned/completed/in-progress/pending), a completion %, and day rows in the Tickets row shape,
  plus a date chip implying **historical selection**, which `/schedules/me` cannot serve. Same
  history dependency as #175.

### Housekeeping — done

The `.png.png` double extension **did not exist**; all ten mobile images are plain `.png`. Corrected
in **16 issue files** + `DEV-GOVERNANCE-CHANGE-SET.md`, and at the three sources that stated the
convention as fact: `CLAUDE.md:64`, `docs/agents/workflow.md:81`, `docs/agents/issue-tracker.md:44`.
All ten referenced paths now resolve. `docs/archive/**` left untouched (write-once history).

### Still open

**D-9 — mockups for the six imageless screens** (Recovery Collection, Install Form, Intraday offer,
Leave Request, Availability, 409 Conflict). These were derived from prose only and are precisely
where a field gets discovered mid-build. Optional under the compatibility bar; required under the
strict bar.

### D-9 — CLOSED, NOT TAKEN (operator, 2026-07-28)

**Decision: no mockups will be commissioned for the six imageless screens.** Reasoning, recorded so
a future session does not reopen this: **UI is cheap to change and will be iterated during the
build; the visual design is not what forces a mid-build backend change — a missing field is.**
Commissioning six mockups to de-risk a class of risk that a data-needs spec addresses more directly
is the wrong trade.

**What was done instead:** a short **data-needs spec** for each of the six — fields displayed,
actions triggered, states handled — derived from PRD and workflow prose, with every field that does
not exist in the backend today flagged. Those specs live in the six issues themselves
(**#68** Recovery Collection · **#71** Install Form · **#77** Intraday offer · **#86** Leave Request
· **#87** Availability · **#63** 409 Conflict) and the consolidated missing-field list feeds the
freeze list.

**Do not reopen** on the grounds that these screens lack reference images. They lack images *by
decision*. If a genuinely new **data** need surfaces during the build, that is a normal additive
change under the compatibility bar (#170), not a reason to revisit D-9.
