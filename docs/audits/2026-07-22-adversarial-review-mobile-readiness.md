# Adversarial Review — Backend + Web-App Mobile Readiness Assessment

**Date:** 2026-07-22 · **Branch:** `feat/autoplant-integration` · **Reviewer role:** hostile senior reviewer
**Protocol:** `docs/audits/adversarial-review-prompt-v3.md`
**Target under review:** `docs/status/backend-mobile-readiness-2026-07-22.md` (committed in `0183c94`)
**Type:** READ-ONLY audit of a READ-ONLY assessment. No code changed, no issues filed.

**Method:** every sampled code cite opened on disk; every DB measurement re-derived with a rebuilt
read-only probe against `localhost:5433`; the one unmeasured quantitative claim benchmarked directly.

**Verdict vocabulary** (from the protocol): `fail` · `needs-changes` · `advisory` · `not-checked`.

---

## PHASE 1 — RE-DERIVE THE GOAL

**Objective**, restated from the target document's own scope statement: answer what the backend and
admin web app would need to become before a 1,000-concurrent-device SE mobile client could connect —
without building anything.

**Acceptance criteria.** None were written down. Proposing them is itself finding territory, but the
document's structure implies five:

1. Every claim traceable to code or a measurement — no assertion from memory.
2. The SE-facing surface enumerated completely, not sampled.
3. Blockers ranked by a defensible axis, distinguishing "hard blocker" from "cheap now, expensive later."
4. Known findings cited by ID, not re-derived (the document states this explicitly in its header).
5. Measurements reproducible.

**Grounding.** All five are **grounded** — they are the document's own stated contract. The protocol's
security-baseline exception applies to §8 (authorization) and §2 (auth), which block regardless of
whether anyone asked for them.

### Settled-decisions record — NOT re-flagged

Per protocol rule 3b, none of the following is raised as a gap:

- **"No code changed, no issues filed, no design proposed"** — declared in the document header and
  restated in the `INDEX.md` session-log entry. Deliberate.
