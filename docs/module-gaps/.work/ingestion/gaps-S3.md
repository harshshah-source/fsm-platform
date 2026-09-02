# ingestion — S3 walk narrative (2026-09-02, api-walk only, NO browser, NO run fired)

**No ingestion run, master sync, pipeline or snapshot was triggered.** Every write-shaped call was
made as an UNAUTHORISED role to read the 403 and nothing else.

## ING-02 C4 — confirmed E4, and it is the cheapest big win as briefed
`GET /integration/health` as `ops.head` → 200. Measured top-level keys:
`source · masterSync · snapshot · reconciliation · lifecycle · runtimeLock · recomputes`.
`apps/admin/src/api/integrationHealth.ts:48-55` declares `masterSync.build`, `snapshot.build`,
`runtimeLock`, `recomputes`, `ingestion`. Dropped **whole**: `source`, `reconciliation`, `lifecycle`.
Dropped as **fields**: `lastAt`, `lastStatus`, `ageMinutes` on both masterSync and snapshot.
Correction to S2's arithmetic: it is **three whole sections plus the freshness triplet on two more**,
not four sections. The finding is stronger than the count, because the dropped sections are red right now:
- `reconciliation.reconciled: false` — vehicles drift **-15594**, plants **-21**, maxDriftAllowed 0
- `lifecycle.healthy: false` — drift 71, `missingFromSource` **3376**
- `masterSync.ageMinutes: 1293`, `snapshot.ageMinutes: 1288`

`BuildHealthPage.tsx` (204 lines) greps zero for `lifecycle|reconcil|ageMinutes|drift|vehicleRows`.
The backend already computes every one of these. One edit to the client type + one card renders them.

## ING-03 O2 — confirmed E4, and it is the *healthy* reading, not *unknown*
This was the honest distinction I was asked to draw, and the live app settles it without a run.
`GET /snapshots/latest` → `status SUCCESS`, `dataAsOf 2026-09-01T12:00:08Z`. Read on 2026-09-02 that
is ~25 h old. `isStuck()` (`SnapshotBanner.tsx:31`) returns false unless `status === 'RUNNING'`, so a
SUCCESS of any age is never stuck; `failed` false; `wedged` false. The banner renders the calm grey
`role="status"` "Snapshot: data as of …" line. **A pipeline that has not run for a day reports healthy.**
Zero-row shape confirmed at source, no run needed: the quietRuns SQL (`health.service.ts:359-369`)
`COUNT`s SUCCESS `master_sync_runs` only — zero rows ⇒ `quietRuns 0` ⇒ `quietRunsAlert = 0 > 3` false
⇒ feeds `healthy: true`. `deriveIngestionAlert` with `runs=[]` gives `latestStatus null, streak 0,
alert false, downstreamGated false`. Every detector counts runs that happened, exactly as claimed.
Sharpest sub-finding: `masterSync.ageMinutes` **is already computed** and thrown away by the client.
ING-02's one-edit fix is also 80% of ING-03's fix.

## ING-01 O2 — confirmed E4, worse than hypothesised. All five not-found checks recorded.
`device-departure/` has **zero controllers**; `grep departure` over every `*.controller.ts` = 0 hits.
The only carrier is `lifecycle.missingFromSource: 3376` inside the OH-only health payload — and
ING-02 drops it. So **no role, OH included, sees departures on a screen**. 403 measured for
`zm.north`, `csm`, `wm`, `se.north`. `cancelledTicketsCount` (`:279`) reaches no endpoint at all.
FOLDED, E2 (needs a sync to reproduce): `restoreDepartures` (`:395-420`) writes the departure row +
a `DEVICE_REDEPLOYED` audit row and **zero ticket writes** — `:299` closes tickets on departure,
restore never reopens or replaces them.

## ING-04 O1 — confirmed E4: no screen, not no data
`GET /snapshots/runs` as `ops.head` → 200, **ARRAY len=50**, real rows (runId 169 SUCCESS
11:55:01→12:01:32, dataAsOf 12:00:08). 403 for `zm.north`/`wm`/`se.north`. Prices as UI-only work.

## ING-08 C6 (new) — WM and SE get no freshness banner at all
`GET /snapshots/latest`: `zm.north` 200 · `csm` 200 · `ops.head` 200 · `wm` **403** · `se.north` **403**.
`SnapshotBanner.tsx:55` `.catch()` swallows it, `view` stays null, JSX is gated on `view`. The banner
is mounted above **every** route (`AppRoutes.tsx:62`), so a Warehouse Manager works every page with no
staleness signal and cannot tell healthy from wedged. H4's strongest alternative is falsified — WM has
admin pages.

## ING-05 P2 — guard confirmed, finding unchanged
`POST /snapshots/run` 403 × zm.north/csm/wm/se.north. `POST /integration/run-pipeline` 403 × zm.north/csm.
`POST /integration/sync-masters` 403 × zm.north. Class-level `@Roles('OPERATIONS_HEAD')` is enforced.
The no-audit half stays at S2's E2 — it cannot be upgraded without firing a run.

## ING-09 O4 (dev-process, never in the feature backlog)
The live health payload has **no `ingestion` key**. `git show HEAD:…/health.service.ts | grep 'ingestion:'`
returns nothing and `ingestion-alert.ts` is untracked — #300 is uncommitted working-tree work the running
process was not built from. Consequence: the admin `IntegrationHealthView` declares `ingestion` as a
**required** field the deployed backend does not send. Any claim about the wedge alert is measured
against source, not the running app. Restart the backend on HEAD+worktree to settle.

## H1 — FALSIFIED
The INACTIVE→ACTIVE auto-recovery stage exists; it lives in **`ticketing`**, not `ingestion`:
`apps/backend/src/ticketing/auto-recovery.service.ts`, ticket status `CLOSED_AUTO_RECOVERY`, counted at
`devices/device-detail.service.ts:117`. The S2 altCheck grepped only the `ingestion` tree, which is why
it read as absent. The hypothesis's own strongest alternative was right. Do not re-file.

DISCL 0/0/0 — no browser walk; disclosure sweep is browser-only and no screen-only claim was made.
