# 337 — Push delivery exit behind the existing gateway seam (FCM)

**Done 2026-09-03.** Wave 1 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids NOTIF-01, INTRA-G1, INV-G7 and
the SCH-01 residual, and closing the backend half of **#89** and the adapter half of **#76**.
Red-first. Depends on #336 (landed) and, externally, on FCM project credentials — operator
provisioning, and deliberately not a blocker (CLAUDE.md "build the seam").

## What it closes

`LoggingChannelGateway.deliver` returned `'UNAVAILABLE'` unconditionally and was the only
implementation bound to `NOTIFICATION_CHANNEL_GATEWAY`. Everything upstream of it already worked: the
outbox is durable and enqueued inside the producing transaction (#338), the in-app row always fires,
and `device_tokens` has held one registration per user since #76.

So the platform had a complete notification spine with no exit. **Nothing had ever left the server.**
Five modules bottom out here — scheduling, intraday, cross-zone, inventory and tickets all write
notices — which means every "the SE is notified" claim in the product was false at the last inch, and
false in the one place nobody looks: the log line said the notice was handled, the delivery row said
ATTEMPTED, and the engineer's phone said nothing.

The premise held exactly as the issue file states it. Every cited `file:line` was still accurate on
2026-09-03: `notification-channel.gateway.ts:35-40`, `notifications.module.ts:18`, `schema.prisma:225`,
`notification.service.ts:168-175`, `notification-seam.ts:47-60`. Nothing in the finding needed
correcting.

## The shape of the fix

- **`notifications/fcm-channel.gateway.ts` (new)** — an FCM HTTP v1 adapter with service-account
  auth, behind an injected `FcmHttpClient` port. `PUSH_PROVIDER` / `FCM_*` resolution and the
  `createChannelGateway` factory live here too, so "what is bound, and why" is one testable function
  rather than a `useFactory` body nobody can call.
- **`notification-channel.gateway.ts`** — `deliver` may now return a `ChannelDeliveryDetail`
  (`status` + `providerMessageId` + `error` + `retryable`) as well as the bare status it always
  could; `ChannelSendInput` grew `entityType` / `entityId`; the port grew a `sendsExternally`
  self-declaration (below).
- **`notifications.module.ts`** — env-switched provider, default `logging`.
- **`device-token.service.ts`** — `findForUser` and `deleteStale(userId, token)`.
- **`notification.service.ts`** — records the per-channel detail onto `notification_deliveries` and
  hands the same shape back to the producer.
- **`notification-seam.ts`** — the #218c assertion is re-pointed (below).
- **schema + hand-written migration** — `notification_deliveries.provider_message_id` and `.error`.
- **`.env.example`** — `PUSH_PROVIDER` and the service account, documented as an off-by-default
  switch.

## Decisions worth keeping

**The mapping is the slice.** 200 → SENT with FCM's `name` as the provider message id. 404/410 →
FAILED **and the token row is reaped**. 5xx/429/transport error → FAILED, marked retryable, token
untouched. Any other 4xx → FAILED, not retryable. The 404/410 branch is the one that costs something
if it is wrong: those are FCM's two ways of saying the registration is gone (uninstalled, rotated,
project moved), and a dead token nobody reaps is not a one-off failure — it is every future push to
that engineer failing identically, forever, while `device_tokens` goes on asserting they are
reachable. The mirror-image mistake is reaping on a 5xx, which would take a perfectly reachable
engineer offline for a reason that had nothing to do with them.

**The reap matches on (user, token), not on user.** A handset that re-registered while the failing
send was in flight has already replaced the row, and deleting by user alone would silence somebody who
is reachable right now. `deleteStale` returns whether it removed anything so the log can say which of
the two happened. There is a test for the race.

**Nothing throws out of `deliver`.** A push that cannot be delivered must never damage the outcome it
announces — #264's guarantee, and the thing #338 built the entire outbox around. Every failure is a
recorded result travelling back as data.

