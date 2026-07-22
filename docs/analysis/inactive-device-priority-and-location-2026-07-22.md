# Inactive Devices — Business Priority + Last Known Location

**Date:** 2026-07-22 · **Branch:** `feat/autoplant-integration` · **Type:** READ-ONLY feasibility analysis.
No code changed, no issue filed, no design beyond a shape sketch.
AutoPlant reads were indexed `device_id` lookups with `LIMIT ≤ 90` plus `information_schema` metadata.
Probe scripts deleted.

Builds on `docs/analysis/inactive-devices-by-business-priority-2026-07-22.md` (business-criticality
half, verified earlier today). That work is cited, not re-derived.

---

## Conclusion (plain language)

**YES to both halves — and the location half is even cheaper than the trip half, because FSM is
already ingesting the coordinates and nobody noticed.**

`AutoPlantSourceReader` has always selected `latitude, longitude` and written them to
`raw_device_snapshots.lat/lon` (`mapping.ts:143-144`). I checked all 2,771 currently-inactive
devices: **2,769 of them (99.93%) have last-ping coordinates already stored in FSM**, and for
**2,769 of 2,769 the last stored snapshot's timestamp exactly equals `device_states.latest_gps_datetime`**.
The last known location is already sitting in our own database. What is *not* in FSM is the
human-readable address string and the vehicle's trip state — those need a sync change.

**One premise in the brief is wrong, and the correction matters.** The brief assumed AutoPlant's
lat/lng "updates independently", so a read-through view would drift. It does not. I measured FSM's
last-ping position against AutoPlant's live position for 30 inactive devices: **29 of 30 were
identical to the metre (0 m drift)**. The single exception moved 3,066 m — and when I checked, that
device's AutoPlant GPS timestamp was ~26 hours *newer* than FSM's, i.e. **the truck started reporting
again**. AutoPlant's lat/lng moves only when the GPS ping moves. For a genuinely silent device it is
frozen, exactly as we would want.

**Snapshotting is still the right design — but for two better reasons than the one given.**

1. **Recovery, not drift.** 2 of my 30 sampled devices resumed pinging within a day. The moment a
   device recovers, AutoPlant's location becomes *live*, and a read-through view would silently
   replace "where we lost it" with "where it is right now" — precisely when an SE is en route.
2. **Retention will delete the history.** `raw_device_snapshots` currently holds coordinates back to
   2023 *only because retention has never run*: `PARTITION_MAINTENANCE_ENABLED="false"`, so the
   3-day create-ahead runway lapsed and **591,033 rows are piled into
   `raw_device_snapshots_default`** — the newest daily partition is `y2026m07d10` while today is
   07-22. This is the exact failure the activation checklist warns about. Fix that (it must be
   flipped together with the ingestion scheduler) and `telemetry_retention_days = 7` starts dropping
   daily partitions — taking the last known location of every device inactive more than a week with
   it. HIGH-priority devices in my sample averaged **~182 days** inactive. **The feature's location
   data would evaporate the day we fix an unrelated ops bug.**

So: promote the location onto the per-device hot row, and write it **on every new ping** rather than
on an inactivity-transition hook. Write-on-ping produces "location as of the last ping" — which *is*
"location when it went silent" — with no transition detection, no missed-edge cases, and correct
behaviour on recovery.

**Recommendation:** extend `device_states` (not a side table), add the address + trip-state fields to
the existing master/telemetry read, one dedicated ZM-scoped page, and also surface last known
location on the existing Device Detail page. Do not wire either signal into recommender scoring yet
— though location is a shorter path than business priority, because the `distance` scoring component
already exists and is inert for want of coordinates (§4.4).

---

## 1. AutoPlant data — verified

### 1.1 The columns

`ap_widgets.tb_vehiclemaster` (`information_schema.COLUMNS`, live):

