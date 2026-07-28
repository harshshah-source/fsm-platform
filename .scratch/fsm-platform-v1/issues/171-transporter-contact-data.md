# 171 — Transporter contact data (schema + ingestion source)

Status: ready-for-human
Type: HITL · Backend · Schema

Filed 2026-07-28 (`docs/status/mobile-backend-freeze-plan-2026-07-28.md` §1.1, F2.5).
**The most expensive thing in the mobile programme to discover late**, and it was found once —
by the field-level screen derivation, in a single pass.

## The problem

Three SE mobile screens require **tap-to-call / WhatsApp the transporter**:
the Tickets list (`Call` and `WhatsApp` buttons per row, `docs/ui/mobile/tickets-priority-view.png`),
Ticket Detail, and the Vehicle Unavailability flow — PRD §484, §513.1, §549.1 all specify
"Transporter name + contact number (tap to call)".

**There is no phone column.** `transporters` carries exactly
`transporterId, sourceTransporterId, name, companyId, status, createdAt, updatedAt`
(`prisma/schema.prisma:1742-1754`). No phone, no WhatsApp, no contact person, no email.

This is not a payload gap — it is a **migration plus a data-sourcing decision**, which is why it
cannot be treated as an additive change late in the build.

## Decisions required (operator)

1. **Is transporter contact data in the AutoPlant master?** If `mst_transporter` (or equivalent)
   carries a phone, this is an ingestion mapping. If not, it is FSM-owned data requiring an admin
   entry surface and an ownership policy. **Nobody has asked this question yet** — it needs your
   knowledge of the source schema.
2. **If FSM-owned:** who maintains it, and what does the SE see when it is absent? (The UI has no
   empty state for a missing number.)
3. **Is one number enough**, or does the design need a contact person + role + separate WhatsApp
   number? The images show one `Call` and one `WhatsApp` button.

## What to build (once decided)

- Migration adding contact fields to `transporters` (+ an FSM-owned side table if the master is
  authoritative and must not be written to — the `plant_deactivations` anti-drift pattern from #119
  is the precedent).
