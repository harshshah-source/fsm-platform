# 06 — API Reference

All routes are prefixed `/api` (`app.config.ts`). **Default posture: authenticated** (global
`AuthGuard`; `@Public()` opts out — only `/auth/*`, `/health*`, and the customer non-op confirm
link are public). `@Roles(...)` allow-lists per route; ZONAL_MANAGER is zone-clamped by
`ZoneScopeGuard`. Roles abbreviations: SE, ZM, CSM, OH, WM; "mgr" = ZM+CSM+OH.

Inventory extracted from `@Controller`/`@Get`/`@Post`/`@Put`/`@Patch`/`@Delete` decorators across
all 51 controllers (grep-verified). Grouped by domain:

## Auth & session
| Method | Route | Handler | Notes |
|---|---|---|---|
| POST | `/auth/login` | AuthController → AuthService.login | Public; in-memory user store; returns `{accessToken, refreshToken}` |
| POST | `/auth/refresh` | AuthService.refresh | Public; single-use rotating refresh |
| GET | `/me` | MeController | Session view incl. acted_as_role |
| GET | `/health`, `/health/ready` | HealthController | Public; ready checks DB |

## Org administration (mostly OH; audited)
| Method | Route | Purpose |
|---|---|---|
| GET/POST | `/org/zones` | zone CRUD |
| GET | `/zones/:zoneId` | zone read (ZM-scoped) |
| GET/POST | `/org/plants` | plant list/create |
| GET/POST/PATCH | `/org/users`, `/org/users/:userId` | user registry |
| GET/POST/PATCH | `/org/companies`, `/org/companies/:id` | company master (tier/rank) |
| GET/POST | `/org/engineers` | engineer admin (org flavor) |
| GET/POST/DELETE | `/org/se-coverage`, `/org/se-coverage/:id` | dedicated/multi-plant coverage |
| GET/POST/DELETE | `/org/se-territory`, `/org/se-territory/:id` | floating territory dims |
| GET | `/org/geo/states|regions|districts` | geography lookups |
| GET/PUT | `/org/sla-rules` | SLA windows config |
| GET/POST | `/org/scoring-weights` | recommender weight sets |
| GET/POST | `/org/common-kit` | common-kit definition |
| GET | `/org/zone-mappings`, `/org/zone-mappings/pending` | crosswalk queue |
| POST | `/org/zone-mappings/:id/map|ignore`, `/org/zone-mappings/reapply` | map raw value → zone; re-apply |
| GET/PUT/DELETE | `/org/plant-zone-overrides[...]` | per-plant zone pin |

## Ingestion & integration (OH-gated triggers)
| Method | Route | Purpose |
|---|---|---|
| GET | `/snapshots/latest`, `/snapshots/runs` | freshness banner + run ledger |
| POST | `/snapshots/run` | manual snapshot ingest |
| GET | `/integration/health` | AutoPlant connectivity + reconciliation counts |
| POST | `/integration/sync-masters` | manual master sync (409 RUN_IN_PROGRESS) |
| POST | `/integration/run-pipeline` | full pipeline: masters→snapshot→device-state→tickets |

## Tickets & field loop
| Method | Route | Purpose |
|---|---|---|
| GET | `/tickets`, `/tickets/:id`, `/tickets/:id/forms` | list/detail/forms (zone-scoped) |
| POST | `/tickets/:id/auto-recovery-close` | manual auto-recovery close |
| POST | `/tickets/:id/troubleshoot` | SE troubleshoot submission (idempotent by client_submission_id) |
| POST | `/tickets/:id/soft-state` | VIEWED/ON_SITE/TROUBLESHOOT_STARTED |
| POST | `/me/activity-ping` | SE activity heartbeat |
| GET | `/me/shared-pool` | SE shared-pool tickets |
| POST/GET | `/vehicle-unavailability[...]` + `:id/confirm-date`, `:id/resume-sla` | SLA pause on vehicle unavailability |
| POST/GET | `/non-op`, `/non-op/queue`, `:id/confirm`, `:id/override-confirm` | dual-confirmation non-op |
| GET | `/non-op/confirm` | **Public** customer token confirm link |
| POST/GET | `/recovery/...` (13 routes) | recovery lifecycle: schedule/on-site/collected/unable/receipt/queues/close/escalate |
| POST/GET | `/install`, `/install/upload` (CSV), `:ticketId/schedule|on-site|fitted`, `GET :ticketId` | install lifecycle |
| GET/POST | `/verification/review`, `:ticketId/escalate`, `:ticketId/mark-auto-recovery`, `/tickets/:id/verification`, `/verification/fraud-flags` | GPS verification review |
| GET | `/audit-trail/tickets/:ticketId` | ticket audit timeline |