| Column | Type | What it is |
|---|---|---|
| `latitude` | `double` | Current position, updated per ping |
| `longitude` | `double` | Current position, updated per ping |
| `current_location` | `longtext` | Reverse-geocoded address string with a distance offset |
| `vehicle_location_status` | `varchar(20)` | Vehicle/trip state — observed values `SCHEDULED`, `ATPLANT`, `TOWARDSDESTINATION`, `EMPTY` |
| `latest_gps_datetime` | `datetime` | Last ping (IST wall-clock; FSM normalises +330) |
| `TRIP_CREATION_DATETIME` | `timestamp` | Already-UTC; FSM normalises at offset 0 |

`tb_vehiclemaster` is a latest-state table — one row per vehicle, `vehicle_no` PK. All of the above
are last-value columns; there is no history here. (Trip history exists separately in
`ap_widgets.tb_tripmaster` — noted in the earlier analysis, still out of scope.)

### 1.2 Are lat/lng current-location, or something else? — current-location, tied to the ping

The decisive test. For 30 inactive devices I compared FSM's **last-ping** coordinates
(`raw_device_snapshots`, ordered by `gps_datetime DESC`) against AutoPlant's **live** coordinates:

| Result | Devices |
|---|---|
| Drift = **0 m** (identical to the metre) | **29 / 30** |
| Drift > 0 | 1 (3,066 m) |

The one exception, `0351608087348897`, is not drift. Its AutoPlant `latest_gps_datetime` is
**~26 hours newer** than FSM's — the device resumed reporting and FSM has not ingested it yet. A
second spot-check found the same shape on `0359688090029645` (~29 h newer, 85 m moved).

> **Methodology trap, again.** Comparing raw `CAST(latest_gps_datetime AS CHAR)` against FSM makes
> four of six devices look "AP NEWER" by exactly +5:30. That is not lag — `latest_gps_datetime` is a
> MySQL `DATETIME` stored in IST, and FSM correctly subtracts `AUTOPLANT_UTC_OFFSET_MIN = 330`
> (`mapping.ts:15,136`). Only a delta that is *not* +5:30 is a real new ping. Two of the six were.
> (This is the same family of trap documented in the earlier analysis — pin your sessions.)

**Conclusion: `latitude`/`longitude` move only when `latest_gps_datetime` moves.** For a silent
device the position is frozen at the last ping. The brief's "field updates independently" concern is
not supported by the data.

### 1.3 `trip_creation_datetime` semantics

Verified earlier today (same-day analysis, §1.3): dispatcher-maintained last-value column; FSM's
cached copy matched production **to the second** on 4/4 devices when both sessions were pinned to UTC.

This sample adds a supporting observation: **all 10 HIGH-bucket devices carried
`vehicle_location_status = 'SCHEDULED'`**, while MEDIUM/LOW devices were `TOWARDSDESTINATION`,
`EMPTY`, or `ATPLANT`. That is consistent with the earlier finding that the stamp behaves more like
*"when this vehicle's active-trip record was last written"* than *"when a trip was created"* — it
appears to move when the vehicle enters the SCHEDULED state. It also means
`vehicle_location_status` may be a **cleaner, more directly interpretable business-activity signal
than the timestamp**, and it is free to collect alongside it.

### 1.4 Address-string quality

Real samples (truncated):

- `394.01m from State Bank of India Rampur Baghelan SATNA MADHYA PRADESH`
- `28.13m from Reliance Petrol Pump Khordha Khordha KHORDHA ODISHA INDIA`
- `2.77kms from Primary School Biraha Pragdatta Hanumana REWA MADHYA PRADESH`
- `1.79kms from Vishal Niwas Haveli Loni Kalbhor PUNE MAHARASHTRA INDIA`

Landmark, offset distance, district, state, country, PIN. Genuinely useful for an SE. **Caveat: the
offset ranges from 28 m to 2.77 km** in a 30-row sample — where the nearest indexed landmark is
distant, the string is weak navigation help. Treat it as human-readable context; **lat/lng is the
precise value** and should drive any map link.

---

## 2. The 30-device sample

Population filter as specified: `is_inactive = true`, `is_departed = false`, plant not deactivated.
Sampled 10 per trip-staleness bucket (deterministic, ordered by `device_id`) so all three buckets are
represented — the natural distribution is in the earlier analysis (HIGH 111 / MEDIUM 984 / LOW 1,287
/ NO_TRIP_DATA 347 across 2,729 devices).

