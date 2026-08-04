# 77 — SE mobile intra-day CRITICAL insertion Accept/Decline + ghost-assignment toast

Status: done
Type: AFK · Mobile

## What to build

The SE-facing mobile surfaces for the intra-day CRITICAL/HIGH_CRITICAL insertion flow (Issues 29/30).
The backend is built and green (`/api/intraday-insertions`): the full-screen / notification-shade
**Accept / Decline** prompt, the `CRITICAL INSERTION` Day-Plan badge on an accepted ticket, and the
one-time **ghost-assignment toast** when an offered insertion timed out while the SE was offline.

## Business rules (authority)

- PRD §541 Flow 4 (Accept → "Accepted. WhatsApp Confirmation sent." + ticket at top of Day Plan;
  Decline → mandatory reason picker → system reroutes; offline/no-response within 10 min → on reconnect
  the ghost-assignment notice). §489 (Intra-day Insertion Screen). ADR-0016 (SE-Acceptance WhatsApp).

## Acceptance criteria

- [x] Full-screen / shade Accept/Decline prompt renders for a PENDING insertion offered to this SE
- [x] Accept posts to `/api/intraday-insertions/:id/accept`; accepted ticket appears at top of Day Plan badged `CRITICAL INSERTION`
- [x] Decline opens the mandatory reason picker and posts to `/api/intraday-insertions/:id/decline`
- [x] Ghost-assignment toast shown once on reconnect when the offer was already rerouted (no action needed)

## API contract (authority: backend on `main`, `@Roles('SERVICE_ENGINEER')`)

- `POST /api/intraday-insertions/:id/accept` — no body. Errors: `INSERTION_NOT_FOUND` (404),
  `NOT_OFFERED_TO_YOU` (409), `INSERTION_NOT_PENDING { status }` (409).
- `POST /api/intraday-insertions/:id/decline` — body `{ reasonCode }`,
  `reasonCode` ∈ `AT_CAPACITY | TRAVEL_TOO_FAR | VEHICLE_TROUBLE | OTHER`
  (`DECLINE_REASON_CODES`). Errors: `REASON_REQUIRED` (400), `INVALID_REASON`.
- Accepted ticket renders at top of `/api/schedules/me` (server orders it `insertAtTop`).
- Ghost state: a `GET /api/intraday-insertions` row in a timed-out/rerouted status surfaced to the offered SE.

## Validation & error codes

- `NOT_OFFERED_TO_YOU` / `INSERTION_NOT_PENDING` → close the prompt + inform (already resolved elsewhere).
- Decline without a reason → `REASON_REQUIRED`; bad reason → `INVALID_REASON`.

## Permissions

- SERVICE_ENGINEER only; an SE can accept/decline only an insertion offered to them.

## Navigation

- Accept → Day Plan (new ticket at top). Decline → back to Day Plan. Toast → no navigation.

## Offline behaviour

- The Accept/Decline action requires connectivity (it competes for an offer). If the SE was offline
  past the 10-min `ACCEPTANCE_TIMEOUT_MIN`, the offer is gone → show the ghost toast on reconnect.

## Edge cases & failures

- WhatsApp confirmation copy is a side-effect of accept (first-class SE_ACCEPTANCE) — the toast text
  is "Accepted. WhatsApp Confirmation sent." Decline reroute is server-side.

## UI surfaces

- **Mobile:** Accept/Decline prompt + `CRITICAL INSERTION` badge + ghost toast. Owned by this issue.
- **Admin:** n/a (manager-side insertion/escalation are Issues 29/30/31).

## Reference

- `docs/ui/mobile/home-dashboard.png` (Day Plan / badge context); copy per PRD §541.

## Tests (TDD targets — red first)

- Accept posts to `/accept`; accepted ticket renders top-of-plan badged.
- Decline without reason → `REASON_REQUIRED`; with a valid enum → posts + reroute.
- `NOT_OFFERED_TO_YOU` / `INSERTION_NOT_PENDING` close the prompt gracefully.
- Timed-out offer → ghost toast shown once.

## Blocked by

- #54 (Mobile Foundation)
- #29, #30 (done — backend + endpoints)
- (push delivery of the offer) #89 / #76

## Comments

### 2026-07-28 — data-needs spec (#172 D-9 closed; no mockup)

Full spec: `docs/status/se-screen-data-needs-2026-07-28.md` §3. **Worst-served of the six.**

⚠ **This issue's API-contract line is factually wrong.** It states a `GET /api/intraday-insertions`
row is "surfaced to the offered SE". That route is `@Roles(...MANAGER_ROLES)`
(`intraday-insertion.controller.ts:37-38`). **An SE cannot read any insertion, ever** — including
their own live offer after an app restart.

