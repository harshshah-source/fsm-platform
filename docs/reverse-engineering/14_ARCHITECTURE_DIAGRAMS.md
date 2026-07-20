# 14 — Architecture Diagrams (Consolidated)

All 20 required diagrams. Richer domain-specific variants live in the topical files
(05 database, 06 API, 09 auth, 11 workflows).

## 1. High-level system architecture

```mermaid
flowchart LR
  ADMIN[Admin SPA React/Vite] -->|Bearer JWT /api| BE[NestJS monolith]
  MOBILE[Expo mobile - auth shell] -->|Bearer JWT /api| BE
  BE --> PG[(Postgres 16 + PostGIS)]
  AP[(AutoPlant MySQL via VPN)] -->|read-only| BE
  BE -.->|seams| EXT[Push/SMS/WhatsApp/Email + SAP PGI]
  CRON[in-process cron] --> BE
```

## 2. Application architecture

```mermaid
flowchart TD
  subgraph Admin
    P[pages] --> A[api modules] --> H[http interceptor]
    P --> CMP[component system]
    AUTHC[AuthProvider] --> P
  end
  subgraph Backend
    CTL[controllers] --> SVC[services] --> PR[PrismaService]
    G[global guards+pipe+filter] --> CTL
    SCH[3 scheduler services] --> SVC
    AUD[AuditService] --> PR
  end
  H -->|fetch| G
```

## 3. Backend module diagram

```mermaid
graph TD
  APPM[AppModule] --> PRISMA[Prisma] & AUTH[Auth] & SET[Settings] & AUD[Audit]
  APPM --> ORG[Org] & ING[Ingestion] & TICK[Ticketing] & DEV[Devices]
  APPM --> RECO[Recommender] & SCHD[Scheduling] & BSS[BusinessSweepScheduler]
  APPM --> IDY[Intraday] & CZ[CrossZone] & SP[SharedPool] & PLN[Planner]
  APPM --> DASH[Dashboard] & REP[Reports] & SS[SoftState] & VER[Verification]
  APPM --> INV[Inventory] & CR[ComponentRequest] & ENG[Engineers] & RB[RoleBackup]
  APPM --> NOT[Notifications] & VOU[Vouchers] & EXP[Exports] & PD[PlantDeactivation]
  ING --> DSTATE[DeviceState] & TICK
  SCHD --> RECO
```

## 4. Frontend architecture

```mermaid
flowchart TD
  MAIN[main.tsx installAuthFetch] --> APP[App: AuthProvider + Router]
  APP --> ROUTES[AppRoutes]
  ROUTES --> LOGIN[/login/]
  ROUTES --> SHELL[ProtectedRoute + AdminShell]
  SHELL --> NAV[role-scoped Sidebar via buildNav]
  SHELL --> OUTLET[40 routed pages]
  OUTLET --> APIL[31 api modules]
  APIL --> HTTPI[401→refresh→retry interceptor]
  HTTPI --> TOK[sessionStorage tokens]
```

## 5. Database ER diagram (core; full set in 05)

```mermaid
erDiagram
  ZONE ||--o{ PLANT : has
  COMPANY ||--o{ VEHICLE : owns
  PLANT ||--o{ VEHICLE : hosts
  VEHICLE ||--o{ DEVICE : carries
  DEVICE ||--|| DEVICE_STATE : derives
  DEVICE ||--o{ FAILURE_CYCLE : episodes
  FAILURE_CYCLE ||--o| TICKET : parents
  TICKET ||--o{ RECOMMENDATION : scored
  TICKET ||--o{ TROUBLESHOOTING_SUBMISSION : forms
  TICKET ||--o{ VERIFICATION_RUN : verifies
  ENGINEER_MASTER ||--o{ WORK_SCHEDULE : dayplan
  WORK_SCHEDULE ||--o{ PLANT_BATCH_ASSIGNMENT : stops
  PLANT_BATCH_ASSIGNMENT ||--o{ BATCH_ASSIGNMENT_TICKET : orders
  TICKET ||--o{ BATCH_ASSIGNMENT_TICKET : placed
```

## 6. Authentication flow

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as AuthController
  B->>A: POST /auth/login
  A->>A: scrypt verify (in-memory store)
  A-->>B: 15m HS256 access + 30d rotating refresh
  B->>B: sessionStorage; proactive refresh at exp-60s
  B->>A: POST /auth/refresh (single-use token)
  A-->>B: rotated pair | 401 → session expired