- **Nest default logger retained over pino** (#98, documented decision) — §9 correctly cites it as settled.
- **`lastActivityAt` excluded from scoring** (ADR-0023/24) — §9 flags it correctly.
- **Day plans apply immediately, no SE acceptance** (SYSTEM-STATE §3h) — §1.3 already marks this
  "by design" and asks for confirmation rather than calling it a gap. Correct handling.
- **External adapters deferred to a seam** (#76) — CLAUDE.md's "build the seam" policy explicitly
  covers FCM/APNs.

---

## PHASE 2 — ATTACK THE METHOD

**Ordering (rule 5).** Sound. §10's ranking axis — blast radius × likelihood × retrofit cost — is
stated up front and applied consistently. Items 1, 2 and 7 are correctly ranked as client-contract
decisions that are cheap now and migration-shaped later; item 10 is honestly self-demoted for being
the one thing genuinely easier to add later.

**Under-specification (rule 7).** The #1 blocker — "SE-readable ticket endpoints" — is the one item
where "done" can be faked, because no payload shape is proposed. The document argues the payload
shape *is* the decision ("determines the client's entire data model, its offline cache schema, and
its sync granularity") and then declines to propose one. The tension is real, but "no design
proposed" is a declared descope, so this goes to the questions list, not the findings table.

**Over-engineering (rule 6).** None. No speculative abstraction; the document consistently declines
to propose solutions.

**Risk ranking (rule 8) — top 3 threats to the assessment's usefulness:**

1. Measurements not reproducible (the probe was deleted).
2. Five of ten ranked blockers carry no issue ID, so nothing routes them into build order.
3. The single security finding understates its own reach.

---

## PHASE 3 — THE FOUR GATES

### Gate 1 — PROOF OF LIFE — `needs-changes`

The document closes with *"the probe script was deleted."* Every number in §4, §5.1, §5.2, §5.5 and
§8 was therefore unverifiable against a live, mutating dev DB. The probe was rebuilt for this audit
(`SELECT`/`SHOW` only) and all seven measurements re-run.

**Six of seven reproduce exactly:**

| Claim | Document | Re-measured | |
|---|---|---|---|
| shared-pool worst / avg / total / covered SEs | 1,030 / 202 / 9,100 / 67 | **1,030 / 202 / 9,100 / 67** | ✓ |
| day plan worst / avg per SE | 25 / 21 | **25 / 21** (52 SEs, 1,114 total) | ✓ |
| `statement_timeout` · `idle_in_transaction_session_timeout` | 0 · 0 | **0 · 0** | ✓ |
| `max_connections` | 100 | **100** | ✓ |
| dispatch run 4 | 52 schedules / 80 batches / 1,114 tickets | **52 / 80 / 1,114** | ✓ |
| `tickets.vehicle_id` unindexed | unindexed | **confirmed** — 11 indexes, none on `vehicle_id` | ✓ |
| open troubleshoot tickets fleet-wide (§8) | 9,280 | **13,332** — see F1 | ✗ |

Supporting confirmations: `daily_capacity` is uniformly 25 across all 75 active engineers, so §4's
"bounded by `daily_capacity`" is exactly right (worst observed = 25 = the cap); `engineer_master`
holds 75 rows, matching §2.1.

That single miss is precisely the failure mode a retained probe prevents: nobody could have caught
it without re-deriving the query from scratch.

**Cite honesty.** Sampled 24 of roughly 60 file:line cites, all opened on disk. Precision is
unusually high. Exact hits include:

- `common/guards/zone-scope.guard.ts:27-29` — quoted verbatim in §8, correct.
- `ticketing/tickets.controller.ts:38-39`, `:70-71`, `:83-84` — all three exact.
- `common/filters/all-exceptions.filter.ts:37,40,47,62,63,70,74` — every one exact.
- `intraday/intraday-insertion.service.ts:139-148`, `:150`, `:156-160` — exact.
- `ticketing/troubleshoot-submission.service.ts:107`, `:112-116`, `:140`, `:315-320` — exact.
- `verification/verification.service.ts:159` — exact.
- `auth/user-store.ts:78` (`scryptSync`), `auth/refresh-token-store.ts:20,35` — exact.
- `prisma/prisma.service.ts:28-37` — exact; `PrismaPg` is constructed with only `connectionString`
  and `options: '-c timezone=UTC'`, so node-postgres defaults (`max: 10`,
  `connectionTimeoutMillis: 0`) do apply as claimed.

**Zero fabricated cites found.**

**Stub hunt.** §6's claim that `NotificationChannelGateway` is "a seam with no adapter behind it" is
confirmed — `LoggingChannelGateway.deliver()` logs and returns `'UNAVAILABLE'`. This is a *declared*
seam under CLAUDE.md policy, not a fake. Separately, `zones/zones.controller.ts:9-12` returns a
hardcoded `{ zoneId: Number(zoneId) }` under a "Placeholder body" comment — a genuine stub,
SE-reachable, unmentioned by the document (see F4).

**Independent security-baseline checks** (grounded by default, so verified rather than assumed):

- Zero `device_token` / `push_token` / `fcm` / `apns` hits in `prisma/schema.prisma` — §2.4 exact.
- Zero throttler, guard or middleware implementing rate limiting anywhere in `apps/backend/src` — §2.3 exact.
- No WebSocket / SSE / `socket.io` / `EventSource` construct anywhere in the backend — §6 exact.
- Exactly 10 `@Cron` sweeps in `scheduling/business-sweep-scheduler.service.ts`
  (`:143,148,153,158,163,168,173,178,183,188`) — §5.5's "10 sweeps" exact.

### Gate 2 — REACHABILITY — `needs-changes`

The document **is** linked: `.scratch/fsm-platform-v1/INDEX.md:142` carries a detailed session-log
entry, satisfying CLAUDE.md's tracker convention.

But the findings themselves are unreachable *as work*. Of §10's ten ranked blockers, five carry an
issue ID (#91, #106, #110, #76, and #101 partially); **five do not** — items 1 (SE ticket reads, the
#1 blocker), 5 (pagination), 7 (capture timestamps), 9 (the authorization gap) and 10 (observability).

Two of those five are not recommendations at all but **newly discovered defects**:

- §3.3(2) — the Shadow-Use retry path re-decrements van stock on every retry.
- §8 — no ownership check on `POST /tickets/:id/troubleshoot`.

The document's header states that known findings are "cited by ID, not re-derived", which correctly
implies everything uncited is new. Two live defects therefore exist only as prose inside a status
document.

The "nothing filed" descope is settled and is not re-litigated here for the *recommendations*. But a
descope covering "we will not propose designs" reads differently from one that also swallows a
data-corruption bug and an authorization gap.

### Gate 3 — USER JOURNEY UAT — MET, with one GAP

Judged as the mobile lead who has to act on this document:

- **"What can't my app do today?"** — **MET.** §1.1/§1.2 are complete and correctly split. The
  install-vs-troubleshoot asymmetry is real and verified: `INSTALL_READER_ROLES`
  (`ticketing/install.controller.ts:40-46`) does include `SERVICE_ENGINEER` and is applied at
  `:216`; `tickets.controller.ts` never does. `vouchers.controller.ts:26` (`REVIEW_ROLES` = ZM/CSM/OH,
  applied at `:100`) and `engineers/leave-request.controller.ts:66` (`MANAGER_ROLES`) confirm the
  "create but never read" one-way streets.
- **"What breaks at 1,000 devices?"** — **MET.** The causal chain in §2.1 → §2.3 (restart wipes
  sessions → login burst → synchronous KDF → total stall) is the strongest analysis in the document.
- **"Can I build offline?"** — **MET, and genuinely sharp.** §7's claim that offline submission and
  GPS verification are mutually incompatible is confirmed: writes are server-stamped
  (`troubleshoot-submission.service.ts:140`, and no controller passes `input.now` —
  `troubleshoot.controller.ts:80-96`), while Phase 1 searches
  `gpsDatetime: { gt: submission.submittedAt }` (`verification.service.ts:159`) inside a 24-hour
  window. A 10:00 repair uploaded at 16:00 excludes its own proof. This is the finding most likely
  to have been missed by a less careful review.
- **Negative case — "what do I do Monday?"** — **GAP.** Five of ten blockers have no owner, and the
  top-ranked one has no proposed payload shape. The assessment states what is wrong and stops
  precisely where action would begin. Partly a consequence of the declared descope; see Q1/Q2.

### Gate 4 — COVERAGE & COHERENCE — `needs-changes`

All eight scope areas are covered. Security basics verified independently (see Gate 1). Redundancy
check performed before every "missing X" claim below: searched by domain concept across
`apps/backend/src` for rate limiting, device/push identity, realtime seams and pagination helpers —
no alternate-named implementation exists for any of them, so the document's absence claims stand.

---

## PHASE 4 — FINDINGS

### SPEC findings — accuracy against the document's own contract

| # | Verdict | Finding | Evidence | Fix |
|---|---|---|---|---|
| **F1** | `needs-changes` | **§8 understates its own security finding by 30% and misses the worse sub-case.** The document says any SE can submit against "any OPEN troubleshoot ticket in the entire fleet — **9,280** of them today." 9,280 is `OPEN ∧ TROUBLESHOOT ∧ **UNASSIGNED**`. But `submit()` checks only `workType` and `status === 'OPEN'` (`troubleshoot-submission.service.ts:112-116`) — there is no assignment filter. | Probe: `open_ts = 13332`, `open_ts_unassigned = 9280`, `open_ts_assigned = 4052`. The exact match on the unassigned figure proves the wrong query was used rather than DB drift — only 262 troubleshoot tickets were created today. | Restate as **13,332**. Add the missed case explicitly: 4,052 of those are *assigned to another SE*, so the exploit does not merely close a stranger's ticket — it steals a colleague's assigned work and misattributes the root-cause analytics. |
| **F2** | `needs-changes` | **§2.1(1)'s headline number is unmeasured and overstated.** Claims scrypt cost "~50–100 ms" ⇒ "roughly 10–20/sec process-wide". Presented as fact in a document whose credibility rests on labelling its measurements. | Benchmarked with the code's exact parameters (`scryptSync(password, salt, 64)`, `auth/user-store.ts:78`), 30 iterations after warm-up: **mean 38.7 ms ⇒ ~26 logins/sec** single-threaded. | Cite the measured figure. The conclusion survives and remains alarming — a 1,000-device burst is **~38 s of cumulative event-loop stall** — so state that instead of an unsourced range. |
| **F3** | `needs-changes` | **Measurements are not reproducible: "the probe script was deleted."** Against a live, mutating dev DB this makes §4 / §5.1 / §5.2 / §5.5 / §8 unfalsifiable after the fact. F1 is the demonstrated cost. | Document footer, lines 529–531. The probe had to be rebuilt from scratch to verify anything at all. | Commit the probe (read-only, `SELECT`/`SHOW`) beside the document, or inline each SQL statement next to the number it produces. |
| **F4** | `advisory` | **§1's opening count "15 of 52 controllers" is a grep artifact, in both directions.** It counts `roles/role-backup.controller.ts`, where `SERVICE_ENGINEER` appears only inside a validation array at `:20` — both routes are `@Roles('OPERATIONS_HEAD','CENTRAL_SERVICE_MANAGER')`. It excludes five controllers with **no `@Roles` at all** — `me`, `notifications`, `health`, `org/geography`, `zones` — which `RoleGuard` passes unconditionally ("A route with no `@Roles` is unrestricted by role", `common/guards/role.guard.ts:13-14,25-27`). | `grep -l SERVICE_ENGINEER --include=*.controller.ts` → 15 files; ungated controllers enumerated separately. | True SE-reachable count is **19 of 52**. The §1.1 table is correct — only the headline sentence is wrong. Worth fixing because it is the document's opening quantitative claim. |
| **F5** | `advisory` | **§4's payload estimate understates by 24%.** "At ~150 B/ticket that is ~155 KB for the worst SE." | Reproduced `SharedPoolService.getSharedPool()`'s exact projection for the worst-case SE and serialized it: **1,030 tickets = 196,882 bytes = 192.3 KB, 191 B/ticket**. | Replace the estimate with the measured 192 KB — it strengthens the argument the document is already making. |
| **F6** | `advisory` | **§5.3's `Ticket` index enumeration is incomplete.** Lists 5 declared indexes; the DB has 11. Omits `tickets_assigned_se_id_idx`, `tickets_activated_at_idx`, `tickets_install_batch_id_idx`, and the partial `tickets_shared_pool_idx ON (plant_id) WHERE status='OPEN' AND assignment_state='UNASSIGNED'`. | `pg_indexes` on `tickets`, 11 rows. | The conclusion (`vehicle_id` unindexed) is **correct and unaffected**. But the omitted partial index is materially relevant to §4/§5.3: the unbounded shared-pool query *is* well-indexed on its filter, which sharpens the document's own point that the problem is result-set size, not access path. |

### STANDARDS findings — repo conventions

Reported separately per protocol rule 17b. Per rule (a) the repo overrides generic best practice;
per rule (b) these are heuristic judgement calls and **never block**.

| # | Verdict | Finding | Evidence |
|---|---|---|---|
| **S1** | `advisory` | **Unlabelled IST timestamp in a UTC-normalized platform.** §5.5 cites "run 4 (2026-07-22 09:31)"; the row is `started_at = 2026-07-22T04:01:48.473Z`. 09:31 is IST. ADR-0025 and `prisma/prisma.service.ts:30-36` exist specifically to stop IST leaking back into rendered timestamps. | `dispatch_runs` row 4. |
| **S2** | `advisory` | **Minor cite drift (5 instances), none affecting a conclusion.** `notification-channel.gateway.ts:18` → the interface is at `:24`, the symbol at `:28` (`:18` falls mid-comment); `user-store.ts:44-48` → `se.north` is `:45-49`; `batch-assignment.service.ts:223-225` → the notify loop is `:222-224`; `shared-pool.service.ts:31-38` → the `findMany` starts at `:30`; `auth.controller.ts:11-22` implies a per-route `@Public()`, but it is class-level at `:12` (same effect). | Files opened on disk. |
| **S3** | `advisory` | **`docs/status/` is a new top-level doc category holding exactly one file.** CLAUDE.md names `docs/progress/`, `docs/archive/`, `docs/audits/` and `.scratch/`. This is *not* a "forked status doc" violation — it is a dated assessment, not a current-state claim — but the directory name invites one. | `ls docs/status/` → 1 file. |

### Not-checked — no inference drawn in either direction

- Roughly 36 of ~60 file:line cites in §1.1 and §3.2. Sampled 24; all correct. Nothing is
  extrapolated from that sample.
- The backend test suite was **not executed**. No finding in this review depends on it.
- §2.1(3)'s refresh-token growth *rate* ("~32,000 entries/day"). The no-eviction mechanism is
  confirmed (`refresh-token-store.ts:30-37` sets `revoked = true` and never deletes; no sweeper
  exists anywhere), but the arithmetic assumes a shift pattern that was not validated.
- The 38.7 ms scrypt benchmark reflects this dev machine only; production hardware will differ.

---

## HONEST % COMPLETE

**~90% against its own acceptance criteria.**

Criteria 1–4 are met at a standard well above what documents of this kind usually reach: cite
precision is near-perfect across a 24-cite sample, the causal analysis in §2 and §7 is original and
correct, and §5.4's positive finding — zero SE-facing advisory-lock contention, all
`pg_try_advisory_xact_lock` — is the kind of result reviews omit precisely because it is not a
problem. Criterion 5 (reproducibility) fails outright, and that failure cost one factual error (F1).

---

## ORDERED NEXT STEPS

Blockers first. Each carries the VERIFY signal that proves it done.

1. **Correct §8 to 13,332 and add the assigned-ticket case.**
   *Why now:* it is the document's only security finding, and the current text under-describes what
   an attacker actually reaches.
   **Verify:** the number in §8 equals `SELECT count(*) FROM tickets WHERE status='OPEN' AND
   work_type='TROUBLESHOOT'`, and the prose names the assigned sub-case.

2. **File the two newly discovered defects as issues** — §3.3(2) Shadow-Use retry re-decrement, and
   §8 missing ownership check on `POST /tickets/:id/troubleshoot`.
   *Why now:* they are bugs, not recommendations, and currently exist only as prose.
   **Verify:** two new issue files under `.scratch/fsm-platform-v1/issues/`, both linked from
   `INDEX.md`, both carrying a `Status:` line. *(Depends on Q1.)*

3. **Commit the probe script.**
   *Why now:* it is what makes every other number in the document falsifiable.
   **Verify:** one `node <probe>` run re-derives every number in §4 / §5.1 / §5.2 / §5.5 / §8.

4. **Replace F2 and F5's estimates with measured values** (38.7 ms · ~26 logins/sec · ~38 s burst
   stall; 192.3 KB).
   **Verify:** every number in the document traces to a probe query or a named benchmark.

5. **Fix F4's controller count to 19 of 52, and F6's index list.**
   **Verify:** the count matches `@Roles`-bearing SE controllers plus the five ungated ones.

---

## KILL LIST

- **The practice of deleting probe scripts after measuring.** It is what made F1 undetectable.
- **`zones/zones.controller.ts`** — an SE-reachable placeholder returning `{ zoneId: Number(zoneId) }`
  with no service behind it. Delete it or gate it; an ungated stub route is still a route.
- **The unsourced "~50–100 ms" and "~150 B/ticket" figures.** Measured or absent, not estimated.

---

## OPEN QUESTIONS

Inferred requirements, per protocol rule 3. Each carries a recommended answer. **None of these block
on their own** — they are for the human to decide.

1. **Does "nothing filed" extend to newly discovered defects, or only to recommendations?**
   The descope is settled and is not re-litigated here. But §3.3(2) and §8 are live bugs, not
   proposals.
   **Recommend:** file those two; leave the other eight ranked items as assessment until the HITL
   decisions land.

2. **Should §10 item 1 carry a proposed payload shape?**
   The document argues the shape *is* the decision, then declines to propose one under "no design
   proposed."
   **Recommend:** yes — a strawman SE projection for `GET /api/tickets/:id`, explicitly marked as a
   starting point, since the document's own argument is that this blocks mobile design from starting.

3. **Is `org/geo/*` intentionally open to SEs?**
   `org/geography.controller.ts:8-9` documents it as deliberate reference data. §4's "no admin-scale
   data is SE-callable" holds for the operational reads it names, but does not mention this.
   **Recommend:** confirm intentional, add one line to §4.

4. **Is the fix for §8 coverage-scoped or assignment-scoped?**
   The document's HITL question 7 already raises this. Worth noting that coverage-scoping alone
   still permits submitting against a colleague's assigned ticket inside the same coverage area.
   **Recommend:** assignment-scoped for assigned tickets, coverage-scoped for pool tickets.

---

## VERDICT

**On-track.**

This is a strong, unusually well-evidenced assessment — six of seven measurements reproduced exactly,
roughly 24 code cites verified with zero fabrications, and §7's offline-vs-verification
incompatibility is a genuine catch that a less careful review would have missed.

**Single highest-leverage next action:** correct §8 to 13,332 and file its two new defects as issues
— the document's one security finding currently understates its reach, and the two bugs it
discovered exist nowhere in the backlog.

---

*Read-only audit. No code changed, no issue files created, no design proposed. Measurements taken
with `SELECT`/`SHOW`-only queries against the dev database on 2026-07-22; the probe script is
retained in the session scratchpad and should be committed per F3.*
