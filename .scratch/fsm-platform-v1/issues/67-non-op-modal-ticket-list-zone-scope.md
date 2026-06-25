# 67 — Non-Op Mark modal ticket enumeration + queue zone-scope + Recovery toast

Status: ready-for-agent
Type: AFK
Origin: Issue 35 parity follow-up (2026-06-25).

## What to build

UI/read refinements deferred from Issue 35 (the dual-confirmation backend + admin queue are built and
green). None are external-integration blockers; they are scoped here to keep #35's parity gate honest.

- **Enumerate auto-close tickets in the Mark modal.** The Confirm/Mark-Non-Operational modal currently
  shows a generic "in-flight tickets will close" warning. CONTEXT §14 / the #35 spec want the *actual*
  in-flight Tickets for the device listed before confirmation. Needs a tickets-by-device read
  (`GET /api/tickets?deviceId=` or similar) returning the OPEN/SUBMITTED/VERIFICATION_PENDING/ESCALATED
  set, rendered in the modal.
- **Zone-scope the dual-confirmation queue.** `GET /api/non-op/queue` returns all open markings; a ZM
  should see only their own zone (CSM/Operations Head all zones), matching the sibling queues. Resolve
  device→zone via `device_states.plant → zone` (or the denormalised plant on the marking, if added).
- **Literal Recovery-Ticket toast.** Surface the auto-created Recovery Ticket number as a toast when a
  confirmation reaches CONFIRMED (today the number is shown on the queue row only). Because CONFIRMED is
  usually reached via the async customer email link, the toast belongs on the queue refresh, not only
  the manager's click.

## Acceptance criteria

- [ ] Mark/Confirm modal lists the actual in-flight Tickets that will auto-close for the device
- [ ] `/non-op/queue` is zone-scoped (own-zone ZM; all-zones CSM / Operations Head)
- [ ] Recovery-Ticket number surfaced as a toast on reaching CONFIRMED

## Blocked by

- #35 (done)
