# Device installation quality — 180 days to 9 August 2026

**One-off analysis. Prepared 2026-08-09.**

We can now measure, for every device installed in the last six months, whether it ever reported its
position. A device that is fitted but never reports is a device the customer is paying for and nobody
is tracking. This is the first time that has been looked at by installer and by plant.

---

## The main finding: vehicles are being marked as commissioned before anyone checks they report

**When a vehicle is set up for tracking by an outside GPS provider rather than our own hardware,
nothing in the process confirms the provider's data feed is actually live before the vehicle is
treated as done.** Across the last 180 days, **43% of vehicles registered that way have never
reported a position** — 91 of 211 — against **6.6%** for vehicles with our own hardware fitted.

This is a process gap, not a people problem, and it is the single most actionable thing in this
report. Fixing it means adding one step: a vehicle is not commissioned until a first position has
been received.

### It is live right now — 77 vehicles, 86 days

A single batch on **15 May 2026** accounts for 77 of those 91 failures. As of today:

| | |
|---|---:|
| Vehicles in that batch still never tracked | **77 of 79** |
| Days uncovered | **86** |
| **Currently DEPLOYED — in service, untracked** | **28** |
| Have run at least one trip while untracked | **33** |
| Recovered on their own since May | **0** |

Transporters affected include CJ DARCL Logistics, Jaysons Transways, Khatri Roadlines and Navalakha
Translines, almost all at **DSTL K1PLANT**.

**Every vehicle number is listed in `uncovered-vehicles-2026-05-15.csv`**, with its transporter,
deployment status and days uncovered. If anyone believes these 28 deployed vehicles are being
tracked, they are not, and have not been since May.

---

## The headline number

| | |
|---|---:|
| Devices installed, last 180 days | **16,730** |
| Of those, never reported once | **1,188** |
| **Fleet failure rate** | **7.10%** |

Roughly **one device in fourteen** is installed and never comes online. That is the number every
figure below should be read against.

## The rate depends heavily on what kind of account did the install

| Account type | Installs | Never online | Failure rate |
|---|---:|---:|---:|
| Named individuals | 7,397 | 287 | **3.88%** |
| Shared plant logins (`GGVL_SERVICE`, `UTCL_SERVICE_GGU` …) | 5,637 | 343 | **6.08%** |
| No installer recorded (`NA`) | 2,402 | 322 | **13.41%** |
| **Automated/machine accounts** (`INTEGRATION_SERVICE`, `*_IMPADMIN` …) | 795 | 190 | **23.90%** |

**Machine accounts fail six times more often than named people.** This matters for how the rest of
this report is read: bulk automated provisioning, not field technicians, is where most of the failure
sits. A league table that mixed the two together would blame the wrong group.

## Worst performers, installs ≥ 30

Full data in `installer-failure-rate-180d.csv`.

| Installer | Type | Installs | Never online | Failure rate |
|---|---|---:|---:|---:|
| **PRATIK PAWAR** | individual | 79 | 77 | **97.5%** ⚠ see below |
| INTEGRATION_SERVICE | machine | 301 | 136 | 45.2% |
| GB_BOKARO | individual | 46 | 19 | 41.3% |
| DEEPAK_IMPADMIN | machine | 55 | 15 | 27.3% |
| SERVICE-ACCOUNT-EPOD-SERVICE | machine | 54 | 14 | 25.9% |
| UTCL_SERVICE_MCU | shared login | 94 | 17 | 18.1% |
| GGVL_SERVICE | shared login | 183 | 28 | 15.3% |

By plant (full data in `plant-failure-rate-180d.csv`):

| Plant | Installs | Never online | Failure rate |
|---|---:|---:|---:|
| **DSTL K1PLANT** | 117 | 81 | **69.2%** |
| MCU | 125 | 34 | 27.2% |
| DEPOT_RCM | 30 | 7 | 23.3% |
| RCM | 511 | 98 | 19.2% |
| SATNA PLANT | 51 | 9 | 17.7% |
| GGVL | 184 | 28 | 15.2% |
| GGU | 780 | 105 | 13.5% |

---

## PRATIK PAWAR — what is actually going on

**97.5% is real, but it is not a technician failing at 79 installations.** The evidence points
somewhere else entirely, and the distinction changes what should be done about it.

