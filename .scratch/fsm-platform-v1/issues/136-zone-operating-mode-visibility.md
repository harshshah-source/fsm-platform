# 136 — Zone operating-mode visibility ("Catch-up" vs "Steady") for ZM + OH

Status: ready-for-agent
Type: AFK

> **This is a UI *visibility* feature — read-only. Not a config surface, not admin plumbing.** It
> shows a ZM (and OH/CSM) something the engine *already decides per zone* but never surfaces. Nothing
> here lets anyone edit, tune, or configure the engine. The per-zone *configuration* ask was analysed
> and **decided against** — see `docs/proposals/zone-engine-customization-2026-07-21.md` (commit
> `f0f3dcb`), §5 "P1", and the INDEX "Deferred / decided-against" section. This issue is that P1.

## Why this exists

The recommender **already personalises itself per zone**: `SoftInactiveCountService.modeForZone`
computes a zone's operating mode live — DEFICIT when that zone's silent-eligible-device count exceeds
`thresholdPct × eligible`, else PREVENTIVE (`apps/backend/src/reports/soft-inactive-count.service.ts:41-51`).
The recommender reads it every run and it changes what the zone's dispatch does — DEFICIT chases
outages; PREVENTIVE also pulls in the install backlog and biases aged/repeat devices
(`apps/backend/src/recommender/recommender.service.ts:101,146,387`).

**A ZM cannot see this today, or why it is what it is.** The mode is returned on `RunSummary`
(`recommender.service.ts:387`) and stamped into each recommendation's breakdown, but dispatch runs are
gated OFF and there is no plain-language surface anywhere. The result is an engine that quietly
behaves differently in different zones with zero legibility to the people running those zones.

This feature closes that gap and nothing more. It is deliberately the *whole* safe slice: the analysis
(proposal §3.1) shows the tempting next step — letting a ZM *change* the mode/threshold — corrupts the
Fleet-Uptime denominator and hands a graded ZM their own scorecard dial. So we surface, we do not tune.

## Vocabulary rule (hard constraint)

ZMs are non-technical. The UI must **never** show `DEFICIT` / `PREVENTIVE`, "threshold", "deficit %",
"soft inactive count", or any engine term. Map to plain operational language in exactly one place (a
small FE util), so wording is swappable:

| Engine mode | Plain label (placeholder) | One-line plain meaning |
|---|---|---|
| `DEFICIT`    | **Catch-up mode** | "Too many devices in your zone have gone quiet, so the system is focused on getting engineers to those outages first." |
| `PREVENTIVE` | **Steady mode**   | "Quiet devices in your zone are under control, so the system is also fitting in preventive visits and new installations." |

Final copy is subject to CONTEXT.md domain-language sign-off (the authority per CLAUDE.md); the
placeholders above are shippable and trivially swapped (one util). This is the only open decision and
it does not block building — see "Open decision" below.

## What it shows

**ZM dashboard — own zone (primary).** A single plain-language card/badge stating the zone's current
mode, a one-line reason, and the supporting fact in human terms — e.g. *"Catch-up mode — 142 of 3,010
devices we track in your zone are currently quiet, above the level where the system switches to
Catch-up."* No numbers presented as knobs; no percentage/threshold vocabulary.

**OH + CSM dashboards — cross-zone (visibility).** A compact all-zones overview (one row/chip per
zone) showing each zone's current mode at a glance, so an OH can see which zones are in Catch-up
without opening each. Read-only; clicking a zone may deep-link to that zone's existing dashboard/queue
(reuse existing navigation — do not invent a new drill-down).

## Backend — a thin read seam (not plumbing)

The engine is not touched. We expose the signal it already computes.

- [ ] `SoftInactiveCountService.modeForZone` returns only the enum; add a sibling (e.g.
      `operatingModeForZone(zoneId)` / `operatingModes(zoneIds?)`) that returns the mode **plus the
      counts already computed in the same aggregate query** — `{ zoneId, mode, silentCount,
      eligibleCount }` (the query at `:42-48` already selects `softInactive` + `eligible`; expose them
      rather than discarding them). No new persistence, no new query shape, no writes.
