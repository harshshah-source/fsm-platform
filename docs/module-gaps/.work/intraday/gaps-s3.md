# intraday S3 walk — 2026-09-02, api-walk only (no browser)

Short walk by design. Most of the module is E2-settled at S2 and was not re-walked.
Four units, all settled with the cheap instrument. ~14 API calls.

## 1 · The default-status residue has NO teeth (falsify)
S2 flagged that `IntradayInsertion.status` still DEFAULTs to `PENDING_ACCEPTANCE`
(`schema.prisma:548`), a state whose mechanic was deleted by #268/#279. If live rows sat there,
that would be a C7 unreachable state on real data.

Read the whole table through the API as `csm` and `ops.head` (cross-zone, 1936 rows):

| status | rows |
|---|---|
| `ASSIGNED_DIRECT` | 1163 |
| `ESCALATION_REQUIRED` | 773 |
| everything else | **0** |

`declineReasonCode` null on all 1936. `retryCount` 0 on all 1936. `whatsappSent` false on all 1936.
Every write path overwrites the default before commit, so **no live row is stranded in a retired
state**. `INTRA-G6` stays what S2 called it — dead schema, S1, REFACTOR — but is now `E4` and can be
priced as a pure migration + payload trim with no data repair.

One thing the walk added: the residue is not merely stored, it is **served**. `acceptanceDeadline`
comes back equal to `offeredAt` to the millisecond on every `ASSIGNED_DIRECT` row, and the three dead
columns ride the wire into the admin client. The deletion is a schema + DTO job, not schema alone.

## 2 · Check 6 — the retirement is clean at the API boundary (falsify H3-as-gap)
Six routes × the two roles that should not have them:

`GET /intraday-insertions` · `GET /intraday-updates` · `POST /intraday-updates/add` ·
`POST /intraday-insertions/fire` · `GET /intraday-insertions/:id/available-ses` ·
`POST /intraday-insertions/:id/manual-assign` — **403 as `se.north`, 403 as `wm`, all twelve.**

The deleted role has no API access. This is the interesting negative: no residual SE door.

Zone clamp holds server-side. `zm.north` 552 rows, every one `zoneId:1`. `zm.south` 159 rows, every
one `zoneId:2`. `zm.south` posting `manual-assign` at zone-1 row `1932` → **404
`INSERTION_OR_SE_NOT_FOUND`** — the cross-zone write is refused, not silently applied.

Two soft edges, neither a gap: `GET :id/available-ses` answers a foreign-zone row and a nonexistent
id identically (`200 []`, from `:405`/`:408`), so "not your zone" reads as "nobody free"; and
`listForScope:479` clamps only when `role === 'ZONAL_MANAGER' && zoneId != null`, so a ZM whose
`zone_id` is null would fall through to the CSM/OH cross-zone branch. **UNTESTABLE** with seeded
data — the fixture that settles it is a `ZONAL_MANAGER` user row with `zone_id` NULL.

## 3 · The dead `/intraday-updates` routes are ALIVE (confirm)
`add` / `remove` / `reorder` as `zm.north` with `{}` return **400** with each handler's own code
(`TICKET_AND_SE_REQUIRED`, `BATCH_AND_TICKET_REQUIRED`, `BATCH_AND_SEQUENCE_REQUIRED`) — registered,
guarded, reaching their own validation. Not 404. So `INTRA-G7` is **C4** (a backend layer with no UI),
not OBSOLETE. That changes the price: wiring is the C4 fix, but the same-day edit already has a door
(`POST /batches/:id/override`), so wiring duplicates it and deleting is the cheaper call — a decision,
not a freebie. `GET /intraday-updates` returns `200 []`: no `MANUAL_ZM_UPDATE` row has ever been
written in this DB, so the whole surface is unexercised.

## 4 · INTRA-G3 — NEEDS-VERIFY
Screen-shaped. Screen: **Intra-day Queue**, admin `/schedules/intraday`, as `zm.north`. Control: the
page body after `useEffect(load, [])` (`IntradayQueuePage.tsx:148`) — is there any refresh control,
poll or focus-refetch not visible in source? Cost to settle: **one browser walk ~708k TEQ**.

## New gap that blocks C1 — INTRA-G10
The queue is not a queue, it is the full history. `listForScope:481` `findMany` has no `take`, no
cursor and no date filter; `IntradayQueuePage.tsx:139` renders every row with no status or date
filter and no pagination. One ZM gets 552 rows, of which 327 are open `ESCALATION_REQUIRED` buried in
months of resolved rows; CSM/OH get 1936. This blocks INTRA-G3: adding a poll to an unbounded payload
makes it worse, so the two are one fix.

## Environment
Backend healthy throughout, no timeouts or 502s. Build fingerprint per shared primer.
