# #187 — voucher-controller stops depending on incidental state

**Done 2026-08-20**, in one change with #215 — see
[`docs/progress/215-shared-fixture-se-zone-leak.md`](./215-shared-fixture-se-zone-leak.md) for the
full design; this file records only what is #187-specific.

The spec authenticated as `se.north@fsm.test` and created vouchers for it, but built no
`engineer_master` fixture — `VouchersService.create()`'s `SE_NOT_FOUND` guard 400'd every creation
(3/5 red alone), and when another spec had incidentally created the row in a foreign zone, the
zone-scoped ZM queue missed instead (2/5 red in a sweep).

**The issue's own prescription was corrected at fix time** (recorded in the issue file): "add the same
seed the other 104 files already do" would have copied the exact pattern #215 exists to remove —
per-file create-only upserts into per-file zones, first writer wins. Instead the row is canonical
seeded state (global setup, North, DEDICATED), and this spec's `beforeAll` calls the same
`seedSharedAuthSeEngineer()` for explicit self-sufficiency. No zone creation was needed (the org seed
guarantees North); nothing is deleted in `afterAll`, because deleting seeded state would recreate #215
for every spec that runs after.

**Verification:** 5/5 alone, twice; 5/5 after `verification-controller` (the ordering that used to
change the failure's shape); red→green measured (3/5 → 5/5 alone, purely from the seed landing).