- [ ] Read endpoint `GET /api/dashboard/operating-mode` returning per-zone
      `{ zoneId, zoneName, mode, silentCount, eligibleCount }`. ZM: response is clamped to their own
      `zone_id` (guard + service, same posture as the other dashboard reads). OH/CSM: all zones (or a
      passed `zoneId`). Deactivated plants (#119) excluded consistently with the neighbouring counts.
- [ ] Mode is computed **live** (reuse the existing aggregate), not read from
      `soft_inactive_count_history` — the history table is twice-daily and only populated when the
      gated soft-inactive sweep runs, so it would show stale/empty. (History remains available as an
      optional "as of" fallback only if a point-in-time view is later wanted — out of scope here.)
- [ ] Tests: ZM response covers only their zone regardless of any `zoneId` passed (403/clamp);
      OH response covers all zones; a zone with 0 eligible devices resolves to a mode without dividing
      by zero (matches `isDeficit` at `:80-82`); counts in the response equal the live `device_states`
      aggregate.

## Frontend

- [ ] One plain-language mapping util (mode enum → label + reason sentence); the enum never reaches a
      rendered string. Unit-tested.
- [ ] ZM own-zone mode card — placed per the reference dashboard chrome (see Surfacing rule); matches
      the card/section style of its neighbours, no redesign. Renders honestly when counts are 0/absent.
- [ ] OH + CSM cross-zone mode overview (one row/chip per zone). Reuses the existing zone list; a zone
      row deep-links via existing navigation (no new page).
- [ ] Tests: the card shows the plain label + reason (and never the raw enum/threshold words); the OH
      overview lists every zone with its mode; an empty/zero state renders without crashing.

## Slice plan (splits naturally into 3 small slices)

1. **Backend read seam** — expose mode + counts (`operatingModeForZone`/`operatingModes`) +
   `GET /api/dashboard/operating-mode`, ZM-clamped / OH-all, + tests. Ships nothing visible; unblocks 2–3.
2. **ZM own-zone visibility card** — the plain-language card on the ZM dashboard + the mapping util + tests.
3. **OH/CSM cross-zone overview** — the all-zones mode strip on the OH/CSM dashboards + tests.

(2 and 3 both consume 1; either can ship first after 1. Each slice is independently test-green and
tsc-clean per the repo's per-slice TDD report format.)

## Open decision (does not block building)

Final plain-language copy for the two modes and the reason sentences — owned by CONTEXT.md
domain-language authority. Placeholder labels ("Catch-up" / "Steady") ship in slice 2; swapping them
is a one-line util change. Flag for sign-off; do not stall the slice on it.

## Dependencies / notes

- **Prereq:** none. The per-zone mode is computed live from `device_states`, which is populated today.
- **Related:** proposal `f0f3dcb` (§3.1 why-not-configurable, §5 P1); #40 (soft-inactive signal,
  origin of the mode); #123 (mode stamped on the dispatch-run ledger — a different, run-scoped surface);
  #134 (activity-trend section sits adjacent on the same dashboards); #137 (deferred P2 postures — this
  legibility is that issue's stated prereq).
- **Surfacing rule (mandatory):** before building the FE, read the authoritative dashboard reference
  images `docs/ui/desktop/v2-reference/01-dashboard-zone-manager.png` and
  `04-dashboard-operations-head.png`; match the neighbouring section chrome (KPI hero / SLA
  Distribution / activity-trend blocks) — do not redesign.
- **Out of scope:** any control that *changes* the mode or its threshold (that is the decided-against
  config surface / deferred #137); persisting a new mode-history table (the signal is live, and
  `soft_inactive_count_history` already exists if a timeline is ever wanted); mobile (SE app is
  auth-shell only).
