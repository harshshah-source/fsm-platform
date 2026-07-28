# 111 — Deployment packaging + operational runbook (Docker, config, rollback, backup/DR)
Status: ready-for-human
Type: HITL

> Source: 2026-07-07 independent re-audit (new finding). Verified: **no Dockerfile, no
> docker-compose, no deployment manifest, no backup/rollback/DR documentation anywhere in the
> repo** (glob: zero matches). #107 owns CI; nothing owns how the system actually reaches and
> survives production.

## Evidence

- No container/packaging artifacts in the repo root, `apps/backend`, or `apps/admin`.
- `apps/backend/package.json` start script assumes a local `.env` file; no production config story
  beyond raw env vars (validation arrives with #98).
- Postgres 16 + PostGIS + Redis-free BullMQ-free runtime, MySQL-over-VPN dependency — none of the
  provisioning is described; the only ops docs are code comments.
- No backup schedule/restore drill, no rollback procedure (DB migrations are forward-only Prisma),
  no disaster-recovery statement for the telemetry journal or the audit log.

## Root cause

Greenfield build ordered product slices first (correctly); Issue 01 stood up dev infrastructure
only, and no later issue picked up production packaging. HITL because target infrastructure
(cloud/on-prem, orchestrator, DB hosting, VPN topology to AutoPlant) is a business/external-access
decision the repo cannot make.

## Production impact

There is currently no reproducible way to stand the system up outside a developer laptop, no
defined rollback when a deploy goes bad (forward-only migrations make ad-hoc rollback dangerous),
and no backup/restore guarantee for the system of record (tickets, audit trail, inventory ledger).
Any production incident becomes improvisation.

## What to build (after the HITL decisions)

1. **Decisions needed from the owner (HITL):** target runtime (containers on a VM / k8s / managed
   PaaS), DB hosting + backup ownership, VPN/network path from the runtime to AutoPlant MySQL,
   domain/TLS, log destination.
2. Multi-stage Dockerfiles for backend (node dist + prisma migrate deploy entrypoint decision) and
   admin (static build behind a web server), plus a compose/manifest for the chosen target.
3. Production config story: required env vars enumerated in one documented place (feeds #98's
   fail-fast validation), secrets sourced from the platform's secret store — never baked into images.
4. **Runbook** (`docs/ops/`): deploy procedure, migration-forward rollback strategy (expand-contract
   convention for schema changes + restore-point policy), backup schedule + tested restore drill,
   DR statement (RPO/RTO for Postgres; raw-telemetry re-ingest from AutoPlant as the recovery path
   for the journal), incident basics (health endpoints from #98, stale-run reaper behavior).

## Acceptance criteria

- [ ] `docker build` (or the chosen packaging) produces runnable backend + admin images from a clean checkout; CI (#107) builds them.
- [ ] A documented one-command bring-up exists for a staging replica (app + Postgres/PostGIS + migrations + seed).
- [ ] The runbook covers deploy, rollback (with the expand-contract migration convention adopted), backup + a **performed** restore drill, and DR with stated RPO/RTO.
- [ ] Required env vars are enumerated in one doc that #98's boot validation provably matches (test: validator's required list == documented list).
- [ ] Images contain no secrets (assert via CI image scan or documented check).

## UI surfaces
n/a

## Reference
n/a

## Blocked by
HITL decisions above (infrastructure target + external access). #98 (env validation) and #107 (CI)
land independently and are consumed by this issue.

## Comments

### 2026-07-28 — mobile-readiness notes (docs/status/backend-mobile-readiness-plan-2026-07-28.md §C/§D)

Two items routed here:
1. **Log durability prerequisite for #167**: correlation-ID + access-log work is worthless if
   stdout evaporates — the runbook must land process-manager/file retention for backend logs.
2. **Single-instance ceiling (HITL D8)**: in-memory auth stores, process-local sweep locks, and
   13 in-process crons make the backend single-instance by construction. If the operator accepts
   that for the 1,000-device pilot (plan doc recommends: yes, with #106-ext/#110/#165 landed),
   this issue documents it as an explicit capacity/availability ceiling — including "every deploy
   is a fleet-wide logout until #91 lands; schedule deploys off-shift."