**"Retry left to the outbox" means the adapter does not invent a retry of its own.** `retryable` is
advisory and `NotificationService` deliberately does not act on it. The reason is worth writing down
because it is the one place the slice does *less* than the AC's wording might suggest: the outbox
retries a row when its **delivery throws**, and `notify()` creates the in-app notification row before
it ever reaches the gateway. Making a 5xx propagate would therefore re-create the in-app row on each
of the outbox's five attempts — five lock-screen entries for one event. The adapter has no way to make
that safe from where it sits (retry plumbing lives in `day-plan-notification-outbox.ts`, which this
slice does not own), so it records the failure truthfully, marks it retryable for whoever adds
push-level redelivery, and leaves the existing at-least-once semantics exactly as it found them. The
follow-up is filed below.

**A FAILED channel is recorded FAILED, not ATTEMPTED.** While every external channel was inert,
ATTEMPTED covered the only thing that ever happened ("there was no adapter"). With a real provider on
the other end, "we tried and FCM refused" is a different fact with a different owner, and
`notification_deliveries` exists so somebody can afterwards ask "was this person actually told?" and
get a truthful answer. The chain still walks on: a failed push is exactly the case the SMS rung below
it exists for.

**A user with no token is UNAVAILABLE, not FAILED.** Nothing was attempted and nothing is wrong. The
chain continues exactly as it did before there was an adapter at all — with a one-line `error` saying
why, so the row is not merely silent.

**The seam assertion's invariant changed, and that was the point.** #218c pinned "the binding must be
`LoggingChannelGateway`". That was right while no other implementation existed and is wrong now: it
would fail the catch-up window for the mere *existence* of an adapter class nobody switched on, and —
the worse direction — it would keep passing for any real provider that subclassed or impersonated the
inert one. The property actually worth defending is **no real provider unless somebody explicitly
configured one**, and it is now checked in three layers, in order:

1. **configuration** — `PUSH_PROVIDER` names a real provider → breach, before anything is constructed
   or called;
2. **self-declaration** — the bound gateway does not declare `sendsExternally === false` → breach,
   **without probing**;
3. **behaviour** — only a gateway that declared itself inert is called, and then on every external
   channel.

The original ordering property survives intact: probing an unknown adapter to discover whether it
sends is itself the send the gate exists to prevent. What replaces the `instanceof` check is a
declaration on the port — and **undeclared means "assume it sends"**, because an adapter that never
considered the question is not making a claim of inertness by staying quiet.

**A misconfiguration aborts the boot; it never degrades to inert.** An unrecognised `PUSH_PROVIDER`
value throws, and `PUSH_PROVIDER=fcm` with a credential missing throws naming the missing key. A quiet
fallback to logging would rebuild this slice's own defect one layer up: an operator holding a config
file that says push is live, and a field full of engineers who are never told anything. Same posture as
#98's JWT secret.

## What was tested, and why in that shape

The adapter is exercised end to end against an **injected HTTP stub**, which is what lets the part
that actually decides whether an engineer is reachable tomorrow be pinned today, before any credential
exists. The stub records every request, so the wire payload itself is asserted — endpoint, bearer
header, `{title, body, data:{type, entityId}}`, and that every `data` value is a string (FCM v1 400s
the whole send on a non-string one, which is the sort of thing that is only ever discovered in
production).

The stale-token paths are asserted against the **real `device_tokens` table**, not a mock: the
assertion that matters is that the row is gone afterwards on 404/410 and still there on 503, and a
mocked repository would have proved only that the adapter called a method.

`notify()` is tested through the real `NotificationService` against the real
`notification_deliveries`, so AC4 is asserted where an operator would read it rather than on a return
value.

The AppModule binding is resolved through the **real graph** in two specs — the default is
`LoggingChannelGateway`, and the seam assertion passes against what is actually bound — which is what
makes AC2 a claim about the deployment rather than about a factory function.

