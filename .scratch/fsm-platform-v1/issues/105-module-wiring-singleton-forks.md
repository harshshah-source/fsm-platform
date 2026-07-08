# 105 — Module wiring: eliminate cross-module service re-provisioning / singleton forks
Status: ready-for-agent
Type: AFK

> Source: `docs/audits/2026-07-03-backend-production-readiness-audit.md` — HIGH #13. Verified
> still-open 2026-07-07: feature modules re-`provide` each other's service classes
> (`recommender.module.ts` provides `InventoryService`/`SeAvailabilityService`/`SoftInactiveCountService`;
> `engineers.module.ts` provides `InventoryService`), creating a separate instance per injector, and
> `recommender.service.ts` `new`s cross-module services as constructor defaults.

## What to build

Fix the module facade so a service has exactly one instance. Each service is provided by exactly one
owning module which `exports` it; consumers `import` that module instead of re-declaring the service
in their own `providers`. Remove the `new SomeService(...)` constructor defaults that fork an
instance outside the DI graph.

This is a prefactor with no behavior change today (the services are stateless), but it is load-bearing
before any service adds caching or `OnModuleInit` state — at which point the silent fork becomes a
correctness bug. "Make the change easy, then make the easy change."

## Acceptance criteria

- [ ] Each shared service (`InventoryService`, `SeAvailabilityService`, `SoftInactiveCountService`, and any other cross-provided service) is provided by exactly one module and `export`ed; no module re-declares another module's service in `providers`.
- [ ] `recommender.service.ts` (and any peer) no longer `new`s a cross-module service as a constructor default — all cross-module deps arrive via DI.
- [ ] A test (or a documented DI assertion) confirms a single instance is shared across the importing modules.
- [ ] tsc + existing e2e suite stay green; no behavioral change.

## UI surfaces
n/a (backend)

## Reference
n/a

## Blocked by
None — can start immediately (ideally before the next feature module is added on the current pattern).
