# Zone-Application Verification — 2026-07-14

Independent verification of the claim landed by commit `2e81319` ("47 derived zones are live in
FSM, durable against the AutoPlant sync cycle, and used end-to-end"). The claim was treated as
untrusted and re-tested from scratch. Read-only session except the sanctioned TEST-2 writes
(one fresh `sync-masters`, one `reapply`) and this document. No code changes; no new overrides;
scheduler flags untouched.

Method notes: ZM-view tests authenticate as the **real mock ZM users** (their DB user ids) via
dev-secret-minted HS256 tokens, because the in-memory auth store (#91) cannot log in DB users —
the requests still pass through the real `AuthGuard`/`RoleGuard`/zone-scoping. One test-harness
transcription bug (46-entry expected-zone map) produced an initial false FAIL on TEST 1; the
harness was corrected — the application itself was never wrong. All evidence below is from the
corrected run.

## Results

| Test | Verdict | Evidence |
|---|---|---|
| 1 — State check (DB truth) | **PASS** | All **47/47** plants' `zone_id` resolves to the expected zone (East 21 · South 13 · West 9 · North 4, per the East A/B→East, West A/B→West collapse). All **47/47** `plant_zone_overrides` rows exist with reasons intact (sub-zone + source tag + `audit unzoned-plants-2026-07-07.md` reference). Zero mismatches. |
| 2 — Fresh durability | **PASS** | Fresh master sync **run 34** (SUCCESS, 751 plants updated — mirrored columns only): 47/47 zones unchanged. Then `reapply`: `{plantsConsidered: 751, updated: 0, unchanged: 751}` — 47/47 still correct. Durability holds on a fresh cycle, not just same-session. |
| 3 — Device chain trace (5 devices) | **PASS** | Five devices from RCP-9211, SATNA LINE 2, Kadappa, SCL_Ranavav, KHORDA each traced end-to-end: AutoPlant `tb_vehiclemaster` maps device→the expected plant_id; AutoPlant `mst_plant.zone_name` is blank/NA (SATNA: the literal string `'null'`) — confirming the zone could only have come from the override; FSM `devices→vehicles→plants.zone_id` = expected zone; the zone's ZM fetches the device detail with HTTP 200. Example: device `860103061553179` @ RCP-9211 → East, East-ZM sees it. |
| 4 — Negative controls | **PASS** | (a) KESORAM 3127, DGFC_Test 3923, ESL 3672 all still UNZONED — no zone bleed. (b) All 6 SHUTDOWN STAR CEMENT plants (3040/3530/3078/3529/3619/3187) still UNZONED as decided. (c) DB plants-per-zone (East 43 · North 45 · South 64 · West 400 · UNZONED 200) == SYSTEM-STATE §6.1 exactly; OH `zone-overview` device counts (East 7,015 · North 3,716 · South 3,117 · West 1,653 · UNZONED 4,605) match DB within the +2/+3 drift of the fresh TEST-2 sync inserts. |
| 5 — Dispatch respects zones | **PASS** | Random sample of 10 dispatched tickets: 8 same-zone; 2 cross-zone (SATNA L2 East→UNZONED-homed SE, RCP-9211 East→same SE). Full population check: of **all 567** tickets dispatched 2026-07-13, **50 are cross-zone and every one belongs to the single documented cross-coverage SE** (the 07-10 UNZONED SE whose covered plants moved to East/North). Cross-zone assignments outside that known exception: **0**. |
| 6 — ZM views (human-facing) | **PASS** | East ZM device list total: **7,015 exactly**; first-page rows all East; filter-options exposes only `East`; tickets API returns East tickets (HTTP 200). West ZM: filter-options only `West`; searching `RCP-9211` returns **5 rows for the East ZM, 0 rows for the West ZM** — no leakage either direction. |

## Findings (ranked)

1. **No findings against the claim.** Every hop matched expectation; no silent cross-zone
   dispatch; no zone bleed into negative controls; overrides and reasons fully intact after a
   fresh sync + reapply cycle.
2. *Observation (not a defect):* the 50 legitimate cross-zone dispatches all flow through the one
   SE whose 2026-07-10 coverage rows outlived their plants' zone moves. If Ops wants zero
   cross-zone, re-home that SE (or its coverage) — tracked implicitly under the #119/#120 cleanup
   space.
3. *Observation:* SATNA's `mst_plant.zone_name` in AutoPlant is the literal string `'null'` —
   further confirmation the source column is unusable for these plants (matches the
   2026-07-13 enrichment evidence).

## Verdict

**The derived zones are fully live and durable in FSM.** They exist in the DB with intact,
attributed override rows; they survive a fresh AutoPlant master-sync and a reapply run hours
after application; devices at the 47 plants resolve to the right zone at every hop from the
AutoPlant source row to the ZM-facing APIs; dispatch honors them with zero undocumented
cross-zone assignments; and the ZM dashboards scope correctly in both directions.