| Bucket | n | Address resolved | Inactive hours (avg) | SLA band | SE assigned |
|---|---|---|---|---|---|
| HIGH (trip ≤ 24 h) | 10 | 10/10 | **4,355 h ≈ 182 days** | 9× LONG_PENDING, 1× SEVERE | 10/10 |
| MEDIUM (1–7 d) | 10 | 10/10 | 306 h ≈ 13 days | 7× CRITICAL, 2× SEVERE, 1× LONG_PENDING | 6/10 |
| LOW (> 7 d) | 10 | 10/10 | 851 h ≈ 35 days | mixed, 6× LONG_PENDING | 5/10 |

**30 of 30 devices resolved in AutoPlant by `device_id`, and 30 of 30 returned a usable address.**

### Patterns worth surfacing

**a. The HIGH bucket is old, assigned, and ranked last.** Every HIGH device in the sample had been
dark for months (445 h to 11,947 h) and 9 of 10 sat in `LONG_PENDING` — the band the canonical sort
ranks *lowest*. This reproduces the headline of the earlier analysis (84 of 111 HIGH devices are
LONG_PENDING) on an independent sample. The customer is actively scheduling trips on trucks we
effectively gave up on.

**b. Geographic clustering — three co-located pairs in thirty rows.** Two Shree Balaji devices at
`18.4895,74.0047` and `18.4897,74.0032` (both "Vishal Niwas Haveli Loni Kalbhor, PUNE"); two Vedanta
devices at `28.5010,77.0063` and `28.5015,77.0068` ("Sector 110 Gurgaon"); two Prism devices at
`25.1571,80.4750` and `25.1575,80.4748` ("Naraini Gudha Kalan, BANDA"). **One SE visit could clear
two tickets.** Today's Plant Cluster Multiplier clusters by `plant_id`; these are metres apart in the
field. Coordinates would let clustering reflect physical reality rather than plant membership.

**c. MEDIUM skews CRITICAL, HIGH skews LONG_PENDING.** In this sample the MEDIUM bucket is where the
recently-broken-and-actively-used devices sit (7 of 10 CRITICAL, avg 13 days dark). That is the
population the current engine already prioritises correctly. The value the business-priority signal
adds is concentrated in HIGH — the long-dark trucks the customer never stopped using.

**d. Devices do come back.** 2 of 30 had resumed pinging by the time I queried. Any location display
must be explicit that it is *last known*, with its timestamp, not *current*.

---

## 3. Data model — snapshot at the moment of inactivity

### 3.1 Recommendation: extend `device_states`, and write on ping

**Extend `device_states`** rather than add a side table:

- It is already the per-device hot derived row, one row per device, no lifecycle of its own — the
  exact grain this data has. A side table would be a 1:1 join for no benefit.
- **Precedent exists in the same table:** `trip_creation_datetime` was added there on 2026-07-17 for
  exactly this reason (live per-device state, not master data, not a per-ping observation).
- It already denormalises `vehicle_id`, `plant_id`, `company_id`, `transporter_id`, `sla_bucket`,
  `inactivity_hours`, `is_departed` — the whole view can be served from this one row plus name joins.

Proposed columns (shape only, not a design):

```
device_states
  + last_known_lat            double precision   null
  + last_known_lng            double precision   null
  + last_known_address        text               null   -- AutoPlant current_location
  + last_known_location_at    timestamptz        null   -- the ping this position came from
  + vehicle_location_status   text               null   -- SCHEDULED / ATPLANT / TOWARDSDESTINATION / EMPTY
```

Storage is trivial: ~22k rows × ~150 bytes of address ≈ 3 MB.

### 3.2 Write-on-ping, not write-on-inactivity-transition

The brief asks to snapshot at the moment FSM detects the inactive transition. I recommend a simpler
rule that yields the identical value: **update the location columns whenever `latest_gps_datetime`
advances** — i.e. on a genuine new ping — and never otherwise.

