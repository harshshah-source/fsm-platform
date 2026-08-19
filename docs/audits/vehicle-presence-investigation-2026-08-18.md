# Is the Vehicle at the Plant?

**Production forensic investigation — AutoPlant MySQL × FSM Postgres**

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Source** | 10.0.0.25 · MySQL 8.0.43 · `bi_enroute_readonly` |
| **Mode** | Read-only · no INSERT/UPDATE/DELETE/ALTER/CREATE/DROP issued |
| **Branch** | `feat/autoplant-integration` |
| **Scope** | Investigation only — no application code modified |

The FSM ticket engine sends a Service Engineer to a plant on the strength of one fact: the tracker
stopped reporting. It never asks whether the truck is still there. Measured against live production
data, four times out of five it isn't.

---

## Contents

- [Executive summary](#executive-summary)
- [Current FSM ticket creation](#current-fsm-ticket-creation)
- [Current SE assignment](#current-se-assignment)
- [Current planner behaviour](#current-planner-behaviour)
- [AutoPlant vehicle / device model](#autoplant-vehicle--device-model)
- [AutoPlant location model](#autoplant-location-model)
- [AutoPlant trip model](#autoplant-trip-model)
- [Vehicle presence detection](#vehicle-presence-detection)
- [Relevant tables](#relevant-tables)
- [Actual production evidence](#actual-production-evidence)
- [The critical gap](#the-critical-gap)
- [Data lineage](#data-lineage)
- [Recommended architecture](#recommended-architecture)
- [Recommended ticket rule](#recommended-ticket-rule)
- [Recommended assignment rule](#recommended-assignment-rule)
- [Edge cases](#edge-cases)
- [Confidence matrix](#confidence-matrix)
- [Final recommendation](#final-recommendation)
- [Limits of this study](#limits-of-this-study)

---

## Executive summary

### Can we currently know whether an inactive vehicle is physically at its plant?

> ## PARTIALLY

AutoPlant holds enough to answer the question **well for roughly two-thirds of the fleet and not at
all for the rest**. The signals exist, they are live, and several of them survive the tracker being
dead — which is the hard part. What is missing is not data but two joins: FSM never reads the
location columns it already receives, and no plant in the system has coordinates.

Critically, the answer is **not** "just use GPS". A vehicle is inactive precisely because its GPS
stopped, so its last fix is stale by definition. The signals that actually carry the day are the ones
AutoPlant derives from orders and geofence dwell, which keep updating after the tracker dies.

| Measure | Value |
|---|---|
| Genuinely inactive devices within 2 km of the plant we would dispatch to | **20.1%** |
| More than 50 km away | **53.2%** |
| On an active AutoPlant trip right now | **61%** |
| FSM plants with coordinates populated | **0 / 933** |
| Open tickets at a plant whose coordinates are recoverable | **81.4%** |

### Three findings drive everything below

1. **The FSM engine has no concept of vehicle location whatsoever.** Not a weak one — none. Ticket
   creation reads six predicates, none spatial. The one hard filter that could have stopped a
   dispatch, `VEHICLE_ON_TRIP`, is hardcoded to `'UNKNOWN'` at `recommender.service.ts:283` and has
   never fired in production.

2. **The plant master has no coordinates and never did.** `ap_masters.mst_plant` has 54 columns, all
   postal address text. FSM mirrors it into a PostGIS `geometry` column that is NULL for all 933
   rows. Any geofence rule is unbuildable until this is solved — and it *is* solvable, from a table
   nobody has looked at.

3. **AutoPlant's trip lifecycle is driven by orders, not by GPS — so it outlives the tracker.**
   615 devices that have been GPS-silent for an average of 115 days had a trip created an average of
   23 days ago, with real gate-in and gate-out timestamps. That is a presence signal that works on
   exactly the devices we care about, and it is the single most valuable thing this investigation
   found.

---

## Current FSM ticket creation

`TicketCreationService.createForInactiveEligible()` runs one query over `device_states` and opens a
Failure Cycle plus a ticket for every row that matches. The entire eligibility test is six
predicates:

```text
# apps/backend/src/ticketing/ticket-creation.service.ts — the complete gate

inactivityHours      >= se_assignment_threshold_hours   // live value: 48
eligibleForUptime    == true                            // mode: all-deployed
hasOpenFailureCycle  == false
device.departures    none active                        // left the FLEET, not the plant
plantId              not null, not deactivated
companyId            not null
```

No predicate references position, distance, trip, dwell, or presence. There is no column on
`device_states` that could support one — the model carries `latestGpsDatetime` and
`tripCreationDatetime`, but no latitude or longitude.

Note the live configuration: `se_assignment_threshold_hours = 48` (**not** the documented default of
24) and `eligibility_mode = all-deployed`, because the SAP PGI feed is unbuilt. Every measurement in
this report uses 48 h, the real trigger. The result is insensitive to the choice — at 24 h the
at-plant share is 20.2%, at 48 h it is 20.1%.

### What is ingested, and what is thrown away

`AutoPlantSourceReader` selects nine columns from a table that has 119. Latitude and longitude *are*
among them and do land in `raw_device_snapshots` — but nothing downstream ever reads them. The
columns that would answer this investigation's question are not selected at all.

| Column in `tb_vehiclemaster` | What it carries | FSM status |
|---|---|---|
| `latitude`, `longitude` | Last known position | Ingested to `raw_device_snapshots`, **never read downstream** |
| `active_trip_id` | The vehicle's live trip, if any | **Not selected** |
| `vehicle_location_status` | ATPLANT / TOWARDSDESTINATION / RETURN / EMPTY / … | **Not selected** |
| `detention_type` | YARD / SOURCE / YARDBOUNDARY_250 — geofence dwell | **Not selected** |
| `current_location` | Reverse-geocoded address string | **Not selected** |
| `plant_id`, `plant_code` | Source-side plant fitment | Taken via master sync, not telemetry |
| `nearest_source_distance` | Distance to nearest source | **Not selected** — and correctly so: 61,078 of 63,486 rows are NULL and only 4 hold a real value. Dead column. |

---

## Current SE assignment

A daily cron (`dispatch_cron = 0 5 * * *`, Asia/Kolkata) runs `RecommenderService.runForZone` then
`BatchAssignmentService.dispatchForZone` per active zone. Per ticket: order candidate SEs by coverage
precedence (Dedicated → Multi-Plant → Floating), apply hard filters, score the survivor, write a
recommendation, group into a Day Plan.

The hard filters are the decision point, and this is where the loophole lives:

```ts
// recommender/hard-filters.ts — five filters, one dead
if (c.vehicleReadiness === 'ON_TRIP') return 'VEHICLE_ON_TRIP';   // <-- never true
if (!c.available)                     return 'SE_UNAVAILABLE';
if (c.overCapacity)                   return 'OVER_CAPACITY';
if (!c.commonKitComplete)             return 'COMMON_KIT_INCOMPLETE';
if (!c.expectedComponentsAvailable)   return 'COMPONENT_UNAVAILABLE';
```

`recommender.service.ts:283` constructs every candidate with `vehicleReadiness: 'UNKNOWN'`, a literal
with no data source behind it. **The filter is unreachable code.**

> ### ⚠ Two separate defects, easy to conflate
>
> Even if the seam were wired, it would not fix this. `SeCandidateReadiness` describes **the Service
> Engineer's** readiness — their availability, their kit, their van. `vehicleReadiness` in that struct
> is a property of the SE, not of the tracked truck. So there is no plumbing gap to close here; the
> presence check is a new concept that does not exist in the model at any layer.

### What the system does instead: it finds out afterwards

FSM's only handling of an absent truck is `VehicleUnavailabilityService` (Issue 28). The SE drives to
the plant, discovers the vehicle is gone, and files a report with a reason code — the available codes
are literally `VEHICLE_ON_TRIP` and `VEHICLE_NOT_AT_PLANT`. Filing pauses the primary SLA clock. The
trip has already been wasted; the design accepts that and manages the consequence.

The `vehicle_unavailability_reports` table currently holds **0 rows**, so there is no in-system record
of how often this happens. That is the measurement gap this report fills from the source side instead.

---

## Current planner behaviour

One day, recomputed daily. Traced through the tables, not the UI wording.

| Question | Answer | Evidence |
|---|---|---|
| Planner horizon | **Single day** | 709 `work_schedules` rows; **0** have `date_from <> date_to` |
| Days planned ahead | **Zero** — the run day only | `dispatch-run.service.ts`: "the Day Plan covers a single date" |
| Assigned once or repeatedly? | Recomputed every morning at 05:00 IST | `dispatch_cron = 0 5 * * *`; a re-run the same day is an idempotent no-op |
| Can an SE get the same plant on multiple days? | Yes, but as independent daily outcomes — not a plan | Each day is a fresh recommender pass over the open backlog |
| Are future-day assignments persistent? | **No such thing exists** | No schedule row has ever spanned days |
| Is ticket assignment tied to a visit date? | Yes — the schedule's single date | `batch_assignment_tickets` → `plant_batch_assignments` → `work_schedules` |
| Do planner entries override assignment? | **No — soft bias only** | Among *already-eligible* candidates, prefer the planner-named SE; otherwise strict precedence |

`se_planner` is a ZM-authored table of (SE × plant × date) intents with an arbitrary date range — so a
multi-day *intent* is expressible. It holds **2 rows** in total. It is not, in any operational sense,
in use.

> ### ⚠ Read the throughput numbers with care
>
> Of 148,991 recommendations ever produced, 135,052 (90.6%) are UNASSIGNABLE, and observed throughput
> is 7–24 tickets per SE per day against 11,956 open Troubleshoot tickets. **These figures are not
> load-bearing.** The SE roster in this environment is seeded, not real — 75 engineers with UUID
> identifiers and a uniform `daily_capacity` of 25 — so the unassignable rate measures the seed, not
> the field. What the numbers do establish is *shape*: dispatch is capacity-bound and the backlog
> vastly exceeds it. The magnitude needs re-measuring against a real roster before anyone plans
> against it.

---

## AutoPlant vehicle / device model

Twenty databases are visible on the account. FSM reads two. The authoritative current-state table for
the device-to-vehicle relationship is `ap_widgets.tb_vehiclemaster`.

```text
-- Cardinality, verified against production rows, not schema
devices_total              63,486
distinct_device_id         63,486   -> device_id is unique
distinct_vehicle_no        63,486   -> vehicle_no is unique
vehicles with >1 device         0
device_id == vehicle_no     2,932   -> placeholder rows: no real tracker fitted
ap_masters.mst_vehicle     51,634 rows, 51,634 distinct vehicle_no
```

In the current-state table the relationship is strictly **one vehicle ↔ one device**. Neither
one-to-many direction occurs.

The relationship *does* change over time. `ap_masters.mst_vehicle_log` holds 784,294 rows and
`tb_vehiclemaster_logs` 38,821 — remapping, replacement devices and re-installation are routine
(`INSTALLATION_SUBREMARK` carries values like `Same Device`, `Replacement Device`, `New Device`). Any
presence rule must therefore key on `device_id` as observed *now*, and must not assume a device's
history belongs to the vehicle it is currently fitted to.

The 2,932 rows where `device_id` equals `vehicle_no` are vehicles tracked through a third-party vendor
feed (`VENDOR_GPS`, `WheelEye`) or not tracked at all. These carry position data of markedly lower
resolution and should be treated as a separate class.

---

## AutoPlant location model

A schema-wide sweep for `lat|long|lng|gps|geo|fence|radius|boundary` across all `ap_*` schemas
returned 66 tables. Most are violation, toll or reporting artifacts. Four matter.

### 1. Live vehicle position — `ap_widgets.tb_vehiclemaster`

Exactly one row per device, mutated forward in place. `latitude`, `longitude`, `speed`,
`IGNITION_STATUS`, `latest_gps_datetime`. The server runs UTC (`NOW()` equals `UTC_TIMESTAMP()`), and
this column is written in UTC — a fact the FSM codebase established the hard way and documents at
length in `mapping.ts`. A handful of plants write IST into it instead, which surfaces as timestamps up
to 5.5 h in the future; the current skew guard rejects those. There is **no history** in this table —
it is latest-state only.

### 2. Historical position — `ap_widgets.tb_csr_history`

18.3 M rows, 10.9 GB, plus a 3.9 M-row archival table. Same column shape as `tb_vehiclemaster` with
an added `INSERTION_TIME` — it is a periodic snapshot archive of the vehicle master. Indexed on
`latest_gps_datetime` and on `(plant_id, transporter_id, vehicle_no)`, but **not on `INSERTION_TIME`
or `device_id`**, which makes per-device history retrieval expensive: a bounded probe against it
exceeded a 120 s budget. Usable for offline reconstruction, not for a hot path.

### 3. Plant coordinates — and the table that has them

> ### ⚠ The authoritative plant master has no geography
>
> `ap_masters.mst_plant` holds 26,986 rows across 54 columns: three address lines each for plant,
> billing and reverse-logistics, city, district, state, zipcode, country, SPOC name/email/phone — and
> **not one coordinate column**. FSM mirrors this table into `plants`, which has a PostGIS `geometry`
> column, `location`, populated for **0 of 933 rows**. It could not be populated: there is nothing to
> populate it from.

Coordinates for plants nonetheless exist in AutoPlant, in the trip-leg table. `ap_widgets.tb_legmaster`
carries `source_lat` / `source_long` per leg — the coordinates of the plant the leg departed from —
alongside `plant_code`, which joins directly to FSM's `plants.master_plant_code`.

```text
-- Plant coordinates recovered from tb_legmaster
-- stddev 0 means a fixed geofence centroid, not GPS noise
plant_code  source_geofence_name                    lat        lon        sd_lat    legs
9115        CCP                                     24.71650   74.66906   0.000000  3,882
9117        Nimbol Cement Plant                     26.33253   73.84523   0.000000  3,268
9211        RISDA CEMENT PLANT-9211                 21.63436   82.11076   0.000000  3,072
302         SATNA PLANT LINE 2                      24.56384   81.00170   0.000000  2,254
1000        Kadapa-1000                             14.59451   78.58134   0.000000  2,110
1002        SAURASHTRA CEMENT LIMITED UNIT RANAVAV  21.70461   69.71927   0.000000  1,453
```

A standard deviation of exactly zero across thousands of legs means this is a stored geofence centroid
replayed onto each leg — a definition, not an observation. That makes it trustworthy as a plant
coordinate.

**Coverage.** 444 distinct plant codes have coordinates. Against FSM's plant set:

| Population | Plants resolved | Coverage | Open tickets covered |
|---|---:|---:|---:|
| All FSM plants with a master code | 360 / 932 | 38.6% | — |
| **FSM plants with open tickets** | 147 / 201 | **73.1%** | **9,730 / 11,956 (81.4%)** |
| FSM plants with any device | 223 / 297 | 75.1% | 81.6% |

The largest single gap is **KESORAM WORKS** — 1,453 open tickets, 12% of the entire backlog — whose
`plant_code` is blank in `tb_vehiclemaster` and which runs no AutoPlant trips at all, so it generates
no legs. Its fleet is uniformly `DEPLOYED / EMPTY` with no trip records.

### 4. A fallback coordinate source, and its limits

Vehicles whose `detention_type` is `SOURCE` or `YARD` are, by AutoPlant's own reckoning, sitting inside
a plant geofence. Averaging their positions per plant yields a centroid. Validated against the
`tb_legmaster` values where both exist, this works only sometimes:

| plant_code | n | stddev (lat) | Δ vs legmaster | Verdict |
|---|---:|---:|---:|---|
| `9116` | 72 | 0.0012 | ~85 m | ✅ Usable |
| `5150` | 142 | 0.0009 | ~280 m | ✅ Usable |
| `9234` | 50 | 0.0018 | — | ✅ Usable |
| `9105` | 113 | 0.0739 | ~4 km | ❌ Reject |
| `9211` | 190 | 0.1991 | ~21 km | ❌ Reject |

The loose cases are plants whose YARD geofences include remote yards and sidings, not just the works.
A stddev gate (accept below ~0.005°) makes this a safe secondary source rather than a hazard. For
KESORAM specifically, the six `SOURCE`/`YARD` vehicles cluster tightly at **17.1598, 77.2889**
(stddev 0.0014) — a usable coordinate for the single biggest gap in the backlog.

### Geofence definitions

There is **no queryable geofence master** on this account. `ap_db_orderdata.tripconfig.geofences` is a
`mediumblob` containing the literal string `{}` in every row. `ap_bi_reports.vicat_geofence`
(6,322 rows) is a single-tenant BI extract of *customer* destinations, not plants. What does exist is
the radius *policy* in `ap_db_orderdata.tb_autogeofence_config`: destination geofences are auto-created
at 500 m to 15 km depending on company and order type, and the `YARDBOUNDARY_250` marker implies a
250 m yard boundary. AutoPlant evaluates geofences internally and exposes only the *outcome* — which,
fortunately, is the more useful thing.

---

## AutoPlant trip model

`ap_widgets.tb_tripmaster` (1.4 M rows, live) is the trip header; `tb_legmaster` (2.97 M rows) the
per-leg detail. The lifecycle runs `SCHEDULED → INITIATED → INPROGRESS → COMPLETED`, with
`AUTO_CLOSED` for timeouts and overrides, and a `trip_substatus` that names the physical phase.

| trip_status | trip_substatus | rows | What it means physically |
|---|---|---:|---|
| `INPROGRESS` | `TOWARDSCUSTOMER` | 5,107 | On the road, away from source |
| `SCHEDULED` | `SCHEDULED` | 2,746 | Trip created; **may not have moved yet** |
| `INPROGRESS` | `RETURN` | 1,763 | Returning toward source |
| `AUTO_CLOSED` | `QUEUED` | 933 | Abandoned or superseded |
| `INPROGRESS` | `ATCUSTOMER` | 787 | At destination |
| `INITIATED` | `ATSOURCE` | 641 | **Still at the plant** |
| `COMPLETED` | `ATSOURCE` | 915,098 | Closed on return to source |

Mirroring this, `tb_vehiclemaster.vehicle_location_status` gives the same phase on the vehicle row:
`ATPLANT` (365), `ATDESTINATION` (770), `TOWARDSDESTINATION` (4,609), `RETURN` (1,713), `SCHEDULED`
(1,263), `NEAR_BY_DESTINATION` (83), `EMPTY` (7,022 — no trip), `UNDEPLOYED` (46,366).

### Gate-in and gate-out exist, and they are precise

`tb_tripmaster` carries `source_entry_time`, `source_exit_time` and `source_tat`; `tb_legmaster` adds
the same for destinations. These are the plant gate events this investigation set out to look for.
They are real timestamps, not sentinels:

```text
-- Vehicles GPS-silent 48h+ that are on an INPROGRESS trip (5 of 740)
vehicle     plant               last_ping            source_entry         source_exit          destination
WB41K0750   PCP-5150            2026-08-16 05:29:07  2026-08-15 20:40:56  2026-08-16 01:53:18  SAINTHIA
JH05CK2021  JCP-9234            2026-08-16 05:06:01  2026-08-14 23:32:11  2026-08-15 23:20:41  SARAIYA HBG RD
MP19HA5033  SATNA PLANT LINE 1  2026-08-16 04:46:37  2026-08-15 03:10:22  2026-08-16 01:15:24  MIRZAPUR TRANSIT WH
RJ01GB6621  NCP-9117            2026-08-16 01:38:29  2026-08-15 08:56:02  2026-08-15 17:03:31  NUVOCO VISTAS
UP70FT4084  SATNA PLANT LINE 2  2026-08-15 17:54:44  2026-08-15 04:31:21  2026-08-15 11:24:09  KAUSHAMBI TRANSIT WH
```

Read the first row as an operations story: WB41K0750 entered PCP-5150 at 20:40 on the 15th, **left
through the gate at 01:53 on the 16th**, its tracker died at 05:29, and it is still en route to
Sainthia. Today is the 18th. FSM has a ticket open against this device and would dispatch an SE to
PCP-5150.

### The finding that makes a fix possible

> ### ✅ Trip state is independent of GPS health
>
> AutoPlant creates trips from orders and invoices, not from telemetry. So a truck with a dead tracker
> still gets dispatched, still gets a trip, still gets gate timestamps. Measured: **615 devices
> GPS-silent for an average of 2,762 hours (115 days) have a trip created an average of 566 hours
> (23 days) ago** — that is, a trip created *after* the device went dark. All 615 carry populated
> `source_entry_time` and `source_exit_time`.
>
> This is the crux. Every GPS-based approach degrades exactly where it is needed most, because
> inactivity *is* GPS failure. The trip and gate signals do not.

### Dwell events — `tb_trip_detention`

A live geofence-dwell engine: 62,367 open rows, one per vehicle-and-geofence entry, with
`detention_start_time`, `detention_end_time` (NULL while still inside), `entry_location` as raw
lat,lon, and a `detention_type` of `YARD`, `SOURCE`, `MOTHER GEOFENCE`, `DISTRICT` or `COMPETITOR`.

An open row with `detention_type = 'YARD'` and a `plant_code` matching the ticket's plant is a direct
assertion by AutoPlant that *this vehicle is inside that plant's yard right now* — the strongest
presence evidence available anywhere in the system, requiring no geofence maths on our side.

Its weakness is recall, not precision: it needs a trip context, so 72% of genuinely inactive devices
have no detention row at all.

---

## Vehicle presence detection

| State | Detectable? | How | Confidence |
|---|---|---|---|
| **AT_PLANT** | Yes, for a subset | Open `YARD` detention at own plant; or `vehicle_location_status = ATPLANT`; or fresh fix within plant radius | **HIGH** precision / **LOW** recall (8% via detention) |
| **ON_TRIP** | Yes | `active_trip_id` + `tb_tripmaster.trip_status IN (INPROGRESS, INITIATED)` | **HIGH** |
| **AWAY** (departed the plant) | Yes | `source_exit_time` populated and later than `source_entry_time` — an actual gate-out | **HIGH** |
| **AT_OTHER_PLANT** | Partially | Open `YARD` detention whose `plant_code` differs from the ticket's plant (50 cases found); or last fix within another plant's radius | **MEDIUM** |
| **IN_TRANSIT** (position now) | No, for inactive devices | Requires live GPS, which is by definition absent | **NOT RELIABLE** |
| **UNKNOWN** | Yes — and must be a first-class state | No plant coordinates, no trip, no detention, stale fix | **HIGH** |

The critical distinction the brief asked about — trip status versus actual physical movement — is real
and measurable. `SCHEDULED` and `INITIATED/ATSOURCE` trips are created before the truck moves;
641 vehicles are currently `INITIATED/ATSOURCE`, meaning trip-assigned but still standing in the plant.

**A trip alone must never be read as "away".** The discriminator is `source_exit_time`: a populated
gate-out is movement; a trip without one is only an intention.

Measured in the inactive population, this distinction is worth 179 devices out of 1,330 — vehicles
that *have* an active trip but whose last fix is still inside the plant. Treating trip presence as
departure would have wrongly deferred every one of them.

---

## Relevant tables

| Purpose | Database | Table | Important columns | Confidence |
|---|---|---|---|---|
| Live vehicle position and status | `ap_widgets` | `tb_vehiclemaster` | `device_id, latitude, longitude, latest_gps_datetime, active_trip_id, vehicle_location_status, detention_type, IGNITION_STATUS, speed` | **HIGH** |
| Trip header + **plant gate events** | `ap_widgets` | `tb_tripmaster` | `trip_id, device_id, plant_code, trip_status, trip_substatus,` **`source_entry_time, source_exit_time`**`, destination, trip_created_date` | **HIGH** |
| **Plant coordinates** + leg gate events | `ap_widgets` | `tb_legmaster` | `plant_code,` **`source_lat, source_long`**`, source_geofence_name/code, source_entry_time, source_exit_time, destination_lat/long` | **HIGH** (73% of ticketed plants) |
| Live geofence dwell (inside-now) | `ap_widgets` | `tb_trip_detention` | `device_id, plant_code, detention_type, detention_start_time, detention_end_time, entry_location, status` | **HIGH** precision, **LOW** recall |
| Historical position archive | `ap_widgets` | `tb_csr_history` | `device_id, latitude, longitude, latest_gps_datetime, INSERTION_TIME` | **MEDIUM** — unindexed for this access pattern |
| Plant master (*no geography*) | `ap_masters` | `mst_plant` | `plant_id, plant_code, plant_name, plant_city/district/state, zone_id` — **no lat/lon** | **NOT USABLE** |
| Vehicle master / fitment history | `ap_masters` | `mst_vehicle`, `mst_vehicle_log` | `vehicle_no, device_id, plant_id`, deployment status, installation dates | **HIGH** |
| Geofence radius *policy* | `ap_db_orderdata` | `tb_autogeofence_config` | `company_id, geofence_type, radius, reference` | **MEDIUM** — policy, not per-plant geometry |
| Customer geofences (single tenant) | `ap_bi_reports` | `vicat_geofence` | `GeofenceCode, GeofenceLatitude, GeofenceLongitude` | **LOW** — destinations, not plants |
| Raw GPS staging | `ap_db_rawdata` | `tb_raw_gps_data_max` | `latitude, longitude, gpsdatetime, geofenceid` | **LOW** — 85k rows, stale since 2026-08-10 |
| GPS middleware | `ap_gpsmw` | `ng_gps_data` | `lat, lon, gpsts` | **EMPTY** (0 rows) |

---

## Actual production evidence

**Method.** Take FSM's eligible, non-departed device population (15,311 devices with a resolvable plant
code), determine from *live* AutoPlant telemetry which are genuinely silent past the real 48 h
threshold, resolve each plant's coordinates from `tb_legmaster`, and compute the great-circle distance
from the device's last known fix to its assigned plant.

```text
-- Presence of genuinely-inactive devices
-- 2 km radius · plant centroid from tb_legmaster · 2026-08-18

FSM eligible, non-departed, plant code resolvable   15,311
  present in AutoPlant tb_vehiclemaster             15,243
  genuinely silent 48h+ per LIVE source              2,190
    of which geolocatable against a known plant      1,330
    no plant coordinates available                     851
    no GPS fix ever                                      5

DISTANCE FROM THE PLANT WE WOULD DISPATCH TO
  <= 0.5 km      120    9.0%   ###
  0.5 - 2 km     148   11.1%   ####
  2 - 10 km      146   11.0%   ####
  10 - 50 km     208   15.6%   ######
  > 50 km        708   53.2%   #####################

  AT PLANT (<= 2 km)   268   20.1%
  AWAY     (>  2 km) 1,062   79.9%
```

Re-run at a 24 h threshold over 1,581 geolocated devices: 319 at plant (20.2%), 1,262 away (79.8%).
**The result is not an artifact of the threshold.**

```text
-- Cross-tabulated by trip and fix age (the same 1,330 devices)

ON_TRIP | AWAY     | fix <=30d    310       ON_TRIP | AT_PLANT | fix <=30d     97
ON_TRIP | AWAY     | fix > 30d    223       ON_TRIP | AT_PLANT | fix > 30d     55
ON_TRIP | AWAY     | fix <= 3d     93       ON_TRIP | AT_PLANT | fix <= 3d     17
NO_TRIP | AWAY     | fix <=30d    304       NO_TRIP | AT_PLANT | fix <=30d     74
NO_TRIP | AWAY     | fix > 30d     84       NO_TRIP | AT_PLANT | fix > 30d     15
NO_TRIP | AWAY     | fix <= 3d     48       NO_TRIP | AT_PLANT | fix <= 3d     10

vehicle_location_status of this population     detention_type
  EMPTY                 1,368                    (null)               1,628
  SCHEDULED               548                    YARDBOUNDARY_250       483
  TOWARDSDESTINATION      314                    SOURCE                  67
  RETURN                   70                    YARD                     8
  ATPLANT                  48
```

```text
-- Independent corroboration: live geofence dwell
-- 2,445 inactive devices vs tb_trip_detention

no detention row at all                    1,761   (72% — needs a trip context)
open, non-YARD (DISTRICT/COMPETITOR/...)     435
OPEN YARD DETENTION AT ITS OWN PLANT         199   <- independently confirmed AT_PLANT
OPEN YARD DETENTION AT ANOTHER PLANT          50   <- confirmed AT_OTHER_PLANT

Examples (device silent 24h+, sitting inside its own plant yard):
  867542081447057   RCP-9211   Risda Cement Plant      since 2026-08-15 12:06
  862491072818378   ACP-9231   Arasmeta Cement Plant   since 2026-08-14 03:59
  867542081469580   NCP-9117   Chittor Cement Plant    since 2026-08-11 14:11
  0869925073557207  RCP-5151   Risda Cement Plant      since 2026-07-05 04:35
```

These are the tickets that *should* be dispatched: the truck is provably standing in the yard with a
dead tracker. 199 of 2,445 — about 8% — can be confirmed this way with no geofence maths at all.

---

## The critical gap

Stated plainly: **FSM equates "the tracker stopped reporting" with "the truck is parked at its plant
waiting for an engineer".** Those are different claims, and production data says the second is false
about 80% of the time.

```text
Source            Ingest             Derive              [MISSING]            Create              Assign
tb_vehiclemaster  9 of 119 columns   inactivity_hours    Is the vehicle       Troubleshoot        SE to
                                                          there?               ticket              Day Plan
```

The gap has four distinct causes, and all four must be addressed:

1. **No presence predicate exists.** Ticket creation and dispatch both gate on silence alone. There is
   no column, no service and no filter that could express "the vehicle is elsewhere".
2. **The location data we already ingest is discarded.** `raw_device_snapshots` stores `lat`/`lon` for
   1.85 M pings. Nothing reads them. `device_states` — the table every hot path consults — has no
   position column at all.
3. **No plant has coordinates.** `plants.location` is a PostGIS column that is NULL for all 933 rows,
   because its upstream `mst_plant` has none. Without this, no distance can be computed for any plant.
4. **The one guard that exists is inert.** `VEHICLE_ON_TRIP` is unreachable, and describes the SE's
   vehicle rather than the tracked truck even if reached.

### What it costs, concretely

Take the "100 inactive devices at one plant" scenario from the brief. It is not hypothetical and it is
understated. **KESORAM WORKS has 1,453 open Troubleshoot tickets** — 12% of the national backlog at
one site. NCP-9117 has 949, CCP-9115 has 919, RCP-9211 has 902.

The engine does not create a coherent visit; it creates a ticket per device and batches them 25 to a
plant batch. So the practical effect of the loophole is not only "an SE drives somewhere pointless" —
it is that a backlog inflated roughly five-fold by absent vehicles competes for a capacity-bound
queue, and the ~20% of tickets that would actually find a truck are ranked purely on silence duration,
with no signal that would float them to the top. Filtering on presence is therefore as much a
**prioritisation** fix as a wasted-trip fix.

---

## Data lineage

```text
AutoPlant Vehicle - ap_widgets.tb_vehiclemaster (63,486 rows, 1:1 device to vehicle)
|
+-- Device                device_id  [available, immutable, unique]
|                         2,932 placeholder rows where device_id == vehicle_no
|
+-- Latest GPS            latitude, longitude, latest_gps_datetime (UTC), speed, IGNITION_STATUS
|                         [STALE by definition for the population we care about]
|
+-- Trip                  active_trip_id -> tb_tripmaster
|   +-- status            trip_status / trip_substatus / vehicle_location_status   [live]
|   +-- origin            plant_code, source_geofence_name                         [live]
|   +-- destination       destination, destination_city, destination_geofence_name [live]
|   +-- gate-out          source_exit_time    [HIGH - survives GPS death]
|   +-- gate-in           source_entry_time   [HIGH - survives GPS death]
|
+-- Dwell events          tb_trip_detention (open row = inside geofence now)
|   +-- detention_type    YARD | SOURCE | MOTHER GEOFENCE | DISTRICT | COMPETITOR
|   +-- plant_code        [HIGH precision]
|   +-- detention_end_time  NULL = still inside      [LOW recall - 28% coverage]
|
+-- Plant
    +-- identity            ap_masters.mst_plant -> FSM plants.master_plant_code  [available]
    +-- latitude/longitude  ABSENT from mst_plant -> recover from tb_legmaster.source_lat/long
    |                       [73% of ticketed plants; 81% of open tickets]
    +-- geofence radius     no per-plant geometry exposed - policy only (250m yard / 500m-15km dest)
```

```text
Proposed pipeline - one new stage, everything else unchanged

AutoPlant -> Snapshot ingest -> Device inactivity -> VEHICLE-PRESENCE RESOLUTION -> Ticket creation
               + 4 columns                                      |
                                                    AT_PLANT -> create + rank normally
                                                    AWAY     -> create, hold from dispatch
                                                    UNKNOWN  -> create, rank below AT_PLANT
                                                                |
                                                    SE assignment -> Day Plan
```

---

## Recommended architecture

Five changes, in dependency order. None requires new infrastructure; all read tables that already
exist.

### 1. Populate plant coordinates (prerequisite for everything else)

Add a step to the daily master sync that resolves each plant's centroid and writes `plants.location` —
the PostGIS column that already exists. Primary source: `AVG(source_lat, source_long)` from
`tb_legmaster` grouped by `plant_code`, restricted to a rolling window. Secondary source, only when
stddev is below 0.005°: the centroid of vehicles at that plant with
`detention_type IN ('SOURCE','YARD')`. Record which source was used and the sample size — a coordinate
of unknown provenance is worse than none. Expect ~73% of ticketed plants from the primary source; the
fallback closes KESORAM.

### 2. Carry the four discarded columns through ingestion

Extend `SELECT_COLS` in `autoplant-source-reader.ts` by `active_trip_id`, `vehicle_location_status`,
`detention_type`, `plant_code`. These ride the existing 30-minute telemetry tick at no extra query
cost, exactly as `TRIP_CREATION_DATETIME` already does. Land them on `device_states`, alongside
`latestLat` / `latestLon` — because a presence rule that has to join `raw_device_snapshots` on every
dispatch will not survive contact with the hot path.

### 3. Add a second read against the trip tables

The gate events are the highest-value signal and are not on `tb_vehiclemaster`. A separate bounded
query per sync — `tb_tripmaster` joined on `active_trip_id`, selecting `trip_status`, `trip_substatus`,
`source_entry_time`, `source_exit_time`, `destination` — plus open `YARD` rows from
`tb_trip_detention`. Scope it to devices FSM actually tracks, not the whole fleet.

### 4. A dedicated presence resolver

One service, one pure function, four outcomes. It must be a distinct stage rather than extra
predicates bolted onto ticket creation, because its verdict is consumed in two different places with
two different policies (creation versus dispatch), and because it needs to be explainable — every
ticket should be able to say *why* the system thinks the truck is or is not there.

### 5. Make UNKNOWN a real state, not a synonym for yes

27% of the inactive population has no resolvable plant coordinate and no trip. The system must be able
to say so. Collapsing `UNKNOWN` into `AT_PLANT` reproduces today's behaviour on a third of the fleet;
collapsing it into `AWAY` would suppress genuine work. It gets its own rank.

---

## Recommended ticket rule

> ### Create the ticket regardless. Gate the dispatch.
>
> A device that is silent is broken whether or not its truck is at the plant, and Fleet Uptime must
> keep counting it. Suppressing ticket *creation* on presence would corrupt the KPI the platform
> exists to produce. Presence belongs at the *dispatch* decision, not the *detection* one.

Evaluated in order; first match wins:

| Outcome | Test | Action |
|---|---|---|
| **AT_PLANT**<br>*high confidence* | Open `YARD` detention at this plant, **or** `vehicle_location_status = ATPLANT`, **or** last fix within 2 km of the plant centroid **and** no gate-out after that fix | **Eligible for dispatch, ranked normally** |
| **AWAY_ON_TRIP**<br>*high confidence* | Active trip with `source_exit_time` later than `source_entry_time` and no subsequent return — the vehicle went through the gate | **Ticket stays open; withheld from dispatch.** Surface expected return from `onward_updated_eta` where present |
| **AWAY_NOT_ON_TRIP**<br>*medium confidence* | No trip, but last fix more than 2 km from the plant and no older than 30 days | **Withheld from dispatch, flagged for ZM review** — also how a vehicle that quietly moved plants surfaces |
| **LOCATION_UNKNOWN** | No plant coordinates, or no fix, or the only fix is more than 30 days old with no trip and no detention | **Eligible for dispatch but ranked below every AT_PLANT ticket.** Never silently treated as present |

**Radius.** 2 km, not the 250 m implied by `YARDBOUNDARY_250`. The plant centroid is a geofence centre,
not a gate, and cement works are large; at 2 km the at-plant share is 20.1% versus 9.0% at 500 m, and
the 0.5–2 km band is overwhelmingly plant premises and immediately adjacent parking. This should be a
configurable setting per the platform's existing pattern, with the ability to override per plant once
real data accumulates.

**Freshness.** Do not require a fresh fix — that would eliminate the entire population by construction.
Instead grade it: a fix no older than 3 days is strong, up to 30 days is usable when corroborated by
trip or detention, and beyond 30 days GPS alone drops to `LOCATION_UNKNOWN` unless a trip or detention
signal carries it.

---

## Recommended assignment rule

Presence is a **ticket** property, not an SE property, so it does not belong in `SeCandidateReadiness`
alongside kit and availability. It belongs one level up, where the ticket list is assembled — the same
place the #238 threshold gate and the deferral filter already sit in `RecommenderService.runForZone`.

| Existing concern | How presence interacts |
|---|---|
| **SE availability** | Orthogonal. Unchanged. An available SE with no present vehicle should not be dispatched — that is the whole point. |
| **SE capacity** | Presence filtering should *free* capacity, not consume it. With ~80% of tickets withheld, per-SE daily capacity is spent on visits that find a truck. |
| **SE planner** | Unchanged as a soft bias, but becomes more useful: a ZM planning a plant visit should see how many present vehicles are actually waiting there. |
| **Plant grouping / cluster multiplier** | The multiplier should count *present* vehicles only. Today it rewards batching a plant with 1,453 tickets regardless of whether any truck is there. |
| **Trip status** | New input. `INITIATED/ATSOURCE` and `SCHEDULED` must not count as away — 641 vehicles are trip-assigned but standing in the plant. |
| **Ticket priority / SLA bucket** | Presence must *not* change the SLA clock — a truck away for three weeks is still failing. It changes dispatch order, not severity. |
| **Vehicle unavailability reports** | Becomes the exception path rather than the norm. An SE filing `VEHICLE_NOT_AT_PLANT` against a ticket the resolver called `AT_PLANT` is a high-value calibration signal — log it and measure against it. |

**A hard stop must not be the default.** Withheld tickets should be counted and surfaced on the
dispatch-run ledger exactly as `withheldBelowThreshold` already is — separately from `unassignable`,
since a withheld ticket is policy working, not a coverage failure. A ZM must retain an explicit
override: presence inference will be wrong sometimes, and a manager with a phone call to the
transporter knows better than a geofence.

---

## Edge cases

| Case | Observed | Handling |
|---|---|---|
| Stale GPS | Universal — inactivity *is* GPS staleness | Grade by fix age (3d / 30d / beyond); never treat a stale fix as current position without a corroborating trip or detention signal |
| GPS never available | 5 devices in the eligible population | `LOCATION_UNKNOWN`; also the #223 never-reported class, aged from install date |
| Vehicle on trip | 61% of geolocated inactive devices | `AWAY_ON_TRIP` only if `source_exit_time` confirms a gate-out |
| Trip planned but not started | 641 `INITIATED/ATSOURCE` + 2,746 `SCHEDULED` fleet-wide; 179 in the inactive population sit at plant *with* a trip | Trip alone is never "away". Gate-out is the discriminator. |
| Trip completed | 915,098 close as `COMPLETED/ATSOURCE` — back at source | A completed trip returning to source is weak evidence *for* presence; destination-side gate events give last known location |
| Vehicle at another plant | 50 confirmed via open YARD detention elsewhere | `AT_OTHER_PLANT` — dispatch to *that* plant if an SE covers it, else flag for ZM |
| Parked just outside the geofence | 146 devices in the 2–10 km band | Genuinely ambiguous. The 2 km radius deliberately absorbs premises sprawl; the 2–10 km band should be reviewable rather than auto-withheld |
| Multiple devices on one vehicle | **Zero cases** in current state | Not a concern today; do not build for it |
| Device replaced / vehicle remapped | Routine — 784k `mst_vehicle_log` rows | Key presence on `device_id` as fitted *now*; never inherit a prior fitment's location history |
| Vehicle deactivated / left fleet | 12,876 active departures (UNDEPLOYED 12,516, MISSING_FROM_SOURCE 3,356) | Already handled by `device_departures`. This is **fleet** departure, a different concept from **plant** departure — do not conflate |
| Temporary visit to another plant | Not separable from a permanent move on current data | `AT_OTHER_PLANT` with ZM review; no automated inference |
| Many inactive vehicles at one plant | KESORAM WORKS: 1,453 open tickets, no `tb_legmaster` coordinates | Fallback centroid (17.1598, 77.2889, stddev 0.0014) resolves it; without it, 12% of the backlog stays `LOCATION_UNKNOWN` |
| Third-party tracked vehicles | 2,932 rows where `device_id == vehicle_no` | Lower positional resolution; treat as a distinct confidence class |
| IST-writing plants | ~5 devices write IST into a UTC column | Already rejected by the existing skew guard; would otherwise read as permanently fresh |

---

## Confidence matrix

| Capability | Available? | Source | Confidence |
|---|---|---|---|
| Device inactivity | Yes | `tb_vehiclemaster.latest_gps_datetime` | **HIGH** |
| Vehicle identity | Yes | `tb_vehiclemaster.vehicle_no`, `mst_vehicle` | **HIGH** |
| Vehicle → device | Yes, 1:1 | `tb_vehiclemaster` (63,486 / 63,486 unique both ways) | **HIGH** |
| Latest GPS position | Yes, but stale for this population | `tb_vehiclemaster.latitude/longitude` | **MEDIUM** |
| Vehicle → plant | Yes | `mst_vehicle.plant_id` → FSM `plants` | **HIGH** |
| Active trip | Yes | `active_trip_id` + `tb_tripmaster.trip_status` | **HIGH** |
| Trip origin / destination | Yes | `tb_tripmaster.plant_code`, `destination`, geofence names | **HIGH** |
| **Vehicle at plant** | ~28% directly, ~61% with GPS inference | `tb_trip_detention` (YARD), `vehicle_location_status`, GPS + centroid | **HIGH** where detention exists; **MEDIUM** via GPS |
| Vehicle at another plant | Partially — 50 confirmed | `tb_trip_detention` with foreign `plant_code` | **MEDIUM** |
| **Vehicle departure (gate-out)** | Yes — survives GPS death | `tb_tripmaster.source_exit_time` | **HIGH** |
| Vehicle arrival (gate-in) | Yes | `tb_tripmaster.source_entry_time`, `tb_legmaster.destination_entry_time` | **HIGH** |
| Plant coordinates | Yes — but not from the plant master | `tb_legmaster.source_lat/long` (73% of ticketed plants) | **MEDIUM** — coverage-limited, values exact |
| Geofence geometry / radius | No per-plant geometry | `tb_autogeofence_config` (policy only); `tripconfig.geofences` empty | **LOW** |
| Geofence *outcome* (inside now) | Yes | `tb_trip_detention` open rows, `detention_type` | **HIGH** precision, **LOW** recall |
| Weighbridge / loading events | No | No weighbridge table found in any accessible schema | **ABSENT** |
| Live position of a silent device | No | — | **NOT RELIABLE** |
| Historical movement reconstruction | Yes, offline only | `tb_csr_history` (18.3 M rows, not indexed for this access) | **MEDIUM** |

---

## Final recommendation

No code was modified. In priority order:

1. **Populate `plants.location`.** Nothing else is buildable until this exists, and it is the cheapest
   item on the list. Primary source `tb_legmaster`, fallback tight-cluster detention centroid,
   provenance recorded. This alone unblocks 81% of open tickets.

2. **Widen the telemetry select by four columns** and land them plus lat/lon on `device_states`. Zero
   additional queries; the pattern already exists for `TRIP_CREATION_DATETIME`.

3. **Add the trip and gate read.** `source_exit_time` is the single highest-value field in this
   investigation, and it is not on the table we currently query. It is the only signal that reliably
   distinguishes "left the plant" from "trip planned", and the only one that works on devices whose
   GPS is dead.

4. **Build the presence resolver** as a distinct stage with four explicit outcomes and a stored reason
   per ticket.

5. **Gate dispatch, not creation.** Keep opening tickets so Fleet Uptime stays honest; withhold
   `AWAY_*` from the Day Plan, rank `LOCATION_UNKNOWN` below `AT_PLANT`, count withheld separately on
   the run ledger, and give the ZM an override.

6. **Then measure.** Every `vehicle_unavailability_report` filed against a ticket the resolver called
   `AT_PLANT` is a labelled false positive. That table has 0 rows today; it should become the
   calibration set that tunes the radius and the freshness bands.

> ### ⚠ One thing not to do
>
> Do not build this as a GPS geofence check alone. It is the obvious design and it fails on the exact
> population it targets: the vehicles are inactive *because* their GPS stopped, so a fix-and-radius
> rule is reasoning from evidence that is stale by construction. GPS is the third-best signal here.
> Open yard detention is first, gate-out is second, and both keep working after the tracker dies.

---

## Limits of this study

- **Device and plant data are real; the SE roster is not.** `devices`, `device_states`,
  `raw_device_snapshots` and `plants` (932 of 933 carry an AutoPlant `source_plant_id`) are genuine
  mirrors, and tickets were generated by the real pipeline over real device state — so every presence,
  distance, plant and ticket-count figure here stands. The engineer roster, coverage map and
  capacities are **seeded** (75 engineers, UUID ids, uniform `daily_capacity` of 25). Any statement
  about SE throughput, capacity or unassignable rates is therefore indicative only.

- **FSM's local database is not live.** The ingestion scheduler is off
  (`INGESTION_SCHEDULER_ENABLED=false`); the last snapshot run (161, SUCCESS) was 2026-08-17 10:43 IST.
  Consequently many of the 11,956 open tickets are stale — their devices have since resumed reporting.
  Presence figures were therefore computed against devices confirmed inactive by *live* AutoPlant
  reads, not against FSM's ticket set, and the two populations differ.

- **Plant centroids are geofence centres, not gates.** Distance is measured to a point, and a large
  cement works may extend well beyond 500 m from it. This is why 2 km rather than 250 m is
  recommended, and it makes the 0.5–2 km band the least certain part of the classification.

- **27% of the inactive population could not be geolocated at all** (851 of 2,190, no plant
  coordinates). Those devices are absent from every distance figure quoted, and their true split is
  unmeasured.

- **The AT_PLANT share is a lower bound in one respect and an upper bound in another.** Devices whose
  last fix is months old were classified on that fix; some have since moved. Conversely, a vehicle
  that returned to the plant after its tracker died is invisible to GPS and only recoverable via
  detention or a returning trip.

- **No weighbridge, POD or gate-register table was found** in any accessible schema. If such a system
  exists it is outside this database or outside this account's grants, and it would be worth asking
  AutoPlant directly.

- **`tb_csr_history` was not fully exercised.** Per-device history retrieval exceeded a 120 s bounded
  budget because the table is indexed on `latest_gps_datetime` and
  `(plant_id, transporter_id, vehicle_no)` but not on `device_id` or `INSERTION_TIME`. Historical
  reconstruction is feasible offline; a supporting index would be required for anything routine.

- **All queries were read-only and bounded.** No INSERT, UPDATE, DELETE, ALTER, CREATE or DROP was
  issued; the query helper refused non-read statements at the seam.

---

*Read-only forensic investigation · AutoPlant production MySQL 8.0.43 at 10.0.0.25 · FSM Postgres 16 +
PostGIS at localhost:5433 · Report generated 2026-08-18 · no production data modified · no application
code modified*