`test/setup-env.ts` gained `PUSH_PROVIDER` and the `FCM_` prefix (see below): without that, a
developer who armed the real adapter in their own `.env` would arm it inside the suite, and the
seam-assertion e2e would fail on their box for a reason that had nothing to do with their change.
That is the #182 hazard exactly.

## Acceptance criteria

- **AC1** ✅ — the adapter sends `{title, body, data:{type, entityId}}`; 200 → SENT (+ provider
  message id), 404/410 → FAILED + stale token row deleted, 5xx → FAILED with no adapter-level retry.
- **AC2** ✅ — default binding unchanged (`logging`). `notification-service`, `day-plan-notifier-spine`,
  `install-notifier-spine`, `recovery-notifier-spine`, `notifications-controller`,
  `notifier-adoption-wiring`, the outbox specs and the bulk-unassign specs all pass untouched.
- **AC3** ✅ — the seam assertion is now "no real provider unless explicitly configured", and its e2e
  moved with it.
- **AC4** ✅ — `notification_deliveries` carries `provider_message_id` and `error`.
- **AC5** ✅ — no SMS/WhatsApp/email adapter added; the FCM gateway answers `UNAVAILABLE` for all
  three, so binding it changes one channel and nothing else.

## Tests, verbatim

```
npx vitest run test/fcm-push-delivery.e2e-spec.ts test/notification-seam-assertion.e2e-spec.ts \
               test/notification-service.e2e-spec.ts test/setup-env-allowlist.spec.ts
 Test Files  4 passed (4)
      Tests  40 passed (40)

npx vitest run test/day-plan-notifier-spine test/install-notifier-spine test/notifications-controller \
               test/recovery-notifier-spine test/notification-outbox-generic \
               test/day-plan-notification-outbox test/notifier-adoption-wiring \
               test/batch-dispatch-notify test/business-sweep-scheduler-wiring
 Test Files  9 passed (9)
      Tests  50 passed (50)

npx vitest run test/bulk-unassign-execute test/bulk-unassign-history test/bulk-unassign \
               test/recommender-waiting-component test/intraday-notification-outbox \
               test/day-plan-notification-counts
 Test Files  6 passed (6)
      Tests  31 passed (31)

npx tsc --noEmit   # clean
```

The **Prisma drift gate was not run** — it cannot run on this box (the local `fsm` role cannot
`CREATE DATABASE`). Per the standing operator decision the migration is hand-written and relied on
through the suite; `prisma/drift-baseline.txt` was deliberately not regenerated.

## Follow-ups this slice does not own

- **Redelivery of a retryable push.** A 5xx is recorded FAILED and marked `retryable`, but nothing
  re-sends it: the outbox retries on a thrown delivery, and `notify()` writes the in-app row first, so
  propagating would duplicate the lock-screen entry once per attempt. A real fix needs either an
  idempotency key on `notifications` or a push-level redelivery pass that re-reads the FAILED delivery
  rows. Both are outbox/spine changes, not adapter changes.
- **Mobile token registration (#89, mobile half).** Excluded by scope and still open. Until it lands,
  every user is tokenless, so with `PUSH_PROVIDER=fcm` the push channel answers UNAVAILABLE and the
  chain behaves exactly as it does today — the exit is real but has nobody to deliver to yet.
- **FCM project credentials.** Operator provisioning (HITL). The manual verification named in the
  issue's Verification line — one real push to a test device — cannot be performed until they exist.
- **APNs.** Not built. `PUSH_PROVIDER` is an open enum by design; a second provider is a second
  branch in `createChannelGateway` and a second adapter file, with nothing else to change.
- **`autoplant-window-preflight.ts`** prints `report.gateway` but not the new `report.pushProvider`.
  Not this slice's file; the assertion itself already refuses the window, so the operator gets the
  right outcome with one less line of detail in the log.