Why this is better:

- **It is the same value.** "Location when it went silent" *is* "location at the last ping". A
  device that stops pinging simply stops updating these columns; the value freezes by construction.
- **No transition to detect.** An inactivity-transition hook has to fire exactly once, in the right
  order relative to the recompute, and cope with flapping devices and threshold changes. Write-on-ping
  has none of those edge cases.
- **Recovery is handled correctly and automatically.** When a device resumes, the location resumes
  updating — which is what an operator wants, and what the 2-of-30 recovered devices in my sample
  need.
- **It matches the existing mechanism.** `latest_gps_datetime` and `trip_creation_datetime` are
  already maintained this way in one set-based `unnest` upsert
  (`snapshot-ingestion.service.ts:114-123`), which is called for **every chunk row** regardless of
  whether the `raw_device_snapshots` insert was skipped by `ON CONFLICT DO NOTHING` (`:77`).

One difference from the existing pattern to note: `trip_creation_datetime` uses
`GREATEST(existing, EXCLUDED)`, which is monotonic forward-only. Coordinates must **not** use
GREATEST — they need last-observed-value, guarded by the ping timestamp advancing.

### 3.3 Business priority — refresh cadence

The brief proposes refreshing `trip_creation_datetime` each **master sync** (daily). It is already
refreshed on the **30-minute telemetry tick**, which is strictly better and costs nothing — the
column rides the existing scan (`autoplant-source-reader.ts:33-38`). This was measured and settled in
the earlier analysis: 18.4% of the DEPLOYED fleet changes it per day, so a daily mirror would be
stale for ~2,600 vehicles at a time. **No change needed; do not move it to master sync.**

`business_priority` itself should be **derived at read time** from `trip_creation_datetime`, not
stored. It is a pure function of one timestamp and two thresholds; storing it would need a
recompute every time a threshold changed and would go stale between ticks.

### 3.4 What still needs a sync change

| Field | In FSM today? | Needs |
|---|---|---|
| `last_known_lat` / `lng` | **Yes** — `raw_device_snapshots.lat/lon`, already ingested (`mapping.ts:143-144`) | Promotion to `device_states`. No reader change. |
| `last_known_address` | **No** — `current_location` is not read by any FSM code | Add to the reader `SELECT` |
| `vehicle_location_status` | **No** | Add to the reader `SELECT` |
| `trip_creation_datetime` | **Yes**, on the correct cadence | Nothing |

Adding two columns to the reader's `SELECT` rides the same paged queries — **zero additional
AutoPlant queries**, the same pattern as the 2026-07-17 device-identity enrichment.

---

## 4. Feature shape

### 4.1 View columns

All available from `device_states` + name joins + one LATERAL to `tickets`, after §3.4 lands:

`device_id` · `zone` · `company` · `plant` · `inactive_since` (= `latest_gps_datetime`) ·
`inactive_hours` · **`last_known_address`** · **`last_known_lat/lng`** ·
**`last_known_location_at`** · `trip_creation_datetime` · `days_since_trip_scheduled` ·
`business_priority` (derived) · `open_ticket` · `assigned_se` · `days_since_ticket_created`
· *(suggested addition)* `vehicle_location_status`.

`last_known_location_at` is not optional decoration — without it the UI cannot honestly label the
position as "last known", and 2 of 30 sampled devices had already moved on.

### 4.2 Surface — dedicated page, ZM-scoped

Recommend a **dedicated page** (OH/CSM all zones, ZM clamped to own zone), as in the earlier
analysis: the ranking *is* the product, the audience is daily triage rather than investigation, and
it reuses `DataTable` plus the existing ZM zone-clamp pattern. The location column strengthens the
case — a worklist with "where to go" is a dispatch tool; the same data as a filter on an
investigation page is not.

### 4.3 Also put last known location on Device Detail — yes

Recommend it. Device Detail already surfaces AutoPlant enrichment (device type, IMSI, trip creation)
from the 2026-07-17 work, so this is an additive block in an established place, needs no new endpoint
once the columns exist, and answers the first question an SE or ZM asks when opening a dark device.
Display the address, the coordinates, and `last_known_location_at`, labelled "last known" — never
"current".

