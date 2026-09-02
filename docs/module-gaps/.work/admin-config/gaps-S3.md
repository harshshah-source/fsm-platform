# S3 · GAPS narrative — admin-config (walker, 2026-09-02, no browser)

**Mutations I made, and their state.** Two, both declared:
1. Created ONE disposable account via `OH POST /api/org/users` —
   `surveyor.disposable.20260902@fsm.invalid`, `WAREHOUSE_MANAGER`, no zone, phone `+919900000199`,
   userId `9c8f2350-7d16-4737-9cc7-004b7ad4f98c`, named `ZZ Surveyor Disposable DELETE ME`.
   I then **disabled it** with `PATCH /api/org/users/<id> {status:DISABLED}` — which doubled as the
   AC-06 backend proof. **It cannot be deleted from here**: `org/users` has no DELETE verb, and this
   box has neither `psql` nor `docker`. It is inert (WM role, no zone, no credential, DISABLED) and
   is the last row of `GET /org/users`. **Restored as far as the API allows; residue declared.**
2. **No config dial was touched.** The one PUT I aimed at a dial (`settings/assignment-threshold`)
   carried `hours: 48` — the value already in force — precisely so a 200 would have changed nothing.
   It returned 403. Threshold before and after: **48**. Plant states, SLA rules, tiers, zones,
   scoring weights, common kit: untouched. All other write probes used empty bodies, so a role that
   slipped past `RoleGuard` would have produced a 400, not a mutation. None did.

## AC-01 — confirmed, E4. The console mints dead accounts.

`POST /api/org/users` as OH returns **201** with a full `UserView` and **no password, no invite, no
token, no activation link**. Three login attempts against that email — `correct-password`, empty,
`changeme` — return **401** each. The five not-found checks are complete: the auth controller has
only `login`/`refresh`/`logout`; the sole `userCredential.create` is `auth/credential-seed.ts:21`
with seed-only callers; a grep for `invite|reset-password|set-password|activation` across
`apps/backend/src` returns zero product hits; the terminology check turned up the one thing that
looks like an escape hatch — `LoginPage.tsx:162` **"Forgot Password?" is `<a href="#">`**, a dead
anchor with no handler — and no other module offers an entry point. So the S4 stands and gets worse:
there is no provisioning path *and* no recovery path. Check 6 is clean (ZM/CSM/WM → 403), which is
the small mercy: only the OH can create the unusable accounts.

## Check 6 across the dials — 32 probes, 32 refusals.

Every write endpoint in `org/` plus `plants/:id/deactivate` and `settings/:key` refused ZM, CSM and
WM. **H-AC-5 falsified in the good direction:** `ZM PUT settings/assignment-threshold` → 403, so the
graded party genuinely cannot move the dial they are graded on; `static.md` row 48 was the scanner's
guard column off by one decorator (**O4-b**, already a standing rule — this is its second sighting in
this module, after `zones.controller.ts`). S2's two corrections both survive the live call. CSM's
co-ownership is real and narrow: CSM is refused everywhere except the threshold PUT.

## AC-04 — confirmed, and it is worse than S2 could see.

I read the audit trail after my own writes. `USER_CREATED` and the historical `SETTING_UPDATED` rows
are all there, attributable to the actor and role. But the row says *who* and *what key*, never
*from what to what* — and there are **two** causes, not the one S2 found. `settings.service.ts`
passes no `metadata`; separately, the **only reader in the app projects no metadata column at all**
(`dataset-registry.ts:2489` — action, entityType, entityId, actorId, actorRole, createdAt, full
stop). So `assignment-threshold.service.ts:224`, which *does* write `previousHours/newHours/reason`
correctly, is writing into a column nobody can read. `schema.prisma:1729` has `metadata Json?`
sitting there unused by the lens. The fix is two files, not one. C9's write coverage remains as good
as S2 said; its readability is the failure.

## AC-05 — confirmed, refined. A lens exists, for exactly one role.

ZM, CSM and WM all get **403** on the auditLogs dataset; OH gets 200. S2 read this as "no screen
anywhere"; the truer statement is **OH-only, env-gated (`OPS_EXPLORER_ENABLED` unset ⇒ false), and
value-blind**. A CSM who co-owns the assignment threshold cannot read the trail of their own dial.

## AC-06 — confirmed, E4, and cheap. Backend sound, console silent.

`PATCH` disabled my throwaway user and the DISABLED status survived a re-GET (**check 3 passes**).
`apps/admin/src/api/org.ts` ships `listUsers` and `createUser` and nothing else; `setStatus` and
`DISABLED` appear nowhere in the admin client or `sections.tsx`. This is the pure C4 shape — one
client function and one row control away from done, with a working, audited, persisting backend.

## AC-13 / AC-02 — the two halves I would not buy at this price.

`GET /dispatch-runs/36` shows `configSnapshot.settings.se_assignment_threshold_hours = 48`, matching
the live value: the snapshot records the **effective** number, confirming S2 from the other side.
What stays unproven is whether the engine re-reads it mid-day or caches it — that needs a real
threshold change, which I was told not to make while other walkers are live. AC-02 is the same
shape: 6 real deactivations exist in this data, so the path is exercised, but proving the missing
outbox enqueue means deactivating a plant, and that is precisely the destructive act forbidden here.
Both carry their fixture cost in `gaps.jsonl`; both want an exclusive window.

DISCL 0 found 0 opened 0 blocked (no browser this walk — screen claims are named in not-walked.json).
