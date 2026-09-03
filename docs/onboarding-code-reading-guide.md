# How to Read This Codebase — A Field Guide for New Developers

> **Who this is for:** a developer who has just been handed this repo and cannot yet answer
> *"where does this code start, and where does the flow go next?"*
>
> **What it is:** a navigation manual, not a spec. It tells you which file to open, in what order,
> and what to expect inside it. Every path in here is real and was checked against the tree.
>
> **What it is not:** the current-state doc. That is `docs/SYSTEM-STATE-2026-07.md`, which tells you
> what is *built and working today*. This document tells you how to *read* what is built.

---

## Table of contents

| # | Section | Read it when |
|---|---|---|
| 0 | [How to use this document](#0-how-to-use-this-document) | Now |
| 1 | [What the system does, in one page](#1-what-the-system-does-in-one-page) | Before any code |
| 2 | [The repository map](#2-the-repository-map) | Day 1 |
| 3 | [Backend — NestJS in ten minutes](#3-backend--nestjs-in-ten-minutes) | Day 1 |
| 4 | [Backend — the boot sequence](#4-backend--the-boot-sequence) | Day 1 |
| 5 | [Backend — anatomy of a feature module](#5-backend--anatomy-of-a-feature-module) | Day 2 |
| 6 | [Backend — a full request, traced end to end](#6-backend--a-full-request-traced-end-to-end) | Day 2 |
| 7 | [Backend — the guard chain (who is allowed in)](#7-backend--the-guard-chain-who-is-allowed-in) | Day 2 |
| 8 | [Backend — the data layer (Prisma)](#8-backend--the-data-layer-prisma) | Day 3 |
| 9 | [Backend — the background lifecycle (crons)](#9-backend--the-background-lifecycle-crons) | Day 3 |
| 10 | [The domain pipeline — the ten stages](#10-the-domain-pipeline--the-ten-stages) | Day 3–4 |
| 11 | [Frontend — the admin dashboard](#11-frontend--the-admin-dashboard) | Day 5 |
| 12 | [Frontend — the mobile app](#12-frontend--the-mobile-app) | Later |
| 13 | [Navigation recipes](#13-navigation-recipes) | Every day, forever |
| 14 | [Tests are the documentation](#14-tests-are-the-documentation) | Day 4 |
| 15 | [Running it locally](#15-running-it-locally) | Day 1 |
| 16 | [Glossary](#16-glossary) | Keep open |
| 17 | [A two-week reading plan](#17-a-two-week-reading-plan) | Now |
| 18 | [Habits — how to stay in the flow](#18-habits--how-to-stay-in-the-flow) | Now |

---

## 0. How to use this document

Three rules, and they matter more than anything else in here.

**Rule 1 — Never read a codebase file-by-file. Read it path-by-path.**
There are 331 hand-written TypeScript files in the backend and 222 in the admin app. If you open
them alphabetically you will learn nothing and quit on day two. Instead you pick *one thing a user
does* — "a manager opens the ticket list" — and you follow that single thread from the button in the
browser to the SQL and back. One thread teaches you the shape of all of them, because this codebase
is extremely repetitive by design: every feature is built the same way.

**Rule 2 — This codebase explains itself. Read the block comments.**
Almost every service and every non-obvious decision in this repo carries a docstring that says
*why*, often citing the issue number that caused it (`#238`, `#262`, …). Those comments are the
single highest-value thing in the tree. When you open a file, read the class-level `/** … */` block
**first and fully**, then decide whether you need the body at all. Frequently you do not.

**Rule 3 — When lost, go up one level to the module file.**
Every backend folder has an `X.module.ts`. It is a table of contents for the folder: what it
imports (its dependencies), what it provides (its services), and what it exports (what other
folders may use). If you are ever disoriented inside a folder, open the `.module.ts`.

---

## 1. What the system does, in one page

A GPS device-fitment business puts tracker devices on customer trucks at plants. Devices sometimes
stop reporting. This platform detects that, opens a repair job, picks the right field engineer,
sends them a day plan, and proves the fix actually worked.

The whole product is one funnel, and **every module in the backend is a stage of this funnel**:

```
   AutoPlant MySQL  (an external, read-only system reached over VPN)
          │
          │  masters daily · telemetry every 30 min
          ▼
   [a] Master sync ──────► companies, plants, vehicles, transporters, devices
          ▼
   [b] Snapshot ingestion ► raw_device_snapshots (who pinged, when, from where)
          ▼
   [c] Device-state recompute ► device_states (is this device silent? for how long? how bad?)
          ▼
   [d] Auto-recovery check ► device came back on its own → close the job, nobody was dispatched
          ▼
   [e] Ticket creation ────► silent + eligible + no open job → failure_cycle + ticket
          ▼
   [f] Recommender ────────► for each ticket, which engineers *can* do it, and which is *best*
          ▼
   [g] Batch dispatch ─────► group per engineer per plant → a Day Plan the engineer sees
          ▼
   [h] Field loop ─────────► engineer travels, troubleshoots, submits a form, uses parts
          ▼
   [i] Verification ───────► did the device start pinging again? → close / partial / failed
          ▼
   [j] Reports ────────────► fleet uptime %, root cause, engineer efficiency, manager scorecards
```

Two front-ends sit on top of that backend:

- **Admin web dashboard** (`apps/admin/`) — what managers use. Fully built.
- **SE mobile app** (`apps/mobile/`) — what field engineers will use. **Auth shell only today**;
  login + session + a component kit exist, the actual screens do not.

The contractual goal of the whole system is one number: **≥98% Fleet Uptime**, measured monthly.

---

## 2. The repository map

This is a **pnpm workspace monorepo** (`pnpm-workspace.yaml`) driven by **Turborepo** (`turbo.json`).
Three apps and one shared package.

```
fsm-platform-backup/
├── CLAUDE.md            ← rules for AI agents working here; also a fast orientation for humans
├── CONTEXT.md           ← THE domain dictionary + 21 numbered business decisions. 144 KB.
│                          The single highest authority on what a word means in this system.
├── apps/
│   ├── backend/         ← NestJS modular monolith. 331 hand-written .ts + 85 generated.
│   │   ├── src/         ← 38 top-level folders, one per domain concern
│   │   ├── prisma/      ← schema.prisma (2,909 lines) + 94 SQL migrations
│   │   ├── test/        ← 426 test files (368 e2e, 58 unit)
│   │   └── scripts/     ← test runner, build stamper, db reset
│   ├── admin/           ← React 18 + TypeScript + Vite SPA. 84 pages, 45 API modules.
│   └── mobile/          ← React Native + Expo. Auth shell + UI kit only.
├── packages/
│   └── shared/          ← types shared between backend and both clients (`@fsm/shared`)
└── docs/                ← see below
```

### Which doc to trust, in what order

The project has a strict authority ladder (`docs/agents/domain.md`). Memorise it:

1. **`CONTEXT.md`** — domain language and business decisions. Beats everything.
2. **`docs/PRD-fsm-admin-dashboard.md`** — product requirements.
3. **`docs/backend/fsm-backend-low-level-design.md`** — the backend LLD. Code comments cite it as "LLD §13.1".
4. **`docs/backend/fsm-database-schema-blueprint.md`** — schema design.
5. **`docs/adr/`** — architecture decision records. **Historical only.** An ADR can be superseded and
   several are; never treat one as current.

Then two living documents that are updated as reality changes:

- **`docs/SYSTEM-STATE-2026-07.md`** — what is actually built, with evidence. Start here for "does X exist?"
- **`.scratch/fsm-platform-v1/INDEX.md`** — the work tracker. Build order, issue statuses, session log.

And two useful reference dumps:

- **`docs/codebase-complete-analysis.md`** (3,491 lines) — a module-by-module inventory. Use it as a
  lookup table, not a read-through.
- **`docs/progress/<issue>.md`** — one completion report per issue. When a comment says `#238`, the
  full story is in `docs/progress/238-*.md`. **This is the fastest way to understand a weird decision.**

---

## 3. Backend — NestJS in ten minutes

You cannot read this backend without NestJS. But you only need six concepts. Everything else is
detail you can look up when you meet it.

### 3.1 The six concepts

| Concept | What it is | How to spot it |
|---|---|---|
| **Module** | A folder's manifest — what it needs, what it owns, what it lends out | `@Module({ imports, providers, exports })` in `*.module.ts` |
| **Controller** | Maps HTTP URLs to functions. Contains **no logic** — it parses input and calls a service | `@Controller('tickets')` in `*.controller.ts` |
| **Service** | Where the actual work happens. Talks to the database | `@Injectable()` in `*.service.ts` |
| **Dependency Injection** | You never write `new SomeService()`. You declare it in a constructor and Nest hands you the shared instance | `constructor(private readonly query: TicketQueryService) {}` |
| **Decorator** | The `@Something` annotations. They attach metadata that Nest reads at boot | `@Get()`, `@Roles()`, `@Cron()` |
| **Guard** | A gate that runs *before* the controller and can reject the request | `implements CanActivate` |

### 3.2 The one mental model that makes DI click

Read this constructor from `apps/backend/src/ticketing/tickets.controller.ts:31`:

```ts
export class TicketsController {
  constructor(
    private readonly query: TicketQueryService,
    private readonly autoRecovery: AutoRecoveryService,
    private readonly special: SpecialTicketQueryService,
  ) {}
```

Nobody ever calls `new TicketsController(...)`. At boot, Nest reads this constructor's *types*,
finds who `provides` each of them (search for `TicketQueryService` in a `providers:` array — it is
in `ticketing/ticketing.module.ts`), constructs them once, and passes them in. That is the whole
trick.

**The consequence for reading:** when you see `this.query.list(...)`, the definition of `list` is in
whatever class the constructor named `query` — here `TicketQueryService`, i.e.
`ticketing/ticket-query.service.ts`. The constructor is your jump table. Always look there first.

### 3.3 The rule about `exports`

A module can only inject a service from another module if **that other module `exports` it** and
**this module `imports` that module**. Get it wrong and the app throws at boot with "Nest can't
resolve dependencies of X". There is a real war story about this in `ticketing.module.ts:71-73` —
a provider left out of `exports` killed 122 tests the moment the full app assembled.

---

## 4. Backend — the boot sequence

**Open `apps/backend/src/main.ts` and read all 50 lines. It is the true entry point.**

Here is what happens, in order:

```
1. validateBootConfig()          config/boot-config.ts
   ↳ Refuse to start on a missing/unsafe JWT secret or a bad DATABASE_URL. Fail loudly, early.

2. new PrismaService(); onModuleInit()
   ↳ A throwaway "preflight" Prisma connection whose only job is to run the build guard —
     if the compiled build is stale relative to the DB schema, die now, not in the middle of a request.

3. NestFactory.create(AppModule, { bodyParser: false })
   ↳ THIS is where the whole app is constructed. Nest reads AppModule, walks every imported module,
     constructs every service in dependency order, registers every controller route, and mounts
     every @Cron job. When this line returns, the entire application graph exists in memory.

4. app.enableShutdownHooks()
   ↳ So Ctrl-C / SIGTERM actually closes the DB pool instead of hard-killing the process.

5. configureApp(app)             app.config.ts
   ↳ Global prefix `/api`, URI versioning (`/api/v1/...` AND `/api/...` both work — deliberate,
     it is a migration window), CORS, a 1 MB JSON body limit.

6. app.listen(PORT ?? 3000)
   ↳ HTTP server up.

7. DispatchScheduleService.applyStoredSchedule()
   ↳ Applies the operator's saved cron expression to the live dispatch job. Must be AFTER listen()
     for a framework-ordering reason the comment explains in full. Read that comment — it is a
     perfect example of the kind of subtlety this codebase documents rather than hides.
```

Then **open `apps/backend/src/app.module.ts`**. Don't read it top to bottom — it is 230 lines of
imports. Read only the three arrays at the bottom:

- **`imports:`** — the 30 feature modules. **This is the master list of what the backend does.**
- **`controllers:`** — ~60 controllers registered globally. Note the comment on
  `AssignmentThresholdController`: *registration order is load-bearing*, because Nest matches routes
  in order and a static path must be registered before a parameterised one that would swallow it.
- **`providers:`** — the four global cross-cutting pieces:
  - `AllExceptionsFilter` — turns any uncaught error into a sanitised 500 with a correlation id
  - `AuthGuard` → `RoleGuard` → `ZoneScopeGuard` — the security chain, applied to **every** route
  - `ValidationPipe` — validates and strips DTO request bodies

> **Key insight:** because those guards are registered globally, **every route is authenticated by
> default**. A route is public only if it is explicitly marked `@Public()`. That inversion — secure
> by default, opt out deliberately — is why forgetting a decorator can't accidentally expose an
> endpoint.

---

## 5. Backend — anatomy of a feature module

Every feature folder follows the same four-file pattern. Learn it once, and all 38 folders are
readable.

Take `apps/backend/src/ticketing/` as the reference:

```
ticketing/
├── ticketing.module.ts             ← the manifest. START HERE, always.
├── tickets.controller.ts           ← HTTP routes: GET /api/tickets, GET /api/tickets/:id …
├── ticket-query.service.ts         ← READ logic (list, detail, filters)
├── ticket-creation.service.ts      ← WRITE logic (opens failure cycles + tickets)
├── auto-recovery.service.ts        ← one more piece of behaviour
├── ...
└── ticket-no.ts, deferral.ts,      ← pure helper functions. No decorators, no DB.
    sla-pause.ts, component-blocked.ts   Easiest files in the repo — read these first.
```

### The naming convention, which is your search index

| Suffix | Meaning | Has DB access? | Has HTTP routes? |
|---|---|---|---|
| `*.module.ts` | Wiring manifest | no | no |
| `*.controller.ts` | HTTP surface | no (delegates) | **yes** |
| `*.service.ts` | Business logic | **yes** | no |
| `*.scheduler.service.ts` / `*-scheduler.service.ts` | A cron job wrapper | via services | no |
| `*-query.service.ts` | Read-only queries | yes (SELECT) | no |
| bare `*.ts` (e.g. `sla-bucket.ts`) | Pure function, no framework | **no** | no |

**Read the bare files first.** `common/ist-day.ts`, `device-state/sla-bucket.ts`,
`recommender/distance.ts`, `ticketing/ticket-no.ts` — these are small, pure, dependency-free, and
they teach you the domain vocabulary with zero framework noise.

### The size ladder — where to start and where not to

| Folder | Files | Read it… |
|---|---|---|
| `zones/`, `health/`, `config/`, `me/` | 1–3 | **First.** Trivially small, complete examples. |
| `dashboard/`, `devices/`, `audit/`, `soft-state/` | 4–6 | Second. Real but contained. |
| `auth/`, `recommender/`, `reports/`, `engineers/` | 9–12 | Third. |
| `ingestion/` (30), `org/` (32), `ticketing/` (33) | 30+ | Fourth. |
| `scheduling/` | **44** | **Last.** The hardest folder in the repo. |
| `generated/` | 85 | **Never.** Machine-generated Prisma client. Never edit, never read. |

---

## 6. Backend — a full request, traced end to end

This is the single most important section. Follow it with the files open beside you.

**The scenario:** a Zonal Manager loads the ticket list in the browser.

### Step 0 — The browser

`apps/admin/src/pages/tickets/TicketsPage.tsx` calls `apiTicketsList(filters)`.

### Step 1 — The frontend API module

`apps/admin/src/api/tickets.ts` builds the URL and issues `fetch`:

```
GET http://localhost:3000/api/tickets?status=OPEN&bucket=CRITICAL
Authorization: Bearer <jwt>
```

### Step 2 — The global fetch interceptor

`apps/admin/src/api/http.ts` has wrapped `window.fetch` at app start (`installAuthFetch()` in
`main.tsx`). Every request passes through it. **On a 401 it silently refreshes the token and retries
the original request once.** If the refresh fails, it clears the session and bounces to login.
This is why no individual API module contains auth-retry logic.

### Step 3 — Nest routing

`app.config.ts` set the global prefix, so `/api/tickets` resolves to `@Controller('tickets')` +
`@Get()` — i.e. `TicketsController.list()` in `ticketing/tickets.controller.ts:40`.

### Step 4 — The guard chain runs (before the handler)

```
AuthGuard        common/guards/auth.guard.ts
  ↳ Is there a `@Public()` marker? No.
  ↳ Read `Authorization: Bearer …`, verify the JWT via TokenService.
  ↳ On success ATTACH the claims to `request.user`. ← everything downstream depends on this.
  ↳ On failure → 401.

RoleGuard        common/guards/role.guard.ts
  ↳ Read the `@Roles('ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD')` on the handler.
  ↳ Is `request.user.role` in that list? No → 403.

ZoneScopeGuard   common/guards/zone-scope.guard.ts
  ↳ Only applies to ZONAL_MANAGER. If the URL names a zone they don't own → 403 ZONE_SCOPE_VIOLATION.
  ↳ Cross-zone roles (CSM, Operations Head, Warehouse) pass straight through.
```

### Step 5 — Parameter decorators resolve

```ts
list(
  @CurrentUser() user: AccessTokenClaims,   // ← reads request.user that AuthGuard attached
  @Query('status') status?: string,
  @Query('bucket') bucket?: string,
  …
)
```

`@CurrentUser()` is defined in `common/decorators/current-user.decorator.ts` — three lines. There
are two siblings you will meet constantly:

- **`@CurrentScope()`** — `{ role, zoneId }` with the `X-Acting-As-Zone` header folded in. Use for **reads**.
- **`@CurrentActor()`** — the caller's real role *plus* acting attribution. Use for **audited writes**,
  so the audit row records that a CSM was acting as a ZM.

> Getting `@CurrentUser` vs `@CurrentScope` wrong is a classic bug here: `@CurrentUser` **ignores the
> acting-zone header**, so a CSM acting as a ZM would silently see the wrong zone.

### Step 6 — The controller delegates immediately

```ts
return this.query.list(
  { role: user.role, zoneId: user.zone_id },
  { status, workType, companyId, ..., limit: Number(limit) },
);
```

Note the shape: **scope object first, filters object second**. That pairing repeats across the
whole codebase. Note also that the controller does **nothing else** — no branching, no SQL, no
business rules. If you ever find logic in a controller here, it is out of place.

### Step 7 — The service does the work

`ticketing/ticket-query.service.ts:301` — `async list(scope, filters)`.

It builds a `Prisma.Sql[]` array of conditions, one per filter, and each one is parameterised:

```ts
if (scope.role === 'ZONAL_MANAGER' && scope.zoneId !== null)
  conds.push(Prisma.sql`AND p.zone_id = ${BigInt(scope.zoneId)}`);
```

**Two things to notice, because they are conventions you will see everywhere:**

1. **Zone scoping is enforced *again* in the query**, not just in the guard. The guard blocks
   *explicitly targeting* another zone; the query clamps *what comes back*. Defence in depth.
2. `Prisma.sql` template literals are **parameterised** — the `${}` values become bind parameters,
   not string concatenation. This is safe. Raw string interpolation into SQL would not be.

### Step 8 — Prisma to Postgres

`prisma/prisma.service.ts` holds the one shared, pooled connection for the whole process
(`@Global()` module → every feature module gets the same instance). Pool max 25, 5 s acquire
timeout, 120 s statement timeout, session timezone pinned to **UTC**. The docstring explains every
one of those numbers — read it once; it is a masterclass in why defaults are dangerous.

### Step 9 — The response comes back

`TicketView[]` — note in the interface that **BigInt ids are serialised to strings**, because JSON
cannot represent BigInt. You will see `String(row.ticket_id)` conversions all over the read
services for this reason.

### Step 10 — If anything threw

`common/filters/all-exceptions.filter.ts` catches it, returns a sanitised 500 with a correlation
id, and preserves deliberate `HttpException` contracts like `{ code: 'TICKET_NOT_FOUND' }` verbatim.

### The trace as one line

```
TicketsPage.tsx → api/tickets.ts → http.ts (fetch wrapper) → [NETWORK]
  → AuthGuard → RoleGuard → ZoneScopeGuard → TicketsController.list()
  → TicketQueryService.list() → PrismaService → Postgres → back up the same stack
```

**Every single read endpoint in this backend follows exactly this path.** Trace it once, carefully,
and you can read all 249 routes.

---

## 7. Backend — the guard chain (who is allowed in)

Five roles exist. They are in `prisma/schema.prisma:18` and they never change:

```
SERVICE_ENGINEER · ZONAL_MANAGER · CENTRAL_SERVICE_MANAGER · OPERATIONS_HEAD · WAREHOUSE_MANAGER
```

The authority hierarchy is `Operations Head → Central Service Manager → Zonal Manager`, and backup
cascades **up** the chain (CONTEXT.md Decision §15). A CSM covering for an absent ZM is "acting",
which is why acting attribution exists in the decorators.

Three URL families tell you the intended audience at a glance — this is a naming convention worth
memorising:

| Prefix | Audience | Example controller |
|---|---|---|
| `/api/me/*` | **The logged-in SE**, own data only | `me-tickets/me-tickets.controller.ts` |
| `/api/org/*` | **Configuration**, Operations Head owned | `org/zones.controller.ts` |
| everything else | Manager operational surfaces | `ticketing/tickets.controller.ts` |

There are exactly four kinds of tokenless (`@Public()`) surfaces, and the list is pinned by a test
(`test/global-guard-validation.e2e-spec.ts`) so it cannot grow by accident:

1. login / refresh / logout (`auth/auth.controller.ts`)
2. health probes
3. the customer non-op confirmation link (an external party with no account)
4. — nothing else.

---

## 8. Backend — the data layer (Prisma)

### The three files that matter

| File | What it is |
|---|---|
| `prisma/schema.prisma` | **The data model.** 2,909 lines. ~120 models, ~60 enums. |
| `prisma/migrations/` | **94 hand-written SQL migrations**, applied in filename order. |
| `src/generated/prisma/` | The generated client. **Never edit. Never read.** |

### How to read `schema.prisma` without drowning

Don't read it linearly. Use it as a lookup:

```bash
# List every model and enum with its line number — your index
grep -n '^model \|^enum ' apps/backend/prisma/schema.prisma
```

Then jump to the ones you need. Every model has a `@@map("snake_case_name")` giving its real table
name, and every field has `@map(...)`. **The code says `deviceState`, the database says
`device_states`.** Both spellings appear — camelCase in Prisma calls, snake_case in raw SQL.

Many models carry a `///` doc comment above them explaining the business rule they encode. Read
those; they are as valuable as the code comments.

### The models to learn first (in this order)

```
Zone, Plant, Company, Region, District   ← geography and customers
User, EngineerMaster, SeCoverage         ← people and who covers what
Device, Vehicle, DeviceState             ← the fleet and its health
FailureCycle, Ticket, TicketEvent        ← the work
Recommendation, WorkSchedule,            ← the dispatch chain
  PlantBatchAssignment, BatchAssignmentTicket
```

`DeviceState` is the hub of the whole system. Almost everything reads it.

### Two query styles, and when each is used

```ts
// 1. Prisma's typed API — for straightforward reads and all writes
await this.prisma.deviceState.findMany({ where: { isInactive: true } });

// 2. Parameterised raw SQL — for multi-join reads, aggregates, and set-based recomputes
await this.prisma.$queryRaw`SELECT ... FROM device_states ds JOIN plants p ...`;
```

Raw SQL is not a smell here — it is deliberate. `DeviceStateService` explains why: recomputing the
whole fleet with a per-row loop was replaced by two set-based statements. When you see raw SQL,
expect a comment saying why.

### Migrations — the rule you must not break

> **The database schema is changed by writing a migration, never by editing `schema.prisma` alone.**

A migration is a folder like `prisma/migrations/20260825140000_dispatch_zone_recovery/` containing
`migration.sql`. They apply in timestamp order and are **immutable once committed** — you never edit
an applied migration; you write a new one.

`npx prisma migrate deploy` applies pending migrations. There is known cosmetic drift between the
hand-written migrations and `schema.prisma` (18 renamed indexes, 1 renamed FK) — documented at the
top of `SYSTEM-STATE-2026-07.md`. Don't panic when `prisma migrate diff` is non-empty; it is
tracked.

---

## 9. Backend — the background lifecycle (crons)

**Half of this system never receives an HTTP request.** It runs on a schedule. If you only read
controllers you will understand less than half the product.

Crons use `@nestjs/schedule` **in-process** — there is no Redis, no BullMQ, no external queue. A
`@Cron('...')` decorator on a method makes Nest call that method on that schedule.

```bash
# Find every scheduled job in the system
grep -rn "@Cron(" apps/backend/src --include=*.ts
```

There are 20 of them, in five families:

| Family | File | Master switch | What it does |
|---|---|---|---|
| **Ingestion** (2) | `ingestion/autoplant/integration-scheduler.service.ts` | `INGESTION_SCHEDULER_ENABLED` | Pull masters daily, telemetry every 30 min |
| **Partitions** (1) | `ingestion/partition-maintenance.service.ts` | `PARTITION_MAINTENANCE_ENABLED` | Create tomorrow's snapshot partition |
| **Business sweeps** (11) | `scheduling/business-sweep-scheduler.service.ts` | `BUSINESS_SWEEPS_ENABLED` | Verification, cross-zone, escalation, all the report cubes |
| **Dispatch** (3) | `scheduling/dispatch-scheduler.service.ts` | `BUSINESS_SWEEPS_ENABLED` | The daily 05:00 IST run + a reaper + a recovery pass |
| **Misc** (3) | plant-eligibility refresh, schedule closure, vehicle-return resume | various | |

**Three things to understand about the cron design:**

1. **Everything is env-gated and OFF by default.** Turning a sweep on is an operations decision, not
   a deploy. `BUSINESS_SWEEPS_ENABLED` is currently `true` in the dev `.env`; the ingestion ones are `false`.
2. **The business timezone is IST.** `BUSINESS_TIMEZONE` in `scheduling/dispatch-cron.ts`. The
   operating day is the IST calendar day (CONTEXT.md Decision §19), while the *database* stores
   everything in UTC. Timezone confusion is a recurring bug class here — one test was red only
   between 00:00 and 05:30 IST because of exactly this.
3. **Ticks are claimed, not assumed.** `scheduling/cron-tick-claim.service.ts` exists so that if two
   processes ever run, only one executes a given tick.

### The one cron worth reading in full

`scheduling/dispatch-scheduler.service.ts` → `DispatchRunService` → `BatchAssignmentService`. This is
the daily 05:00 IST run that turns every open unassigned ticket into engineers' day plans. It is
the heart of the product. Read `batch-assignment.service.ts`'s class docstring especially — the
"#262 — the write unit is the SE, not the zone" paragraph explains a real production failure mode
and is the single best example in the repo of *why* code looks the way it does.

---

## 10. The domain pipeline — the ten stages

Now map the funnel from §1 onto real files. **This table is the thing to pin above your desk.**

| # | Stage | Entry file | Writes to | Notes |
|---|---|---|---|---|
| a | **Master sync** | `ingestion/autoplant/master-sync.service.ts` | `companies`, `plants`, `vehicles`, `transporters`, `devices` | Only ACTIVE plants + DEPLOYED devices. Zone resolved via `zone_mapping`, else `UNZONED`. |
| b | **Snapshot ingestion** | `ingestion/snapshot-ingestion.worker.ts` | `raw_device_snapshots` (daily partitions) | Keyset-paginated reader, chunked, per-chunk retry ×3. A failed chunk does **not** abort its siblings. Run status: `SUCCESS`/`PARTIAL`/`FAILED`. |
| c | **Device-state recompute** | `device-state/device-state.service.ts` | `device_states` | Two set-based SQL statements. Derives `inactivity_hours`, `is_inactive`, `sla_bucket`, `eligible_for_uptime`, `is_departed`. |
| d | **Auto-recovery** | `ticketing/auto-recovery.service.ts` | closes tickets `CLOSED_AUTO_RECOVERY` | Device healed itself. Runs *before* creation so a device can't be ticketed and closed on the same tick. |
| e | **Ticket creation** | `ticketing/ticket-creation.service.ts` | `failure_cycles` + `tickets` | One transaction. A partial-unique index backstops duplicates. |
| f | **Recommender** | `recommender/recommender.service.ts` | `recommendations` (`SUGGESTED`) | 1,195 lines — the biggest service. Hard filters → scoring → canonical sort. |
| g | **Batch dispatch** | `scheduling/batch-assignment.service.ts` | `work_schedules`, `plant_batch_assignments`, `batch_assignment_tickets` | Per-SE transaction, advisory-locked per zone, idempotent. |
| h | **Field loop** | `soft-state/`, `ticketing/troubleshoot-submission.service.ts`, `intraday/`, `cross-zone/`, `inventory/`, `component-request/` | many | The largest surface area; not one file. |
| i | **Verification** | `verification/` | ticket → `CLOSED` / `PARTIAL_RECOVERY` / `FAILED_VERIFICATION` | ≥3 pings, ≥15 min span, ≥1 h stability, first ping within ±500 m. |
| j | **Reports** | `reports/` | monthly/daily summary cubes | Fleet uptime, root cause, ZM scorecard, system efficiency. |

### Stage f deserves its own paragraph

The Recommender is where the domain lives. Its folder decomposes cleanly, and the **helper files are
readable on their own** even though the main service is not:

```
recommender/
├── hard-filters.ts        ← who is DISQUALIFIED (availability, coverage, capacity, components)
├── scoring.ts             ← how a qualified candidate is scored
├── scoring-config.ts      ← the weights, read from the DB so ops can tune them
├── canonical-sort.ts      ← Company Tier → Device Bucket → Priority Rank → Oldest → Device ID
├── distance.ts            ← haversine. 20 lines. Read this first.
├── plant-geometry.ts      ← plant coordinates
├── tier-score-chooser.ts  ← pick within a tier cell
└── recommender.service.ts ← 1,195 lines that orchestrate all of the above
```

**Read them in exactly that order — bottom-up.** By the time you reach the big file you will
recognise every function it calls, and it stops being intimidating.

The two-level structure to understand: **hard filters are binary** (you are eligible or you are
not — no score can rescue you), and **scoring only ranks the survivors**. Mixing those two ideas up
is the most common misreading of this module.

---

## 11. Frontend — the admin dashboard

### The layer cake

```
main.tsx                    ← installs the fetch interceptor + theme, mounts React
  └── App.tsx               ← AuthProvider > BrowserRouter > ToastProvider > AppRoutes
       └── AppRoutes.tsx    ← THE ROUTE TABLE. Your index of every page in the product.
            └── ProtectedRoute → AdminShell → <Outlet/> → a page component
                 └── pages/<area>/<Thing>Page.tsx
                      └── api/<thing>.ts        ← typed fetch wrapper
                           └── [backend]
```

### Where to start: `AppRoutes.tsx`

**This file is the frontend's `app.module.ts`.** Every URL, every page component, and every role
restriction is declared in one place. Reading it takes ten minutes and gives you the whole product
map. It also carries useful comments (`#273` — why the Assign console replaced seven scattered
surfaces; `#285` — why Today's Dispatch exists alongside four older dispatch pages).

Three route wrappers do the access control, mirroring the backend guards:

- **`ProtectedRoute`** (`auth/ProtectedRoute.tsx`) — logged in? Else → `/login`.
- **`RoleRoute`** (`auth/RoleRoute.tsx`) — `roles={[...]}`, the client-side mirror of `@Roles()`.
- **`AdminShell`** (`components/AdminShell.tsx`) — nav + header + `<Outlet/>` for the active page.

> Client-side role checks are **UX only**. The backend guard is the real enforcement. Never assume a
> `RoleRoute` protects data.

### The folder convention

```
apps/admin/src/
├── api/          45 modules, one per backend area. Typed fetch wrappers + response interfaces.
├── pages/        84 page components, grouped by area (tickets/, dispatch/, reports/, settings/…)
├── components/
│   ├── ui/       primitives: Button, Badge, Card, Dialog…
│   ├── data/     DataTable, FilterSelect, EmptyState, PageHeader, SearchInput, Toast
│   ├── domain/   FSM-specific: StatusPill, TierBadge, AgeChip
│   ├── charts/   Recharts wrappers: TrendChart, DonutChart, BarList
│   └── shell/    AppShell, TopBar
├── hooks/        useApiResource, useAsyncAction — the two hooks every page uses
├── lib/          pure helpers: slaBucket, datetime, csv, plantNames, capacity, kpiCatalog
└── auth/         AuthProvider, ProtectedRoute, RoleRoute
```

### The two hooks that explain every page

`hooks/index.ts` is ~100 lines and worth reading in full:

- **`useApiResource(fetcher, deps)`** → `{ data, loading, error, refetch }`. The standard read.
- **`useAsyncAction(fn)`** → `{ run, pending, error }`. The standard write, bindable to a button's
  `loading` prop.

Once you know these two, most pages read as: *fetch with one, mutate with the other, render a
`DataTable`.*

### Session handling — the one clever bit

Three files cooperate and you should read them together:

| File | Job |
|---|---|
| `api/tokens.ts` | Stores the access + refresh tokens |
| `api/http.ts` | Wraps `window.fetch`. On 401 → **single-flight** refresh → retry once → else log out |
| `auth/AuthProvider.tsx` | Session context; also schedules a **proactive** refresh ~1 min before expiry |

"Single-flight" means ten concurrent 401s trigger **one** refresh call, not ten. The proactive timer
is the happy path; the 401 interceptor is the backstop.

### The frontend rule you must not break

From `CLAUDE.md`, and it is enforced:

> **Before touching any dashboard, page, table, drawer, queue, report, or navigation — read the
> authoritative reference image first.** `docs/ui/desktop/v2-reference/`, then
> `docs/ui/desktop/approved-designs/` (desktop) or `docs/ui/mobile/` (mobile).
> **Match the layout. Do not redesign.**

---

## 12. Frontend — the mobile app

`apps/mobile/` is React Native + Expo, and today it is an **auth shell plus a component kit**:

- `app/index.tsx`, `app/_layout.tsx` — Expo Router entry
- `src/auth/` — LoginScreen, AuthProvider, SessionScreen, tokenStore
- `src/api/` — client, connectivity detection, **`writeQueue.ts`** (offline write queue)
- `src/components/kit/` — TicketCard, StatusPill, StatTile, PhotoCaptureRow, TilePicker, ProgressBar

Every actual field screen (day plan, troubleshoot form, vouchers) is **unbuilt**. Issue #54 owns it.

If you are asked to work here, read `src/api/writeQueue.ts` and the `client_submission_id` entry in
the glossary below first — offline idempotency is the defining constraint of this app, and getting
it wrong duplicates inventory movements in the real world.

---

## 13. Navigation recipes

This is the section you will actually come back to. Each recipe answers a "where do I even look"
question.

### Recipe A — "I have a URL. Where is the code?"

```bash
# /api/tickets/:id/forms  →  strip /api, take the first segment
grep -rn "@Controller('tickets')" apps/backend/src
# then find the sub-path inside that controller
grep -n "':id/forms'" apps/backend/src/ticketing/tickets.controller.ts
```
Then read the controller method → it names a service method → that service is in the constructor.

### Recipe B — "I clicked something in the UI. Where is the code?"

1. Grep the visible label: `grep -rn "Assign work" apps/admin/src`
2. That lands you in a page component. Find its `api/` import at the top of the file.
3. Open that API module → it holds the URL → now use Recipe A.

### Recipe C — "I have a database column. Who writes it?"

```bash
# Find the Prisma field name for the column
grep -n "sla_bucket" apps/backend/prisma/schema.prisma
# Then find every writer of the Prisma name AND the SQL name
grep -rn "slaBucket\|sla_bucket" apps/backend/src --include=*.ts
```
Filter the results: `.update(`/`.create(`/`UPDATE`/`INSERT` are writers; everything else reads.

### Recipe D — "What does this module actually do?"

```bash
cat apps/backend/src/<module>/<module>.module.ts     # the manifest
head -60 apps/backend/src/<module>/<module>.service.ts  # the class docstring
ls apps/backend/test | grep <module>                  # the behaviour, spelled out
```

### Recipe E — "This comment says `#238`. What happened?"

```bash
ls docs/progress | grep 238                      # the completion report — the full story
cat .scratch/fsm-platform-v1/issues/238-*.md     # the original issue
grep -rn "#238" apps/backend/src apps/admin/src  # every place it touched
```
This is the highest-leverage recipe in the document. Use it whenever code looks strange. It almost
always looks strange for a reason that is written down.

### Recipe F — "Where does this data come from, end to end?"

Walk the pipeline table in §10 backwards. A field on a ticket in the UI came from
`ticket-query.service.ts`, which joined `device_states`, which was written by
`device-state.service.ts`, which read `raw_device_snapshots`, which was written by
`snapshot-ingestion.worker.ts` from AutoPlant. Five hops, always the same five.

### Recipe G — "Is this feature actually finished?"

Don't guess from the code. Check, in this order:
1. `docs/SYSTEM-STATE-2026-07.md` — search for the feature name.
2. `.scratch/fsm-platform-v1/INDEX.md` — the issue's status line.
3. `docs/progress/<issue>.md` — if it exists, the issue shipped.

### Recipe H — "Which environment switch controls this?"

```bash
grep -rn "process.env" apps/backend/src --include=*.ts | grep -i <keyword>
cat apps/backend/.env.example
```
Most behaviour that touches the outside world is behind a flag that defaults OFF.

---

## 14. Tests are the documentation

426 test files in `apps/backend/test/`, 115 in `apps/admin/test/`. **They are flat, and they are
named after behaviour, not after files** — which makes them a searchable index of what the system
guarantees.

| Suffix | Kind | Needs a database? |
|---|---|---|
| `*.e2e-spec.ts` (368) | Boots a Nest app, makes real HTTP calls with supertest, hits a real Postgres | **yes** |
| `*.spec.ts` (58) | Pure unit tests of helper functions | no |

```bash
ls apps/backend/test | grep dispatch     # every guarantee about dispatch
ls apps/backend/test | grep override     # every guarantee about ZM overrides
```

**Reading a test is often faster than reading the service**, because a test states the intended
behaviour in ten lines with concrete values, while the service states it in three hundred with
edge cases.

### How the test database works

`vitest.config.ts` + `test/global-setup.ts`:

- Tests run against an **isolated database** — your `DATABASE_URL` with `_test` appended. Your dev
  data is never touched.
- `globalSetup` runs **once**: `prisma migrate deploy` → truncate → seed reference data → seed
  fixture users.
- **`fileParallelism: false`** — test files run serially, because they share global invariants
  (e.g. only one snapshot run may be `RUNNING` system-wide).

```bash
cd apps/backend
npm test                    # full suite via scripts/run-tests.mjs (handles a known Windows crash-retry)
npx vitest run test/auth.e2e-spec.ts   # one file — do this while learning
npm run test:reset          # nuke and rebuild the test DB if it gets weird
```

---

## 15. Running it locally

The authoritative version is `docs/runbooks/local-development-login.md`. The short version:

```bash
# once, at the repo root
pnpm install

# backend — from apps/backend/, with DATABASE_URL set in .env (see .env.example)
npx prisma migrate deploy   # 1. schema
npm run build               # 2. REQUIRED — the seed entrypoints are compiled JS
npm run seed                # 3. reference data: zones, plants, tiers, SLA + priority config
npm run seed:dev            # 4. the eight dev logins   ← needs ALLOW_DEV_SEED=true in .env
npm start                   # 5. http://localhost:3000, prefix /api

# admin — from apps/admin/
npm run dev                 # http://localhost:5173
```

**Steps 3 and 4 are not interchangeable and the order is enforced.** Zonal-manager accounts are
scoped by zone *name*; against an unseeded database that lookup misses silently and you get a ZM
with a null `zone_id` — an account that logs in and then 403s on everything. `seed:dev` refuses if
zones are missing rather than let that happen.

**If every login 401s with no explanation:** the `user_credentials` table is empty. That is what
step 4 is for. Login deliberately returns an identical 401 for "no credential row" and "wrong
password" so it cannot be used to enumerate accounts — which is correct, and also why the symptom
carries no diagnostic.

Default dev password is `correct-password` unless `DEV_SEED_PASSWORD` is set.

---

## 16. Glossary

Learn these before reading domain code. Using the wrong word here causes real bugs, because the
codebase is strict about vocabulary. The full dictionary is `CONTEXT.md` §Language.

### People

| Term | Meaning |
|---|---|
| **SE** (Service Engineer) | The field engineer. Installs and repairs devices. *Not* "technician". |
| **ZM** (Zonal Manager) | Owns one Zone. **Monitors and overrides** dispatch — there is no pre-approval gate. |
| **CSM** (Central Service Manager) | Cross-zone layer. Can *act as* a ZM when one is absent; those actions are audited as `acted_as_role`. |
| **OH** (Operations Head) | Fleet-wide strategic owner and the system configurator. There is no separate "Admin" role. |
| **WM** (Warehouse Manager) | Owns physical inventory. **Only** the WM approves stock movement. |

### Coverage

| Term | Meaning |
|---|---|
| **Dedicated SE** | Mapped 1:1 to a single Plant. |
| **Multi-Plant SE** | Mapped to 3–4 named Plants. |
| **Floating SE** | Mapped to a *Territory* (districts and/or a polygon), not to plants. Fallback capacity. |
| **Coverage** | The set of plants or geography an SE is responsible for. Say "coverage", not "mapping". |

### Work objects

| Term | Meaning |
|---|---|
| **Device** | One GPS unit, `device_id`. Mapped to one Vehicle at a time. |
| **Inactive Device** | `latest_gps_datetime` older than the inactivity threshold (default 24 h). |
| **Failure Cycle** | The audit record of **one inactivity episode of one device**. Opens on inactivity, closes on verified recovery, **immutable once closed**. Parent of exactly one Troubleshoot Ticket. |
| **Ticket** | The actionable work item. `work_type` is `TROUBLESHOOT` \| `INSTALL` \| `RECOVERY`. Set at creation, immutable after. |
| **Day Plan** | An SE's dispatched work for a day — a `work_schedule` holding plant-wise batches. |
| **Batch** | `plant_batch_assignment` — one SE's tickets at one plant, grouped. |
| **Soft State** | An SE's in-progress field status (travelling, on-site…), distinct from ticket status. |
| **Auto-Recovery** | Ticket closes `CLOSED_AUTO_RECOVERY` because the device healed **with no SE form submitted**. No components consumed, no SE effort credited. Reports must separate these from real repairs. |
| **Partial Recovery** | A **badge**, not a state: 1–2 pings received, below the ≥3 needed to close. |
| **Special** | A ticket repeatedly dispatched and physically reached, but never successfully worked. |
| **Snapshot** | One periodic read of the AutoPlant source DB. Statuses `RUNNING`/`SUCCESS`/`FAILED`/`PARTIAL`. Say "Snapshot", not "sync"/"refresh"/"pull". |

### Measurement

| Term | Meaning |
|---|---|
| **SLA bucket** | Severity band by silence duration: `WARNING → EARLY_RISK → RISK → CRITICAL → HIGH_CRITICAL → SEVERE → VERY_SEVERE → LONG_PENDING`. NULL for the healthy 0–4 h band. |
| **Company Tier** | `PLATINUM > GOLD > SILVER`. Rank 1 is highest priority. Drives the canonical sort. |
| **Fleet Uptime %** | The contractual master KPI. Monthly, time-weighted, eligibility-gated. Target **≥98%**. |
| **Soft Inactive Count** | The per-zone count that drives Recommender mode. |

### The two thresholds people confuse

This distinction is load-bearing and cost the project a bug (`#238`):

| Setting | Meaning |
|---|---|
| `inactivity_threshold_hours` | A **measurement** definition. Sets `is_inactive`, and therefore the Fleet-Uptime denominator. |
| `se_assignment_threshold_hours` | A **policy** decision. When silence becomes fieldwork — when a ticket is opened. |

Both default to 24, which is why they were the same predicate for a long time. They are not the
same idea, and ticket creation reads the **second** one.

### Idempotency

| Term | Meaning |
|---|---|
| **`client_submission_id`** | A UUID the mobile app generates at **draft creation**, not at submit — so it survives restarts and offline retries. Unique per `(se_id, submission_type, client_submission_id)`. |
| **Idempotency duplicate** | The same submission arriving twice. Returns the existing record. Creates nothing new. |
| **Business 409 Conflict** | *Different* — the ticket is no longer actionable (another SE won, or auto-recovery closed it). Triggers **Shadow Use** recording if the losing SE consumed parts. |

Conflating those two is explicitly called out as an error in `CONTEXT.md`.

---

## 17. A two-week reading plan

Each day is roughly 2–3 hours. Do them in order; each depends on the last.

### Week 1 — the backend

**Day 1 — Orientation.** Get it running (§15). Log in. Click around the admin UI for 30 minutes and
write down five things you don't understand. Then read `CLAUDE.md`, this document's §1–§4, and
`CONTEXT.md` §Language (the vocabulary section only, ~100 lines). Read `main.ts` and the three
arrays at the bottom of `app.module.ts`.

**Day 2 — One request, all the way down.** Do the §6 trace with the files open. Then do it again
yourself, unaided, with a different endpoint — `GET /api/devices` is a good second one. Then read
all four guard/decorator files in `common/` (they total under 200 lines).

**Day 3 — Data.** Skim `schema.prisma` using the `grep -n '^model'` index. Read the ten models
listed in §8 properly, including their `///` comments. Open two migrations and see what SQL Prisma
actually generates. Then read `prisma/prisma.service.ts` including the long docstring.

**Day 4 — Small modules, whole.** Read `zones/`, `health/`, `dashboard/`, `devices/`, `soft-state/`
completely — all five are under 6 files. You now have five complete mental models of a feature.
Then open `apps/backend/test/` and read three e2e specs for those modules.

**Day 5 — The pipeline, front half.** Stages a–e from §10: `master-sync.service.ts`,
`snapshot-ingestion.worker.ts`, `device-state.service.ts`, `auto-recovery.service.ts`,
`ticket-creation.service.ts`. Read the class docstrings in full; skim the bodies.

### Week 2 — the hard parts and the frontend

**Day 6 — The Recommender.** Bottom-up, as §10 prescribes: `distance.ts` → `canonical-sort.ts` →
`hard-filters.ts` → `scoring.ts` → `recommender.service.ts`. Do not start at the big file.

**Day 7 — Dispatch.** `dispatch-scheduler.service.ts` → `dispatch-run.service.ts` →
`batch-assignment.service.ts`. Read the `#262` paragraph twice. Then read
`test/batch-dispatch.e2e-spec.ts` to see the guarantees stated plainly.

**Day 8 — Crons and switches.** Grep every `@Cron`. Read `business-sweep-scheduler.service.ts`. Read
`apps/backend/.env.example` and match each flag to the code that reads it.

**Day 9 — Frontend structure.** `main.tsx` → `App.tsx` → `AppRoutes.tsx` (all of it) →
`AdminShell.tsx` → `hooks/index.ts` → `api/http.ts` + `auth/AuthProvider.tsx`.

**Day 10 — Frontend depth.** Read `pages/tickets/TicketsPage.tsx` and `api/tickets.ts` together with
the backend `tickets.controller.ts` open in a third pane. Watch the same field travel through all
three. Then read `components/data/DataTable.tsx`, which nearly every page uses.

**After that:** pick a small `ready-for-agent` issue from `.scratch/fsm-platform-v1/INDEX.md`, read
its file, and follow the `/tdd` red-green-refactor protocol. Writing one failing test teaches more
than another week of reading.

---

## 18. Habits — how to stay in the flow

Reading a large codebase is a skill, and these are the specific techniques that work in *this* repo.

**Keep three panes open, not one.** Controller · service · test. The controller tells you the shape,
the service tells you the logic, the test tells you the intent. Any one alone will mislead you.

**Read docstrings before bodies, and stop when satisfied.** This codebase's class-level comments are
unusually complete. Many of them make reading the body unnecessary. That is not laziness — it is
using the map instead of walking the terrain.

**When you meet a `#nnn`, spend 60 seconds on Recipe E.** The cost is a minute; the payoff is
understanding *why* rather than *what*. Code that looks wrong here is usually code that was wrong
once, in production, and was fixed carefully.

**Follow types, not names.** `Ctrl+Click` on a type in your editor beats grepping for a name.
`TicketView`, `DispatchSummary`, `SeCandidateReadiness` — the interfaces are the contracts, and they
are all named and exported.

**Never trace more than one thread per sitting.** If you start on tickets and end up in inventory,
you have stopped learning and started wandering. Write the detour down as a question, and go back.

**Write down every unfamiliar noun.** Not every function — every *noun*. "Soft state", "shadow use",
"floating SE", "batch", "cycle". Look each up in `CONTEXT.md`. Domain vocabulary is 80% of the
difficulty here and 100% of it is written down already.

**Trust the tests over your reading.** If your understanding and a green test disagree, the test is
right. Change the test to prove your reading wrong — if it stays green, you misread.

**When totally lost, run the three-command reset:**

```bash
cat apps/backend/src/<where-you-are>/<module>.module.ts   # what is this folder?
head -60 <the-file-you-are-in>                            # what is this file for?
ls apps/backend/test | grep <keyword>                     # what is it supposed to do?
```

**Don't try to hold the whole system in your head.** Nobody does. Hold the funnel from §1, the
request path from §6, and the recipes from §13. Everything else you can find in under two minutes,
and finding it fast is the actual skill.

---

## Appendix — the fifteen files that matter most

If you read nothing else, read these, in this order.

| # | File | Why |
|---|---|---|
| 1 | `CLAUDE.md` | The rules of the repo |
| 2 | `CONTEXT.md` §Language | The vocabulary — non-negotiable |
| 3 | `apps/backend/src/main.ts` | The true entry point |
| 4 | `apps/backend/src/app.module.ts` | The master list of everything |
| 5 | `apps/backend/src/common/guards/auth.guard.ts` | How every request is authenticated |
| 6 | `apps/backend/src/prisma/prisma.service.ts` | The one DB connection, and why its numbers are what they are |
| 7 | `apps/backend/src/ticketing/tickets.controller.ts` | The reference controller |
| 8 | `apps/backend/src/ticketing/ticket-creation.service.ts` | The reference write service |
| 9 | `apps/backend/src/device-state/device-state.service.ts` | The hub of the data model |
| 10 | `apps/backend/src/recommender/hard-filters.ts` | Where the domain rules are most explicit |
| 11 | `apps/backend/src/scheduling/batch-assignment.service.ts` | The heart of the product |
| 12 | `apps/backend/prisma/schema.prisma` | The data model (as a lookup, not a read) |
| 13 | `apps/admin/src/AppRoutes.tsx` | The frontend's table of contents |
| 14 | `apps/admin/src/api/http.ts` | The session policy every request obeys |
| 15 | `apps/admin/src/hooks/index.ts` | The two hooks behind every page |

---

*Written 2026-08-26 against branch `feat/autoplant-integration`. Counts and paths were measured from
the tree on that date; the structure and conventions are stable, but verify a specific file still
exists before relying on it. This document explains how to read the code — for what is currently
built and working, `docs/SYSTEM-STATE-2026-07.md` remains the source of truth.*