```

## 7. Authorization flow

```mermaid
flowchart TD
  REQ[request] --> PUB{"Public route?"}
  PUB -->|yes| H[handler]
  PUB -->|no| T{valid Bearer}
  T -->|no| E401[401]
  T -->|yes| R{role in @Roles}
  R -->|no| E403[403]
  R -->|yes| Z{ZM targeting other zone}
  Z -->|yes| EZ[403 ZONE_SCOPE_VIOLATION]
  Z -->|no| H
```

## 8. Request lifecycle

```mermaid
flowchart LR
  IN[HTTP in] --> BP[json parser 1MB] --> CORS --> GG[guard chain] --> VP[ValidationPipe]
  VP --> CTRL[controller] --> SVC[service] --> TX[Prisma tx + audit row]
  TX --> OUT[JSON out]
  SVC -->|throw| FLT[AllExceptionsFilter] --> OUT2[sanitized error + correlation id]
```

## 9. API flow (typical mutation)

```mermaid
sequenceDiagram
  participant UI as Page component
  participant M as api module
  participant BE as controller/service
  participant DB as Postgres
  UI->>M: apiAction(token, dto)
  M->>BE: fetch POST + Authorization + X-Acting-As-Zone
  BE->>DB: withAudit(tx: mutation + audit_logs)
  DB-->>BE: committed
  BE-->>M: 200 JSON | 409 {code}
  M-->>UI: parsed result → refetch list + Toast
```

## 10. Business logic flow (device outage lifecycle)

```mermaid
flowchart TD
  SILENT[device silent >4h] --> BUCKET[sla_bucket ages WARNING→…→LONG_PENDING]
  BUCKET -->|>=24h + eligible| CYCLE[failure_cycle OPEN + ticket OPEN]
  CYCLE --> RECOMMEND[recommender SUGGESTED]
  RECOMMEND --> DISPATCH[day plan FORMALLY_ASSIGNED]
  DISPATCH --> FIELD[SE on-site + troubleshoot submit]
  FIELD --> VERIFY[3-phase GPS verification]
  VERIFY -->|pass| CLOSED[ticket CLOSED, cycle VERIFIED]
  VERIFY -->|fail| FAILEDV[FAILED_VERIFICATION → repeat/escalate]
  CLOSED -->|re-fail <24h| REPEAT[REPEAT cycle chain]
  BUCKET -->|CRITICAL intraday| INTRA[intraday insertion offer]
  FIELD -->|component missing| WAITC[WAITING_COMPONENT + SLA pause]
```

## 11. Data flow

```mermaid
flowchart LR
  AP[(AutoPlant)] --> MS[master sync] --> ORG[(org mirror)]
  AP --> SI[snapshot ingest] --> RAW[(raw_device_snapshots)]
  SI --> DS[(device_states)]
  DS --> TC[ticket creation] --> TKT[(tickets/cycles)]
  TKT --> RC[recommender] --> RECS[(recommendations)] --> BA[dispatch] --> WS[(work_schedules)]
  TKT --> AGG[aggregation services] --> CUBES[(report cubes)]
  DS --> DASHR[dashboards]
  CUBES --> REPR[reports]
```

## 12. Scheduler / cron architecture

```mermaid
flowchart TD
  subgraph P["Single Node process — @nestjs/schedule"]
    I1["ingestion-masters 0 2 * * *"] --> SYNCM[syncMastersTick]
    I2["ingestion-telemetry */30"] --> TEL[ingestTelemetry → recompute → ticket-create]
    B1["verification */5"] & B2["install-verification */5"] & B3["intraday-timeout */2"]
    B4["cross-zone */15"] & B5["repeat-escalation */15"] & B6["soft-inactive 6h/18h"]
    B7["system-efficiency daily 01:30"] & B8["fleet-uptime monthly"] & B9["root-cause monthly"] & B10["zm-performance monthly"]
    D1["dispatch 0 5 * * *"] --> DR[DispatchRunService]
    PM["partition-maintenance env cron"]
  end
  GATE1{{INGESTION_SCHEDULER_ENABLED + AutoPlant configured}} --> I1 & I2
  GATE2{{BUSINESS_SWEEPS_ENABLED}} --> B1 & B2 & B3 & B4 & B5 & B6 & B7 & B8 & B9 & B10 & D1
