# 10 — Dependency Graphs

## Workspace / package graph

```mermaid
graph TD
  subgraph npm["Third-party (key)"
  ]
    nest["@nestjs/common,core,platform-express,schedule 10.x"]
    prisma7["@prisma/client 7 + adapter-pg + pg"]
    mysql2["mysql2 (AutoPlant only)"]
    react18[react 18 + react-router 6 + vite 5]
    tw[tailwindcss 4 + radix + recharts + lucide]
    expo[expo 54 + react-native 0.81 + expo-router]
  end
  shared["@fsm/shared (zero runtime deps)"]
  backend["@fsm/backend"] --> shared
  backend --> nest
  backend --> prisma7
  backend --> mysql2
  admin["@fsm/admin"] --> shared
  admin --> react18
  admin --> tw
  mobile["@fsm/mobile"] --> shared
  mobile --> expo
```

Notable: backend has **no** auth library (hand-rolled JWT), **no** queue/cache/storage client,
**no** logging framework beyond Nest `Logger`. Test stacks: vitest+supertest (backend),
vitest+testing-library (admin), jest-expo (mobile).

## Backend module dependency graph (imports between Nest modules)

```mermaid
graph TD
  PRISMA[PrismaModule] 
  AUTHM[AuthModule] --> PRISMA
  SET[SettingsModule] --> PRISMA
  AUD[AuditModule] --> PRISMA
  ORG[OrgModule] --> PRISMA & AUD
  DSTATE[DeviceStateModule] --> PRISMA & SET
  TICK[TicketingModule] --> PRISMA & AUD
  ING[IngestionModule] --> AUTHM & DSTATE & SET & TICK
  ING -->|owns| SCHEDROOT[ScheduleModule.forRoot]
  RECO[RecommenderModule] --> PRISMA & SET
  SCHD[SchedulingModule] --> RECO & PRISMA & AUD
  BSS[BusinessSweepSchedulerModule] --> VERM & IDY & CZ & TICK & REPM
  IDY[IntradayModule] --> PRISMA & AUD & NOTIF
  CZ[CrossZoneModule] --> PRISMA & AUD
  VERM[VerificationModule] --> PRISMA & TICK
  INV[InventoryModule] --> PRISMA & AUD
  CREQ[ComponentRequestModule] --> PRISMA & AUD & NOTIF
  ENGM[EngineersModule] --> PRISMA & AUD
  NOTIF[NotificationsModule] --> PRISMA
  REPM[ReportsModule] --> PRISMA
  DASH[DashboardModule] --> PRISMA
  DEVM[DevicesModule] --> PRISMA
  SSM[SoftStateModule] --> PRISMA & AUD
  PLAN[PlannerModule] --> PRISMA & AUD
  SPOOL[SharedPoolModule] --> PRISMA
  RB[RoleBackupModule] --> PRISMA & AUD
  VOU[VouchersModule] --> PRISMA & AUD & NOTIF
  EXP[ExportsModule] --> PRISMA & AUD
  PDEACT[PlantDeactivationModule] --> PRISMA & AUD
```

(Edge set reconstructed from module `imports:` arrays; PrismaModule is global-ish — imported
everywhere data is touched. The pipeline chain Ingestion→DeviceState→Ticketing is acyclic:
Ticketing imports only Prisma+Audit, so IngestionModule importing TicketingModule creates no cycle
— stated and verified at `ingestion.module.ts:63-64`.)

## Service-level pipeline dependencies

```mermaid
graph LR
  ISS[IntegrationSyncService] --> MSS[MasterSyncService]
  ISS --> SIW[SnapshotIngestionWorker]
  ISS --> DSS[DeviceStateService]
  ISS --> TCS[TicketCreationService]
  SIW --> SRS[SnapshotRunService]
  SIW --> SIS[SnapshotIngestionService as ChunkWriter]
  SIW --> SR[SOURCE_READER token]
  MSS --> MSRC[MASTER_SYNC_SOURCE token]
  MSS --> PZR[PLANT_ZONE_RESOLVER → MappingTableZoneResolver]
  DRS[DispatchRunService] --> RSVC[RecommenderService]
  DRS --> BAS[BatchAssignmentService]
  RSVC --> CSS[CandidateSelectionService]
  RSVC --> IVS[InventoryService]
  RSVC --> SAS[SeAvailabilityService]
  RSVC --> SIC[SoftInactiveCountService]
```

## Frontend dependency layers

```mermaid
graph TD
  pages[pages/*] --> apimods[api/* modules]
  pages --> comps[components: ui, data, overlay, charts, domain]
  pages --> authc[auth/AuthProvider context]
  apimods --> http[api/http.ts interceptor] --> tokens[api/tokens.ts sessionStorage]
  shell[components/shell + nav.ts] --> authc
  comps --> lib[lib: cn, csv, slaBucket, plantNames, inactiveDuration]
  apimods --> sharedpkg["@fsm/shared (auth DTOs only)"]
```

## Circular dependencies

None found at module level. The one intentional near-cycle (Ingestion→Ticketing while the
pipeline conceptually feeds back) is broken by TicketingModule's narrow import set. Frontend has
no cycles (pages → api/components one-way).