**All 79 happened on a single day, inside two and a half hours.** Every one is dated 15 May 2026,
between 14:26 and 16:54 IST, across four plants in different states. Nobody physically fits 79 GPS
units in four locations in an afternoon. This is a bulk data entry or provisioning session, not field
work.

**None of the 79 has a real device fitted.** In all 79 records the "device ID" is simply the vehicle's
number plate rather than a hardware serial. That is a legitimate pattern — it is how vehicles tracked
by a *third-party* GPS provider are registered, where the data is fed to us by an outside vendor
instead of coming from our own hardware.

**And that is exactly where it breaks:**

| | Device type recorded | Vendor recorded | Result |
|---|---|---|---|
| 77 records | *(blank)* | *(blank)* | never reported |
| 1 record | VENDOR_GPS | Binary Semantics Ltd. | **reporting fine** |
| 1 record | VENDOR_GPS | Intangles | **reporting fine** |

The two that had a vendor attached work. The 77 that were left with no device type and no vendor
never produced a single position — because there is no feed to produce one. **These are vehicles
registered for third-party tracking where the vendor connection was never completed.**

**It is not the sites, and it is not the vehicles.** At the same plants, other accounts do fine —
`INTEGRATION_SERVICE` did 17 installs at DSTL K1PLANT with zero failures. The same vehicle-number
ranges installed by others report normally.

**It is a system-wide gap, and this account is simply where most of it landed.** Across the whole
fleet in 180 days, vehicles registered this way (number plate as device ID) fail at **43.1%** — 91 of
211 — against **6.6%** for real hardware. PRATIK PAWAR's 77 are **85% of every failure in that
category**.

### What we would suggest

1. **Ask what happened on 15 May 2026** — who ran that session, for which customer, and whether the
   vendor integration for those 77 vehicles was ever meant to be completed.
2. **Check whether those 77 vehicles are still uncovered today.** If the customer believes they are
   tracked, they are not.
3. **Treat third-party GPS registration as its own process.** 43% of it fails. There appears to be no
   step that confirms the vendor feed is live before the vehicle is treated as commissioned.
4. **Do not treat this as an individual performance issue** on the evidence here.

### One related pattern worth noting

Large single-day batches generally go badly. Other examples in the window:

| Account | Date | Installs that day | Never online |
|---|---|---:|---:|
| VICAT_KADAPA_SERVICE | 2026-04-26 | 283 | 86 |
| INTEGRATION_SERVICE | 2026-08-07 | 64 | 47 |
| INTEGRATION_SERVICE | 2026-08-06 | 76 | 45 |
| NA (no installer) | 2026-03-14 | 178 | 47 |

Those August dates are recent enough that some devices may simply not have reported *yet*. The May
and March ones are not.

---

## How to read this — please do not skip

**These names identify an account, not a proven person.** The installer field holds a login string.
There is no staff directory behind it, so we cannot confirm who was using an account on a given day,
and several entries are clearly software rather than people. Nothing here should be used in a
performance conversation without first confirming who actually holds the login.

**Some installs have no installer at all.** 12.9% of 2026 installs (2,411 of 18,735) record `NA` or
nothing. They are shown as their own row and are not distributed across the named accounts.

**The installer on a record can change.** 7.3% of devices have had their recorded installer rewritten
over time (5,929 of 81,534, measured from the change log). Separately, 74% of devices show a *most
recent* installer different from the *first* — normal churn as devices are re-fitted to other
vehicles, but it means each row describes one fitment event, not a person's overall record.

**History is destroyed as it goes.** When a device is moved to another vehicle, the source system
overwrites the previous installation record. So this measures a population that is quietly changing
underneath us, and the same analysis run in three months will not be able to reproduce these exact
numbers. That is the reason for the separate work now under way to record each commissioning event
permanently as it happens.

**"Never online" means no position has ever been received** for that device as of 9 August 2026.
Devices installed in the last few days may still be in normal commissioning and are not necessarily
failures.

---

## Files

| File | Contents |
|---|---|
| `uncovered-vehicles-2026-05-15.csv` | **The action list** — all 77 still-untracked vehicles: number, plant, transporter, deployment status, days uncovered |
| `installer-failure-rate-180d.csv` | All 61 accounts with ≥30 installs — installs, failures, rate, account type, plants covered, first and last install date |
| `plant-failure-rate-180d.csv` | All 51 plants with ≥30 installs — installs, failures, rate, number of distinct installers |
