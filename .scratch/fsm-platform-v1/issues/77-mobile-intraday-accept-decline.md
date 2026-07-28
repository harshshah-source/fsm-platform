# 77 — SE mobile intra-day CRITICAL insertion Accept/Decline + ghost-assignment toast

Status: ready-for-agent
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

- [ ] Full-screen / shade Accept/Decline prompt renders for a PENDING insertion offered to this SE
- [ ] Accept posts to `/api/intraday-insertions/:id/accept`; accepted ticket appears at top of Day Plan badged `CRITICAL INSERTION`
- [ ] Decline opens the mandatory reason picker and posts to `/api/intraday-insertions/:id/decline`
- [ ] Ghost-assignment toast shown once on reconnect when the offer was already rerouted (no action needed)

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
