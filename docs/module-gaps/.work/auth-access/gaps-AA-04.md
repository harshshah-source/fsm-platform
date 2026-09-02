# AA-04 / AA-07 / AA-10 — credentials and sessions, walked 2026-09-02 (S3, api + psql)

## No lockout, no throttle, no counter (AA-04, C1, confirm, E4)
Twelve consecutive wrong-password `POST /api/auth/login` for `zm.north@fsm.test`: twelve 401s in
**548 ms total**, latency flat at 31-42 ms with no backoff and no growing delay. The thirteenth call,
with the correct password, returned **200 immediately**. Nothing counts, nothing slows, nothing
locks. Volume was deliberately capped at twelve — this is a shared dev box, and twelve settles it.

The compounding fact is AA-10: none of those twelve failures left a row. A `SELECT DISTINCT action`
matching `LOGIN|LOGOUT|AUTH|SESSION|ACTING` over all **34,758** audit rows returns nothing. So the
platform can neither slow a guesser nor notice one afterwards. Six accounts, five roles, one door.

## What does work — say it plainly (C2 checks 3/6 → pass)
Refresh handling is sound and was re-read, not inferred: login issues a pair; `POST /auth/refresh`
**rotates** the refresh token; replaying the old one returns 401; `POST /auth/logout` returns 200 and
the refreshed token then fails 401. Single-use rotation and revocation genuinely persist
(`prisma-refresh-token-store.ts:41`).

The one caveat: the **access** token still returned 200 for a protected read *after* logout. That is
ordinary stateless-JWT behaviour with a ~15-minute life and no revocation list, and it is not filed
as its own gap — but it sets the blast radius for the next item.

## Acting has no server-side existence (AA-07, P2, confirm, E4)
Live claims are `{user_id, role, zone_id, iat, exp}` — nothing about acting. Acting is a request
header and only a request header. There is therefore no server-side state for "Exit acting mode" to
revoke: the button clears `sessionStorage` in one tab. Any other tab, any script, any replayed
request that still carries a valid token plus the header is back in acting scope, for the life of
the token, with no record that anyone entered or left. Zero enter/exit rows exist in the ledger.

## Not settled here
AA-08 (does the sidebar swap to the ZM menu while acting?) and AA-09 (banner says "Zone 2", not
"South") are rendered-screen questions. The api instrument cannot see a menu. One browser walk
(~708k TEQ) settles both: log in as `csm@fsm.test`, enter acting from the TopBar zone picker,
screenshot the Sidebar and the AppShell banner on the Manager Dashboard. The backend already returns
`zoneName` on `dashboard/zone-overview`, so AA-09's fix has its data waiting.
