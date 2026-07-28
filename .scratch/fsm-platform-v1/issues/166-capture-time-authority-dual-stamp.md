# 166 — Capture-time authority: dual-stamp capturedAt/receivedAt for SE writes

Status: ready-for-human
Type: HITL · Backend · Architecture

Filed 2026-07-28 (`docs/status/backend-mobile-readiness-plan-2026-07-28.md` §A-§7, §B N5, HITL D5).
The deepest architectural question in the mobile assessment. **The decision blocks the offline
cache design (#54/#17) and #82's envelope; the build can trail the first online-only screens.**

## The problem (verified at HEAD `0d3b85d`)

Every SE write is stamped with server arrival time (`troubleshoot-submission.service.ts:104,140`;
soft states, recovery, install, VU likewise). GPS verification anchors on that stamp: ping search
`gpsDatetime > submittedAt` (`verification.service.ts:203`), run `startedAt = submittedAt` (`:283`).
#148 (07-22) fixed only *expiry* (24 h AND `data_as_of` watermark advanced, `:174-186`) — it does
not touch capture time.

**Consequence, walked against current code:** SE fixes a device at 10:00 in a dead-signal zone,
uploads at 16:00. The 10:00–16:00 pings — the evidence of the repair — are excluded. If the vehicle
has since driven off (the common case), the first post-16:00 ping is >500 m from the anchor ⇒
`fraud: true` (`verification-criteria.ts:80`) ⇒ **immediate FAILED_VERIFICATION + fraudFlag**
(`verification.service.ts:221-224`), inventory rollback, and a genuine repair lands in the ZM fraud
queue. Offline-first (PRD §309-310, which names the Troubleshooting Form first) and GPS verification
are mutually incompatible as built. The SLA clock has the same exposure (late VU pauses from upload
time, `vehicle-unavailability.service.ts:64,94`).

The spec assumes capture ≈ submit (CONTEXT §9 times Phase 1 "after form submission") and **is silent
on which timestamp wins when they diverge** — hence HITL, not an agent-inventable answer. Related
spec-code divergence to resolve while here: CONTEXT §9's "or inside the Plant geofence" Phase-1
alternative is not implemented (`verification-criteria.ts:60-81` — anchor distance only); it would
partially soften the moved-vehicle fraud path.

## Options (analysis in the plan doc §A-§7 / D5)

- **(a) Server-time-only**: verification-bearing writes require connectivity; offline queue limited
  to vouchers/soft-states. Cheapest, but **amends the PRD's offline-first mandate** — operator call.
- **(b) Dual-stamp (recommended)**: additive `capturedAt` (client claim) beside `receivedAt`/server
  stamps (non-falsifiable ledger) on `troubleshooting_submissions`, `soft_states`,
  `vehicle_unavailability_reports`, `vouchers`; `NULL` ⇒ online ⇒ `capturedAt := receivedAt`.
  Verification anchors (`:203`, `:283`) and SLA pause move to `capturedAt`. Bounded backdating
  window **W** (reject `receivedAt − capturedAt > W` and `capturedAt > receivedAt` with a distinct
  error). Near-zero migration cost **today** (no SE submission rows exist); client-breaking later.
- **(c) Full event-sourced sync**: rejected — single-SE-per-ticket + the 409 path + per-device FIFO
  already bound concurrency; all cost, no consumer.

## Decisions required (operator)

1. Option (a) vs (b) — (b) unless the offline-first spec is explicitly amended.
2. **W** (recommendation: 24 h, aligned to the verification window).
3. Auto-recovery precedence: a server-observed recovery/sweep event during the offline gap beats a
   back-dated claim (recommended) — the anti-fraud rule for "watch it self-recover, then backdate".

## Acceptance criteria (for the build, once decided; assumes (b))

- [ ] The four tables carry `capturedAt`; online writes get `capturedAt = receivedAt`
- [ ] Verification run + ping window anchor on `capturedAt`; the 10:00/16:00 scenario verifies instead of fraud-flagging (e2e)
- [ ] Window expiry (24 h + #148 watermark) re-anchors on `capturedAt` (a 3-day-late upload with no pings fails promptly)
- [ ] SLA pause/resume for VU + WAITING_COMPONENT anchors on `capturedAt`; sweeps fired during the gap are accepted-not-retracted (documented)
- [ ] Backdating beyond W / future `capturedAt` rejected with a distinct error code (client marks FAILED per #17)
- [ ] #82's envelope updated (`capturedAt` per item + in-order application) — see #82 extension
- [ ] Audit/`ticket_events` keep server time; `capturedAt` recorded alongside (dual-stamp, ledger integrity)

## UI surfaces

n/a (mobile consumes via #17/#82; admin verification review may later surface both stamps — follow-up if so).

## Reference

n/a.

## Blocked by

- HITL decisions above (D5). Blocks: #82 build, #17, the offline layer of #54.

## Comments

### 2026-07-28 — mechanism corrected, and the premise was partly false (freeze plan §1.4)

Two corrections from independent re-verification. **Both make this issue more accurate, neither
weakens the case for it.**

1. **The fraud path needs ≥3 pings, not the first.** `verification-criteria.ts:67-73` early-returns
   `fraud: false` when fewer than `PHASE1_MIN_PINGS = 3` (`:12`) pings have arrived — a device
   reporting once from 50 km away is **not** fraud-flagged; it sits in `PARTIAL_RECOVERY` until the
   24 h window. Once ≥3 arrive, fraud fires immediately and independently of the evidence check
   (`:80` vs `evidenceOk` at `:78`), **before** `windowExpired` is computed
   (`verification.service.ts:222-226`). A moved vehicle produces ≥3 pings trivially, so the finding
   stands — but the issue body's "first ping" framing was wrong.
2. **The 500 m radius is a hard-coded module constant** (`FIRST_PING_RADIUS_M`,
   `verification-criteria.ts:11`). The `thresholds.radiusM` override is plumbed (`:40,:55`) but the
   only caller never passes it (`verification.service.ts:210-214`) — there is no setting, env, or DB
   source. "Configurable radius" is false today. Also note the whole check is bypassed when
   `presenceSource === 'NONE'` or no anchor exists (`:208-209`).

3. **The premise "no SE write accepts a client-supplied capture timestamp" is REFUTED.** Two
   SE-writable routes already take client timestamps:
   - `POST /api/vouchers` — `items[].expenseDatetime` (`vouchers.controller.ts:46`), converted
     **unvalidated** at `:83`, persisted verbatim (`vouchers.service.ts:194`), and **exported to the
     Finance CSV** (`:401`). An unvalidated client-controlled timestamp reaching a finance export is
     its own finding (D-14) and belongs in this issue's scope.
   - `POST /api/vehicle-unavailability` — `expectedFrom`/`expectedTo` (`:62-64`).

   The narrow claim — that nothing client-stamped feeds the GPS/verification anchor — **holds**. The
   blanket phrasing in all three source assessments does not, and the dual-stamp design must account
   for the client timestamps that already exist rather than pretending it is greenfield.
