# Module gap survey — index

Run 2026-09-02 against `feat/autoplant-integration` @ `beea7d2` (backend build fingerprint `beea7d2-dirty`
== git HEAD, so live evidence is evidence about current source). 14 modules, none parked.

**Start here:** [EXEC-SUMMARY.md](./EXEC-SUMMARY.md) — plain language, no codes.
Then [ROADMAP.md](./ROADMAP.md) (what first) and [DEPS.md](./DEPS.md) (what blocks what).

| module | status | complete → after | gaps | S4 · S3 · ☠ | P50 / P80 TEQ | size / risk | conf |
|---|---|---|---|---|---|---|---|
| [reports](./reports.md) | estimated | 48% → 63% | 11 | 0 · 3 · 2 | 37.1M / 74.3M | XXL / HIGH | LOW |
| [auth-access](./auth-access.md) | estimated | 50% → 67% | 11 | 0 · 4 · 4 | 34.0M / 68.1M | XL / HIGH | LOW |
| [vouchers](./vouchers.md) | estimated | 56% → 78% | 12 | 0 · 6 · 6 | 32.3M / 64.5M | XXL / HIGH | LOW |
| [scheduling](./scheduling.md) | estimated | 57% → 72% | 10 | 1 · 0 · 1 | 24.2M / 48.5M | XL / HIGH | LOW |
| [notifications](./notifications.md) | estimated | 58% → 75% | 10 | 1 · 5 · 1 | 35.5M / 71.0M | XL / HIGH | LOW |
| [inventory](./inventory.md) | estimated | 61% → 74% | 9 | 0 · 3 · 1 | 21.9M / 43.8M | L / HIGH | LOW |
| [cross-zone](./cross-zone.md) | estimated | 66% → 80% | 13 | 0 · 6 · 1 | 29.2M / 58.4M | XXL / HIGH | LOW |
| [admin-config](./admin-config.md) | estimated | 66% → 83% | 13 | 2 · 3 · 3 | 33.0M / 65.9M | XL / HIGH | LOW |
| [dashboard](./dashboard.md) | estimated | 67% → 84% | 11 | 0 · 3 · 0 | 31.2M / 62.3M | XXL / HIGH | LOW |
| [verification](./verification.md) | estimated | 69% → 92% | 8 | 0 · 3 · 0 | 20.7M / 41.4M | L / HIGH | LOW |
| [tickets](./tickets.md) | estimated | 72% → 80% | 13 | 1 · 2 · 2 | 37.0M / 73.9M | XXL / HIGH | LOW |
| [ingestion](./ingestion.md) | estimated | 74% → 86% | 9 | 0 · 4 · 3 | 16.9M / 33.8M | XL / HIGH | LOW |
| [intraday](./intraday.md) | estimated | 75% → 94% | 11 | 0 · 2 · 0 | 26.0M / 52.1M | XXL / HIGH | LOW |
| [engineers](./engineers.md) | estimated | 77% → 90% | 7 | 0 · 4 · 4 | 14.1M / 28.3M | L / HIGH | LOW |
| **app** | | **63% → 78%** | **148** | **5 · 48 · 28** | **393M / 786M** | — | **LOW** |

## Supporting artifacts

| file | what it holds |
|---|---|
| [SPINE.md](./SPINE.md) | 28 cross-module hand-off edges — 6 with no receiver, 2 carried by "a human remembers" |
| [edge-queue.md](./edge-queue.md) | edges needing a hand-off test, worst first, with owners |
| [standing-rules.md](./standing-rules.md) | 36+ rules promoted during the sweep: refuted claims, shared-gap ownership, scanner defects |
| [policy.md](./policy.md) | the verdict policy every judgement cites |
| `.work/<module>/` | per-module evidence: coverage, gaps, hypotheses, walk narratives, not-walked lists, estimates |
| `.work/_shared-primer.md` | live app, logins, data density, already-settled facts |

## Read the numbers correctly

- **TEQ is AI context cost.** Never a schedule, never headcount.
- **Engineering size is relative only.** XL is bigger than L, not "six weeks".
- **Every module is `conf LOW`** on a **borrowed** calibration — anchors measured over 272 runs on a
  different TypeScript/Prisma repo, never on this one. Cross-check A split by 3.8×–15.7× on every module.
  **The ranking is trustworthy; the absolute TEQ is not a commitment.**
- **30 gaps exceed the model's own "over 3M is not one gap" line** and need splitting before anyone commits.
- **30.4M TEQ of the total rests on cohorts with n<10** (integration n=6, migration n=4).

## Known limits of this run (reported, not hidden — policy P18)

- **No browser was used.** Walks ran against the live API as the six real seeded personas, which settles
  permissions, persistence and downstream far more cheaply and — for permissions — more correctly than a
  browser could. Purely visual claims are listed by name in each module's `not-walked.json` with a cost
  of one browser walk (~708k TEQ) each. Disclosure sweeps were therefore **not performed**; that is
  recorded as a failed sweep, not as "nothing found".
- **`scheduling`'s walk was cut short** by a session rate limit after writing 6 of its outcome rows; its
  narrative and not-walked list are missing. Its findings stand; its coverage is thinner than the others.
- **17 findings are `needs-verify`** for want of test data, not for want of looking. See ROADMAP Wave 0.
- **Three walks changed state in the dev database, all declared:** one ticket closed (`f1978011…`,
  auth-access), one disposable account created then disabled (`surveyor.disposable.20260902@fsm.invalid`,
  admin-config), and three leave/availability rows dated 2026-10-05→08 on engineer `459b5409` kept
  deliberately because they *are* the evidence for ENG-G4 and ENG-G6 (engineers). A fixture engineer and
  coverage row were also added for `se.north` (tickets), which took `/me/tickets` from 0 to 521 rows.
- **Several findings began as my own scanner's false positives** and were refuted by surveyors: the audit
  column under-detects, the guard column can be off by one decorator, "no data hook" missed this app's
  `useEffect` + typed-client pattern, and the status-write column matched SELECT predicates. All four are
  recorded in `standing-rules.md` as dev-process, never in the feature backlog.

This survey diagnoses and prices. It does not build, patch, or file issues.
