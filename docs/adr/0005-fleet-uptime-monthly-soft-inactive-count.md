# ADR-0005: Fleet Uptime Is Monthly Time-Weighted with Eligibility Gating; Soft Inactive Count Drives the Recommender

## Status

Accepted

## Context

Two concerns must be separated: (1) the contractual SLA metric customers see, and (2) the operational signal the Recommender uses to switch modes. A monthly time-weighted metric is too lagging for intraday operations. An instant snapshot doesn't meet contractual derivability requirements. Finer-grained signals (4h/8h) would diverge from the 24h inactivity threshold used everywhere else, creating mental-model split.

## Decision

**Fleet Uptime %** (contractual master KPI) is the **time-weighted fraction of the month a Device was online**, calculated only over **Eligible Devices**. Eligibility: had an active order/PGI within the last ~15 days *and* is not currently Non-Operational. Denominator = `eligible_device_count`, not raw installed count. Target ≥98%. Window = 1 calendar month. Reported per fleet / zone / company / plant.

A parallel **Soft Inactive Count** drives the Recommender's **deficit-mode vs preventive-mode** switch — count of Eligible Devices currently silent for >24h (same eligibility filter). Recomputed **twice daily** (morning before the batch; afternoon before the next re-plan window).

- **Deficit Mode** — active when Soft Inactive Count > 2% × `eligible_device_count` (configurable). Recommender prioritises maximum devices-cleared-per-SE-day with plant clustering.
- **Preventive Mode** — active otherwise. Recommender shifts to repeat-offenders, aged devices, and Install backlog.

## Consequences

- A `DEVICE_ELIGIBILITY` view tracks `eligible_for_uptime` per Device per day, derived from `PGI_HISTORY` and `NON_OPERATIONAL_MARKING`.
- A `NON_OPERATIONAL_MARKING` table records who excluded which Device, when, why; entries have effective windows.
- Monthly uptime calculation is a batch job.
- Reports show both numbers side by side so management sees operational deficit (Soft) and contractual SLA (monthly) as related but distinct stories.
- The Recommender threshold for switching to Deficit Mode is configurable (default `> 2% × eligible_device_count`).