## Scheduling & dispatch
| Method | Route | Purpose |
|---|---|---|
| POST | `/schedules/dispatch-run` | manual daily dispatch (same code path as cron) |
| GET | `/schedules`, `/schedules/me`, `/schedules/engineers`, `/schedules/:engineerId` | day-plan reads |
| POST | `/schedules/assign` | ZM manual assignment |
| POST | `/batches/:id/override` | ZM override (remove/defer/reorder/swap/split/onsite) |
| GET/POST | `/intraday-updates` + `add|remove|reorder` | ZM same-day manual updates |
| GET/POST | `/intraday-insertions` + `fire`, `sweep-timeouts`, `:id/accept|decline|manual-assign`, `:id/available-ses` | system CRITICAL insertion offers |
| GET/POST | `/cross-zone` + `sweep`, `flag`, `:id/approve|deny|defer|re-escalate` | cross-zone escalation queue |
| GET/POST/DELETE | `/planner`, `/planner/plants`, `/planner/:id` | SE planner grid |

## Engineers & people ops
| Method | Route | Purpose |
|---|---|---|
| GET | `/engineers`, `/engineers/directory`, `/engineers/:seId` | activity status + directory |
| POST/PATCH | `/engineers`, `/engineers/:seId`, `:seId/status`, `:seId/coverage`, DELETE coverage | SE CRUD (mgr) |
| POST | `/engineers/:seId/availability` | availability window write |
| POST/GET | `/leave-requests` + `:id/approve|reject` | leave workflow |
| POST | `/role-unavailability` | backup cascade record |
| GET | `/reports/csm-approval-share` | OH backup-share report |
| POST/GET | `/vouchers` + `export`, `mark-paid`, `:id/review`, `:id/resubmit` | expense vouchers |

## Inventory & warehouse
| Method | Route | Purpose |
|---|---|---|
| GET | `/me/van-stock` | SE van stock |
| GET | `/component-blocked` | ZM blocked queue |
| GET/PATCH | `/inventory/warehouse-stock` + `fulfillment-sla` | WM zone stock |
| GET/POST | `/warehouse/requests` + `:id/approve|ship|reject` | WM component requests |
| GET/POST | `/component-requests` + `by-ticket/:ticketId`, `:id/confirm-receipt|confirm-resubmit` | SE/mgr side |
| GET/POST | `/warehouse/shadow-use` + `:id/reconcile|dispute` | shadow-use reconciliation |

## Dashboards, reports, exports, admin
| Method | Route | Purpose |
|---|---|---|
| GET | `/dashboard/zone-overview|company-plant-overview|critical-queue|action-required` | dashboards |
| GET | `/devices` + `filter-options`, `:deviceId`, `:deviceId/cycles`, `:deviceId/downtime-trend`; PATCH `:deviceId/deal-type` | device registry |
| GET/POST | `/reports/fleet-uptime[.../recompute]`, `soft-inactive-trend`, `root-cause`, `zm-scorecard` (OH), `efficiency` + recompute triggers | report cubes |
| GET/POST | `/notifications` + `read-all`, `:id/read` | in-app notifications |
| GET/PUT | `/settings`, `/settings/:key` | system settings (OH write) |
| GET | `/exports/entity-mapping[.../summary]` | OH CSV export (audited download) |
| GET/POST | `/plants/deactivations`, `/plants/:plantId/deactivate|reactivate` | OH plant deactivation |

## Uniform execution sequence

```mermaid
sequenceDiagram
  participant C as Client
  participant AG as AuthGuard
  participant RG as RoleGuard
  participant ZG as ZoneScopeGuard
  participant VP as ValidationPipe
  participant CT as Controller
  participant SV as Service
  participant AU as AuditService
  participant DB as Postgres
  C->>AG: Bearer JWT (+ X-Acting-As-Zone)
  AG->>AG: verify HS256 + exp, attach request.user
  AG->>RG: claims
  RG->>ZG: role in @Roles allow-list?
  ZG->>VP: ZM zone clamp on :zoneId / ?zone_id
  VP->>CT: whitelisted, transformed DTO
  CT->>SV: resolveRequestActor(user, acting header)
  SV->>AU: withAudit(entry, work)
  AU->>DB: BEGIN; mutation + audit_logs INSERT; COMMIT
  DB-->>C: JSON (HttpException contracts preserved by AllExceptionsFilter)
```