```

## 13. Queue / worker architecture

**There are no queues and no separate worker processes.** The "workers"
(SnapshotIngestionWorker, aggregation services) are plain injectable classes invoked by cron
ticks or HTTP triggers inside the API process. Serialization is done by DB partial-unique
in-flight guards, per-zone advisory locks, and in-memory sets — not by a broker.

```mermaid
flowchart LR
  TRIG[cron tick or HTTP trigger] --> GUARD{in-flight guard}
  GUARD -->|free| WORK[worker method in-process]
  GUARD -->|busy| SKIP[RUN_IN_PROGRESS skip]
  WORK --> LEDGER[(run ledger tables)]
```

## 14. External integrations

```mermaid
flowchart LR
  BE[backend] ---|live, VPN, <=90 rows/query| AP[(AutoPlant MySQL)]
  BE -.->|LoggingChannelGateway seam| N[Push / SMS / WhatsApp / Email]
  BE -.->|pgi_history seeded manually| SAP[SAP PGI]
  BE -.->|token link built, no SMTP| CUST[Customer confirm email]
```

## 15. Infrastructure diagram

```mermaid
flowchart TD
  DEVBOX[Single host] --> NODE[Node 20: API + cron]
  DEVBOX --> PGDB[(Postgres 16 + PostGIS)]
  DEVBOX --> STATIC[admin static bundle]
  NODE --- VPN[VPN] --- APDB[(AutoPlant MySQL)]
  MISSING[No Docker / CI / IaC / metrics / log-aggregation]:::warn
  classDef warn fill:#fee,stroke:#c00
```

## 16. Deployment architecture

```mermaid
flowchart LR
  DEVELOPER -->|pnpm build| ARTIFACTS[dist/ bundles]
  ARTIFACTS -->|manual copy + node dist/main.js| HOST[target host]
  HOST -->|prisma migrate deploy - manual| PGDB[(Postgres)]
  NOTE[No pipeline exists; deployment is entirely manual today]
```

## 17. Dependency graph (runtime composition)

```mermaid
graph TD
  main[main.ts] --> boot[validateBootConfig] --> appm[AppModule]
  appm --> guards[global guards/pipe/filter]
  appm --> modules[27 feature modules]
  modules --> prisma[PrismaService] --> pgadapter[adapter-pg → DATABASE_URL]
  modules --> mysqlc[AutoPlantMysqlClient - lazy pool]
  modules --> schedule[ScheduleModule.forRoot in IngestionModule]
```

## 18. Package dependency graph

```mermaid
graph TD
  shared[fsm-shared]
  backend[fsm-backend] --> shared
  admin[fsm-admin] --> shared
  mobile[fsm-mobile] --> shared
  backend --> nestjs[NestJS 10] & prismacl[Prisma 7 + pg] & mysql2[mysql2]
  admin --> react[React 18 + Router 6] & tailwind[Tailwind 4 + Radix] & recharts[Recharts]
  mobile --> expo[Expo 54 + RN 0.81]
```

## 19. Module dependency graph (backend, condensed)

```mermaid
graph LR
  Ingestion --> DeviceState --> Settings
  Ingestion --> Ticketing
  Ingestion --> Auth
  Scheduling --> Recommender
  BusinessSweeps --> Verification & Intraday & CrossZone & Reports & Ticketing
  Everything[all feature modules] --> Prisma
  Mutating[mutating modules] --> Audit
```

## 20. Complete end-to-end sequence

```mermaid
sequenceDiagram
  participant AP as AutoPlant
  participant SCH as Cron
  participant PIPE as Ingestion pipeline
  participant DB as Postgres
  participant DISP as Dispatch
  participant ZM as ZM (admin)
  participant SE as SE
  participant VER as Verification sweep
  participant REP as Report cubes
  SCH->>PIPE: telemetry tick (*/30)
  PIPE->>AP: read chunks (<=90)
  PIPE->>DB: raw snapshots + device_states + new tickets
  SCH->>DISP: 05:00 dispatch tick
  DISP->>DB: recommendations → work_schedules (Day Plan)
  ZM->>DB: overrides / manual assigns (audited)
  SE->>DB: soft states → troubleshoot submission (idempotent)
  VER->>AP: (via ingested pings) phase 1/2 checks
  VER->>DB: ticket CLOSED | FAILED_VERIFICATION; inventory DEDUCTED | ROLLED_BACK
  SCH->>REP: daily/monthly aggregation ticks
  REP->>DB: summary cubes
  ZM->>DB: dashboards + reports read derived tables
```