### 4.4 Default sort

```
business_priority DESC (HIGH → MEDIUM → LOW → NO_TRIP_DATA)
  → assigned_se IS NULL DESC     (unresourced first)
    → inactive_hours DESC        (longest pain first)
      → device_id ASC            (deterministic, matches ADR-0017 convention)
```

Unassigned above longest-inactive: within HIGH, an already-assigned device is handled; the ZM's
question is "what still needs resourcing?". Keep `NO_TRIP_DATA` visible at the bottom rather than
hidden — 347 devices averaging 421 days inactive is its own finding.

### 4.5 Bonus — recommender seams

**Business priority → scoring: LATER.** Unchanged from the earlier analysis. The evidence is strong
(business criticality is orthogonal to the SLA bucket the engine sorts by), but three gates are
unmet: the `TRIP_CREATION_DATETIME` semantics are unconfirmed; **#124** means a new weight would not
appear in `dispatch_runs.config_snapshot` and could not be retrofitted; and scoring weights are
global OH-owned config under the `f0f3dcb` governance decision. Ship the view, see whether ZMs' manual
picks correlate, then earn the weight.

**Location → distance scoring: LATER, but a shorter path than the above.** Worth flagging clearly:
the `distance` scoring component **already exists** — it is a configured weight in
`priority_rule_config` (`v1`, weight 0.1, confirmed in run 4's config snapshot) and is wired into
`scoring.ts`, but sits inert because the input is deferred-null. There is an explicit marker at
`recommender.service.ts:371` ("when distance scoring lands (`weights.distance > 0 &&
distanceFromPrevStopKm !== null`)"). Device coordinates supply **half** the missing input. The other
half — the SE's or previous stop's position — does not exist yet, so this cannot be switched on by
this feature alone. But it converts "build a new scoring dimension" into "supply an input to a
dimension that is already built and already weighted", which is a materially cheaper future step.

**Clustering — the observation worth carrying forward.** Three co-located device pairs in a 30-row
sample (§2b) suggests real-world clustering that `plant_id` does not capture. `orderPlantStops`
(`batch-assignment.service.ts:236-238`) is explicitly documented as the seam where PostGIS
route-distance would replace insertion order. Coordinates on `device_states` are the prerequisite for
ever doing that. **Never** is the wrong answer for location; *not yet* is right.

---

## 5. Feasibility verdict

### Business criticality — **YES** (unchanged)

Data already in FSM, refreshed on the correct cadence, verified to the second against production,
87% coverage on the inactive population, zero additional AutoPlant queries. Verdict and evidence in
the earlier analysis.

### Last known location — **YES for coordinates, PARTIAL for the address string**

**Coordinates: YES, and stronger than expected.** Already ingested; 2,769 of 2,771 inactive devices
have last-ping coordinates in FSM today; the stored ping timestamp matches
`device_states.latest_gps_datetime` for 2,769 of 2,769. AutoPlant's position is frozen for silent
devices (29/30 identical to the metre), so the values are trustworthy. Needs promotion to
`device_states`, no reader change.

**Address string + trip state: PARTIAL only in that they need a (trivial) sync change** — two
columns added to a `SELECT` that already runs, riding the same paged queries at zero query cost.
30/30 sampled devices returned a usable address. Once added, this becomes a plain YES.

### Blockers and concerns

| Concern | Status |
|---|---|
| **Join key reliability** | **Not a blocker.** 30/30 sampled `device_id`s resolved in AutoPlant. `device_id` is the reader's keyset key, "verified effectively unique on production" (`autoplant-source-reader.ts:28-30`). |
| **Prod query budget** | **Not a blocker.** Two extra columns on an existing `SELECT`; zero extra queries. *Caution for anyone re-running this analysis:* an unbounded `GROUP BY` on `tb_vehiclemaster` times out — I tripped this and abandoned it. Use indexed `device_id` lookups only. |
| **Retention / partitioning** | **The real threat, and it is live.** 591,033 rows are in `raw_device_snapshots_default`; the newest daily partition is `y2026m07d10` (today: 07-22) because `PARTITION_MAINTENANCE_ENABLED="false"`. Location history survives only by accident. Enabling partition maintenance correctly — mandated as a paired switch with the ingestion scheduler — starts dropping daily partitions at `telemetry_retention_days = 7`. **This is the argument for promoting location to `device_states` rather than querying the journal.** |
| **Data quality — address** | **Real, manageable.** Landmark offsets range 28 m to 2.77 km. Show the address as context and the coordinates as truth; link to a map from lat/lng, not from the string. |
| **Data quality — dispatcher entry** | **Real.** 13% of inactive devices have no trip stamp; `NO_TRIP_DATA` must be a first-class bucket, not a silent exclusion. |
| **Semantic uncertainty** | **Real, unchanged.** `TRIP_CREATION_DATETIME` reads more like "active-trip record last written" than "trip created"; the all-HIGH-are-SCHEDULED pattern (§1.3) reinforces this. Affects the label and possibly the threshold, not the ranking. `vehicle_location_status` semantics are entirely unverified — sampled, not documented. |
| **Schema size** | **Not a blocker.** ~3 MB across 22k rows. |
| **Sync cadence mismatch** | **Real, and it is an ops issue.** Designed cadence is 30 minutes; `INGESTION_SCHEDULER_ENABLED="false"`, so refresh currently depends on someone running the pipeline by hand. |
| **Stale-location display risk** | **Real, mitigated by design.** 2 of 30 devices had resumed pinging. The UI must show `last_known_location_at` and label the position "last known". |

### Sequencing if built

1. **Confirm semantics** (HITL, external): `TRIP_CREATION_DATETIME` creation-vs-last-write, and what
   `vehicle_location_status` values mean. Everything else proceeds in parallel.
2. **Sync change** — add `current_location` and `vehicle_location_status` to the reader `SELECT`
   (`autoplant-source-reader.ts` `SELECT_COLS`) and map them (`mapping.ts`). Same shape as the
   2026-07-17 enrichment; no extra queries.
3. **Schema** — 5 additive nullable columns on `device_states` (§3.1). One migration, offline-safe.
4. **Ingest write** — extend the existing set-based upsert (`snapshot-ingestion.service.ts:114-123`)
   to write the location columns **only when the ping timestamp advances**; explicitly *not*
   `GREATEST` for coordinates.
5. **Backfill (optional)** — last-ping lat/lon for existing inactive devices can be recovered from
   `raw_device_snapshots` today, while the DEFAULT partition still holds the history. **This window
   closes when partition maintenance is fixed.** The address string cannot be backfilled; it will
   populate forward from the first run after step 2.
6. **Endpoint** — one zone-clamped read returning the §4.1 shape with the §4.4 sort applied
   server-side.
7. **UI** — dedicated page; plus the Device Detail block (§4.3).
8. **Later, gated:** business priority into scoring (after #124); location into `distance` scoring
   (after an SE-position source exists).

### HITL decisions needed

- Confirm `TRIP_CREATION_DATETIME` semantics with AutoPlant's owners.
- Confirm `vehicle_location_status` value meanings — and whether it should be a first-class column
  in the view or a supporting signal.
- Bucket thresholds: keep 24 h / 7 d, or tune given that 86% of stamps fall in the current month?
- Whether to run the optional lat/lon backfill **before** partition maintenance is enabled (the
  window is open now and closes then).
- Dedicated page vs tab on the existing device surface (§4.2 recommends page).
- Whether `NO_TRIP_DATA` (347 devices, avg 421 days inactive) belongs in this view or is a separate
  data-quality / departure follow-up.
- Whether to turn on the ingestion scheduler, given this view's freshness depends on it — and note
  it is paired with partition maintenance, which is what threatens the location history.

---

*Read-only. No code changed, no issue filed. AutoPlant reads were indexed `device_id` lookups with
`LIMIT ≤ 90` plus `information_schema` metadata; FSM reads were `SELECT`-only. All probe scripts
deleted.*