- Ingestion mapping if sourced, or an admin maintenance surface if FSM-owned.
- Expose on the SE ticket read (**#161**) and shared pool (**#165**) payloads.
- An explicit "no contact on file" state in the contract, so the client renders something honest.

## Acceptance criteria

- [ ] Transporter contact is available on every SE surface the PRD requires it (3 screens)
- [ ] The source of truth is decided and documented; if ingested, it survives a master-sync run
- [ ] Absent contact data is representable in the contract and rendered honestly
- [ ] If FSM-owned, an admin surface exists to maintain it

## UI surfaces

- **Admin:** transporter contact maintenance (only if FSM-owned — else n/a).
- **Mobile:** consumed by #56/#57/#64; those issues own the buttons.

## Reference

- `docs/ui/mobile/tickets-priority-view.png` (Call / WhatsApp buttons), `ticket-detail-ready.png`.

## Blocked by

- Operator decisions above (D-3).

## Comments

### 2026-07-28 — D-3 resolved: FSM-owned. Recommendation on the write path.

**Not in AutoPlant — confirmed by the operator, and corroborated in code:** the master read selects
exactly `transporter_id, company_id, transporter_name, status`
(`ingestion/autoplant/autoplant-master-source.ts:203`). No contact column is pulled, and the FSM
`Transporter` model carries none (`schema.prisma:1742-1754`). So this is FSM-owned data.

#### The spec already answers more of this than the issue assumed

**1. The column is specified — it was simply never built.** The workflow data dictionary lists
`transporters` as `transporter_id`, `name`, `plant_id`, **`contact_phone`**, with
**Owner: "Operations Head / integration"**, Consumers: "SE mobile (Ticket detail), dashboards"
(`workflow:1639`). That is an explicit ownership assignment: **admin-maintained, not SE-maintained.**

**2. There is a second, separate field the spec requires and we have also not built.**
`vehicle_unavailability_reports` is specified to carry **`transporter_name`** and
**`transporter_contact`** (`workflow:283`, `workflow:1650`) — i.e. the name and number the SE
*actually used*, recorded per report. PRD:552 and workflow:552 say "transporter name/number **used**".
Today the VU report carries only `transporterContacted: boolean`
(`vehicle-unavailability.controller.ts:38`, `vehicle-unavailability.service.ts:77`).

So the spec's model is **two-tier**, and it dissolves the admins-vs-SEs framing:

| Tier | Field | Owner | Purpose |
|---|---|---|---|
| Master | `transporters.contact_phone` | OH / integration (`workflow:1639`) | The number **shown** to the SE on Ticket Detail and the VU form |
| Per-report | `vehicle_unavailability_reports.transporter_contact` + `transporter_name` | The SE, on an existing write | What the SE **actually used** — field evidence, and the correction signal for the master |

#### Do SEs realistically have the number?

**No — the spec assumes it is shown to them.** Every citation is one-directional: *"the SE contacts
the Transporter (name + number **shown on the Ticket**)"* (`workflow:282`); *"Ticket Detail shows the
Transporter name and contact number; SE taps to call"* (`PRD:551`); *"The SE **calls** the Transporter
to arrange vehicle access — not the Customer"* (`workflow:154`); *"The SE contacts the Transporter to
get access to the vehicle for repair"* (`workflow:146`). The SE is the consumer of this datum, not
its source. In the field they would get an unknown number from the ZM, the plant gate, or the driver
— which is exactly the case the per-report capture covers.

#### Recommendation

**Admin-owned master; no new SE write path to `transporters`.** Instead, implement the two VU-report
fields the spec already requires. Rationale:

- It matches the spec's stated ownership (`workflow:1639`) without inventing authority.
- It still gets the field-sourcing benefit: SEs are the only people who dial these numbers, so they
  find stale ones first — and `transporter_contact` on the report captures that, feeding admin
  reconciliation.
- **It costs nothing extra on the freeze list.** Those two fields are additive to
  `POST /api/vehicle-unavailability`, an endpoint already on the freeze list (#164 gives it an
  idempotency key, #174 gives it a DTO). No new endpoint, no new authz surface, no new error codes.

**What an SE *write* path to the master would add to the freeze list, if you chose it anyway:**
a new endpoint (`PATCH /api/transporters/:id/contact`) → a DTO and validation (#174), an idempotency
key and retry semantics (#164), row-level authz scoping — an SE may only touch transporters for
plants in their coverage (#162), new error codes in the shared vocabulary (#169), and an entry in the
contract inventory. That is roughly five items across four freeze-list issues, to buy something the
per-report capture already gets. **Not worth it.**

#### Bootstrapping — the real risk, and it is not a schema problem

The master column will be **empty on day one** for every transporter, and an empty tap-to-call button
on three screens is worse than no button. Decide the seeding path: ZM-assisted entry during rollout,
or accept an empty master and let the VU capture accumulate real numbers first. Either way the
**"no contact on file" state must be explicit in the contract** (already an AC here) so the client
renders something honest rather than a dead button.

#### Revised acceptance criteria

- [ ] `transporters.contact_phone` exists (FSM-owned, `workflow:1639`), maintained by an OH/CSM admin surface
- [ ] Exposed on the SE ticket read (#161) and the merged list row (#165) — the join already exists (`ticket-query.service.ts:140` selects `tr.name AS "transporterName"`), so this is a one-column extension
- [ ] `vehicle_unavailability_reports` gains `transporter_name` + `transporter_contact` per `workflow:1650`, captured on the existing SE write
- [ ] "No contact on file" is representable in the contract and rendered honestly by the client
- [ ] A seeding decision is recorded (ZM-assisted entry vs accumulate-from-reports)
- [ ] **No new SE write endpoint against `transporters`** — deliberately out of scope; see reasoning above

**One discrepancy to resolve while adding the column:** the data dictionary describes `transporters`
as keyed on **`plant_id`** (`workflow:1639`), but the built model carries **`companyId`** and no
plant reference (`schema.prisma:1745-1749`). Vehicles link to transporters
(`Transporter.vehicles`), and the ticket join reaches the name via the vehicle
(`ticket-query.service.ts:140`), so the code's shape works — but whoever adds `contact_phone` should
decide deliberately whether the spec's plant-scoping was intended (a transporter operating at
several plants may have different contacts per site) or whether `company_id` supersedes it. If
per-plant contacts are real, the column belongs on a join table, not on `transporters`.

### 2026-07-28 — D-3b SETTLED: admin-owned master, no SE write path

**Operator decision, recorded so it does not reopen.** The master `transporters.contact_phone` is
**FSM-owned and admin-maintained** per the ownership the spec already assigns — *"Owner: Operations
Head / integration"* (`workflow:1639`). **No SE write path against `transporters` will be built.**

Instead the SE contributes through the per-report capture the spec already requires:
`vehicle_unavailability_reports` gains **`transporter_name`** and **`transporter_contact`**
(`workflow:283`, `workflow:1650`; PRD:552 — "transporter name/number **used**"). That is additive to
`POST /api/vehicle-unavailability`, an endpoint already on the freeze list, so it costs nothing
extra there.

**Why not an SE write path** (the argument, so it is not re-litigated): every spec citation is
one-directional — the SE is *shown* the number and calls it (`workflow:146`, `:154`, `:282`;
`PRD:551`). The SE is the consumer of this datum, not its source. A general SE write to the master
would add a new endpoint, a DTO (#174), an idempotency key (#164), coverage-scoped authz (#162), new
error codes (#169) and a contract-inventory entry — roughly five items across four freeze-list
issues — to buy a correction signal the per-report capture already provides.

---

### Cardinality: is the contact per-transporter or per-plant?

Measured on the dev DB 2026-07-28 (read-only aggregates; probes deleted):

| Measure | Value |
|---|---|
| Transporter rows total | **7,784** |
| …with at least one vehicle (operationally real) | **1,236** |
| …reachable from an **OPEN ticket** (the launch-critical set) | **840**, across 152 plants |
| Serving **more than one plant** | **286** (23%) — **280** once blank/placeholder names are excluded |
| Max plants for one transporter | **26** |
| Mean plants per transporter | **1.36** |
| Spanning more than one **company** | **0** |

**What the structure says.** AutoPlant has **no per-plant transporter concept at all**:
`mst_transporter` is read as `transporter_id, company_id, transporter_name, status`
(`autoplant-master-source.ts:203`), and `transporter_id` hangs off **`mst_vehicle`**
(`:257`). A transporter reaches a plant only transitively, through its vehicles. Combined with
**multi-company = 0**, the source system treats a transporter as one entity per company — which is
exactly what the built model encodes (`Transporter.companyId`, `schema.prisma:1745`).

**So the data dictionary's `plant_id` (`workflow:1639`) is a documentation error, not a requirement.**
Company-scoping is correct and should not change.

**But the per-plant *contact* question is separate, and the data cannot settle it.** For 77% of
operational transporters the question is moot — they serve one plant. For the **280** that serve 2–26
plants it is real, and unanswerable from a table that currently holds no contact data at all:
whether `SHRI NIWAS ROADLINES` (7 plants) has one dispatch desk or a coordinator per site is a
business fact, not a schema fact. [INFERRED] most operators of this size run a single dispatch
number, with site coordinators appearing only at the top of the range.

#### Two migration shapes

**Shape A — one column on `transporters`** (`contact_phone`, optionally `contact_name`).
Cost: one additive column, an admin list surface, and a one-column extension to the join that
already exists (`ticket-query.service.ts:140` already selects `tr.name`). Data entry: **840 rows**
for launch. Covers 77% exactly and, on the inference above, most of the remaining 23%.

**Shape B — join table `transporter_plant_contacts (transporter_id, plant_id, contact_phone)`.**
Cost: a new table, a two-dimensional admin grid, resolution logic, and materially more data
entry — for the 280 multi-plant transporters this is potentially thousands of rows, on top of a
master that is empty to begin with.

#### Recommendation: Shape A, with the contract shaped so Shape B is a later no-op

**A → B is free; B → A is a data migration.** Provided the API returns a **single resolved**
`transporterContact` — computed server-side as `per-plant override ?? master` — the client never
learns which tier answered. A per-plant override table can then be added **mid-build without
touching the frozen contract**, which is precisely what the compatibility bar (#170) exists to buy.
Going the other way means collapsing rows and deciding which one wins.

**Therefore:** build Shape A now; **never expose the master/override distinction in the response**.
One field, resolved server-side. Revisit only if field evidence from `transporter_contact` on the VU
reports shows the same transporter being called on different numbers at different plants — which is
itself a reason the per-report capture is worth having.

---

### Population — an explicit launch item, not an assumption

The master is **empty on day one** and a dead tap-to-call button on three screens is worse than no
button. Sizing and ownership, to be tracked rather than assumed:

- **Scope: 840 transporters**, not 7,784 — the open-ticket-reachable set across 152 plants. That is
  the minimum viable entry job and it is an order of magnitude smaller than the table.
- **Blocker inside that scope: 109 of the 1,236 operational transporters have unusable names** —
  4 blank and 105 literal `"NA"`/placeholder. Those cannot be identified well enough to *find* a
  number, let alone record one. They need source-data remediation or manual identification first,
  and they should be counted as their own sub-task rather than discovered during entry.
- **Who:** ownership sits with **OH/CSM** per `workflow:1639`, but ZMs are the ones who actually know
  their zone's transporters. Suggested split — OH owns the admin surface and the data standard;
  **ZMs do zone-scoped entry** for their own plants.
- **By when:** this does **not** block mobile *development* — the contract can freeze with the column
  empty, and the "no contact on file" state is already an AC here. It blocks the **field pilot**,
  because that is when an SE first taps the button. Target completion before pilot, and treat
  coverage (% of the 840 populated) as a pilot-readiness metric.
- **Ongoing:** `transporter_contact` on the VU reports accumulates real, field-verified numbers and
  is the reconciliation input for keeping the master honest.