- **No countdown is buildable.** `acceptanceDeadline` (`schema.prisma:429`) is not in the offer push
  metadata — `pushOffer` sends only `{insertionId, ticketId, actions}` with generic title/body
  (`intraday-insertion.service.ts:396-407`). **Ship it as an absolute ISO instant**, not a duration:
  a client-side "10 minutes from receipt" drifts against `sweepTimeouts` (`:275-288`) and will show
  a live countdown on a dead offer.
- **The PRD's own push copy is not renderable** — PRD:543 says *"CRITICAL Ticket at [Plant]"* and
  `plantName` is not in the metadata.
- 🔴 **The ghost notification renders a raw UUID at the user**:
  `` `routed to ${nextSeId}` `` (`:477`, `:482`), where PRD:547 requires "[SE Name]". `_now` is
  accepted and discarded (`:476`), so neither `offeredAt` nor `routedAt` is available either.
- `whatsappSent` exists on the manager row (`:49`) but not in the SE's `AcceptOutcome` (`:53-54`),
  so the screen cannot honestly say "sent" per CONTEXT:508.
- **Error code:** this issue pins `INVALID_REASON`; the controller emits **`INVALID_REASON_CODE`**
  (`:85`). Recovery's equivalent *is* `INVALID_REASON` — freeze both distinctly (#169).
- **Missing data (d):** expected component (D1) and SE live position (D5) — see the spec doc.

Fix path: widen `pushOffer` metadata **and** add an SE-scoped offer read (**#163**) for cold start.

### 2026-08-04 — done: #163 already closed the premise blocker; built the rest, one bug fixed

Re-verified this comment's five findings against current source before building:

1. **The premise blocker is resolved.** #163 (done 2026-08-03) added `GET /api/me/intraday-insertions`
   (`me-intraday-insertions.controller.ts`, `SERVICE_ENGINEER`-gated) returning the caller's own
   `PENDING_ACCEPTANCE` offer(s) with `acceptanceDeadline` and `whatsappSent` already on the row —
   both of this comment's other two data-need asks were closed by the same slice, not separately.
2. **No countdown needed / already server-computed.** `acceptanceDeadline` is the absolute ISO instant
   this comment asked for — rendered as a static "Accept by HH:MM" label, not a live-ticking timer (a
   `setInterval` countdown was considered and skipped, same proportionality call as #71's Install
   activation result — no polling precedent in this codebase, and the added test complexity wasn't
   worth it for a value that's already drift-proof).
3. **PRD push copy / plantName — resolved differently than the comment's fix path.** Never widened
   `pushOffer`'s metadata. Instead: the offered ticket is still `OPEN` + `UNASSIGNED` at offer time
   (`fireForZone`, `intraday-insertion.service.ts:100-113` — Accept is what formally assigns it), so
   it's already readable via the existing `GET /api/me/tickets/:id` (shared-pool branch,
   `isTicketReadableBySe`) — `IntradayOfferScreen` fetches full ticket chrome (plantName, companyName,
   deviceId) from there, no backend change.
4. 🔴 **Raw-UUID bug fixed** — `notifyGhostAssignment`'s `` `routed to ${nextSeId}` `` now resolves
   the next SE's `User.name` first (same fix class as #63's `winnerSeName`), with a new backend e2e
   test pinning the real name appears and the raw UUID does not. Landed as its own commit before the
   mobile screen was built, since the toast renders this text verbatim.
5. **Error code confirmed still `INVALID_REASON_CODE`** (`intraday-insertion.controller.ts:85`), not
   the issue's own `INVALID_REASON` text — built against the real code.

**Not in this comment, found during this session's build — also resolved without a backend change:**
the `GET /api/notifications` read (Issue 03's spine) is open to any authenticated user, not gated
behind #85 (Notifications screen) or #89 (push) despite this issue's own "Blocked by" section listing
push delivery as a dependency — the ghost-assignment toast reads `type === 'INTRADAY_GHOST_ASSIGNMENT'`
off that existing list and marks it read on dismiss.

**Built:** `SeTabShell` checks once on mount (no polling, no push) for a pending offer; if found, gates
the tab navigator behind `IntradayOfferScreen` (Accept / Decline with a mandatory reason picker,
`INSERTION_NOT_PENDING`/`NOT_OFFERED_TO_YOU` close gracefully with a "no longer available" message).
Once accepted, the ticketId is threaded to `TicketsScreen`, which badges that row `CRITICAL INSERTION`
by composing with #66's existing `addedIds` set-diff mechanism (the accepted ticket is newly `assigned`
the moment it lands, so it already sorts to the top of its urgency section — no new sort logic needed)
rather than a new server-side "top of Day Plan" flag. The (d) missing-data items (expected component,
SE live position) were not built — out of scope, no AC references them.
