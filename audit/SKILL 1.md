---
name: scope-module-gaps
description: >
  Surveys ONE module of any app and writes a short, priced gap brief — what is missing, how bad,
  what it costs to fix, what to do first — from code + browser evidence, never from status docs.
  Self-installing: on first run it profiles YOUR repo (any stack, any folder layout) and generates
  the stage files, templates and scripts it needs. Never writes feature code.
  Use when asking what's missing in a module, how complete the app really is, what finishing would
  cost, which module to do first, or /scope-module-gaps.
---

# scope-module-gaps

Surveyor. **Never build.** Report a one-line fix; do not make it.

Two jobs, in this order:

1. **A0 BOOTSTRAP** (once per repo) — learn this app's real shape, write `gapscope.profile.json`, generate the runtime (stages, templates, scripts) into the skill directory.
2. **A1→S5** (per module) — produce `<out>/<module>.md`: a ≤90-line brief with severity, evidence pointers, and a cost estimate.

Everything below is stack-agnostic. Nothing assumes Next.js, Prisma, hexagonal layers, or any nav file. Where the original needed a hard path, this file names a **profile key** instead.

---

## 0 · Three laws

1. **Caveman-technical, pointer on every claim.** `file:line`, route, id, verdict. No hedging, no narration, no restating the input. Length invents facts.
2. **Hand off before the context that holds the evidence compacts.** S2 at 35%, S1/S3/S4 at 50%. Finish the CURRENT unit (one hypothesis / one cluster), write the `.work/` JSON, write `HANDOFF.md`, end the turn. Never mid-unit.
3. **No build.** No patch, no "quick fix", no migration, no issue filed. Wanting to build means you are in the wrong skill.

### Why the stage order is not negotiable

The order is a **context device**, not a workflow.

- **S1 (EXPECTED) is written by an agent that has never seen the code.** So it cannot grade the app against itself.
- **S2 (ACTUAL) is written by an agent that may never open a browser.** So it cannot be charmed by a screen that renders.
- **S3 (GAPS) receives both as a test list.** So it verifies claims instead of touring.

Merge any two of these into one context and the survey degrades into "walk around and write down impressions". Two read-bans are load-bearing: **the scout may not read code**, and **the surveyor may not open the browser**.

---

## 1 · A0 · BOOTSTRAP — profile this app, then generate the runtime

Run once. Re-run when the app's shape changes (new router, new module boundary, new test-user story). Everything generated is written **into this skill's own directory**, so a later run reads a short stage file instead of this whole document.

### 1.1 Answer these from evidence, never from a README's claims

Read code and config first; treat docs as claims to test. Budget: ≤25 file reads. If a code graph tool exists in the repo, use it before grepping.

| # | question | look at | profile key |
|---|---|---|---|
| 1 | What is the repo root of the app under survey (not a worktree/fixture copy)? | dirs, package/manifest files | `appRoot` |
| 2 | **What is a "module"?** The unit the user means by "module" — a nav group, a bounded context, a feature folder, a top-level route segment, a service. | navigation/menu source, routing table, top-level source folders, CODEOWNERS | `moduleBoundary` = `{kind, source, listCmd}` |
| 3 | What are the modules, by slug + human label? | from #2 | `modules[]` |
| 4 | How do I list a module's **user-reachable entry points** (routes/screens/CLI commands/API endpoints)? A shell command that prints them. | router files, `app/`/`pages/`/`routes/`, controller annotations, OpenAPI spec | `routeDiscovery.cmd` |
| 5 | How do I list a module's **backend units** (services, handlers, actions, use-cases, jobs)? | source layout | `backendDiscovery.cmd` |
| 6 | Where is persistence defined, and how do I see a module's tables/collections + their foreign keys? | schema/migrations/ORM models | `dataModel.{path,fkCmd}` |
| 7 | What are the **roles / personas**? Who actually sits in front of each module? | auth config, role enums, seed data, permission tables, PRDs, support tickets | `personas[]` = `{role, label, modules[], source}` |
| 8 | How is **authorization enforced server-side** (the thing completeness check 6 tests)? A grep that finds an unguarded handler. | guards, middleware, decorators, policy objects | `authz.{style, guardGrep}` |
| 9 | Is there an **audit / event log**, and how does a write reach it? | audit service, outbox, event bus, changelog table | `audit.{present, writerGrep}` |
| 10 | How do I run the app locally and log in as a **non-admin** persona? Exact command, URL, credentials source. | scripts, seed files, `.env.example`, e2e fixtures | `runbook.{start, baseUrl, loginPath, users[]}` |
| 11 | Which **browser driver** is available? Playwright MCP · claude-in-chrome · Puppeteer script · none. | MCP list, devDependencies | `browser.driver` |
| 12 | What **doc corpus** describes intent — PRDs, specs, issue tickets, ADRs, CONTEXT/domain docs, Jira export, changelog? | docs dirs, issue tracker export, `.md` sweep | `docs.sources[]` |
| 13 | Is there **prior art** — a previous audit, UAT run, QA sheet, bug backlog — with a date and a commit? | docs, tracker | `priorArt[]` = `{path, date, commit}` |
| 14 | Where does the deliverable go? | docs dir convention | `out` (default `<appRoot>/docs/module-gaps`) |
| 15 | What runtime is available for the generated scripts — Node, Python, Go, plain shell? | toolchain present | `scriptRuntime` |

**Rules for A0:**

- A question you cannot answer from evidence gets `"UNKNOWN"` plus `unknownCost` (what it would take to settle it) — never a guess. An `UNKNOWN` for #2, #7 or #10 **blocks the run**; ask the user those three and nothing else.
- #7 is the most commonly faked. A role enum is not a persona. A persona needs **who, what they come here to do, how often**. If the app has no persona evidence, ask the user for one sentence per role — that one question buys the whole survey its yardstick.
- Record every answer with its source pointer. `profile.json` is evidence, not configuration.

### 1.2 Write `gapscope.profile.json`

```json
{
  "appRoot": "<abs path>",
  "out": "<appRoot>/docs/module-gaps",
  "scriptRuntime": "node",
  "moduleBoundary": { "kind": "nav-group|route-segment|source-folder|bounded-context",
                      "source": "<file:line>", "listCmd": "<shell>" },
  "modules": [{ "slug": "dispatch", "label": "Dispatch", "routes": ["/dispatch"],
                "sourceDirs": ["src/dispatch"], "size": "small|full" }],
  "routeDiscovery": { "cmd": "<shell printing route\tfile>" },
  "backendDiscovery": { "cmd": "<shell printing symbol\tfile:line>" },
  "dataModel": { "path": "<schema>", "fkCmd": "<shell>" },
  "personas": [{ "role": "FIELD_ENGINEER", "label": "Ravi, on-site engineer",
                 "modules": ["jobs"], "frequency": "20 jobs/day", "source": "<pointer>" }],
  "authz": { "style": "middleware|decorator|policy|none", "guardGrep": "<shell>" },
  "audit": { "present": true, "writerGrep": "<shell>" },
  "runbook": { "start": "<cmd>", "baseUrl": "http://localhost:3000", "loginPath": "/login",
               "users": [{ "role": "FIELD_ENGINEER", "credsFrom": "<seed file>" }] },
  "browser": { "driver": "playwright-mcp|claude-in-chrome|none" },
  "docs": { "sources": ["docs/prd", "tickets/*.md"] },
  "priorArt": [],
  "calibration": "borrowed",
  "unknowns": []
}
```

### 1.3 Generate the runtime

Write these into the skill directory. **Generate, don't hand-write per run** — every one of them replaces LLM tokens with 0-cost determinism.

```
stages/A1-spine.md  S1-expected.md  S2-actual.md  S3-gaps.md  S4-estimate.md  S5-portfolio.md
templates/  s1.json  coverage.json  hypotheses.json  gap-line.jsonl  module-file.md  HANDOFF.md
scripts/    inventory-skeleton  inventory-static  estimate  render-brief  assert-brief  assert-hypotheses
calibration/calibration.json          <- §5.2 bootstrap values, marked "borrowed"
gapscope.profile.json
```

Each `stages/*.md` is the matching section of this file (§2), **rewritten with this app's real paths, commands and persona names substituted in** and everything else deleted. Target ≤40 lines each. A stage file that still says "your router" instead of the actual command was not generated, it was copied.

Script contracts are in **§9**. Implement them in `scriptRuntime`; the language does not matter, the CLI and the JSON do.

### 1.4 Self-test before declaring A0 done

```
1. run inventory-skeleton + inventory-static on the SMALLEST module -> non-empty, real paths
2. run assert-hypotheses on a hand-written 1-row hypotheses.json -> passes; delete a required
   field -> fails with a named field                                  (a gate that never fails is not a gate)
3. run estimate on a hand-written 1-row gaps.jsonl -> estimate.json with P50/P80/size
4. run render-brief -> a brief; run assert-brief -> OK; append "## S3 GAPS" -> FAIL
5. start the app per runbook, log in as a NON-ADMIN persona          (if this fails, S3 is impossible - say so now)
```

Write `A0.done` = `<n> modules, <n> personas, <n> unknowns, browser <driver>, selftest <5/5>`.

---

## 2 · The loop

| stage | question | writes | who |
|---|---|---|---|
| **A1** once | how work moves between modules | `SPINE.md`, `edge-queue.md` | cartographer (strong model) |
| **S1** | what SHOULD exist — **no code** | `.work/<m>/s1.json` | scout (cheap model) |
| **S2** | what DOES exist — **no browser** | `coverage.json` `hypotheses.json` ≤5 `gaps.jsonl` + draft brief | surveyor (strong model) |
| **S3** | cheapest disproof of S2's claims | JSONL confirm / falsify / NEEDS-VERIFY | walker (strong model, the only browser) |
| **S4** | cost + prose | `estimate.json` (script) then 3 LLM blocks | estimator (cheap model) |
| **S5** once | what first | `ROADMAP.md` `DEPS.md` `EXEC-SUMMARY.md` | synthesizer (strong model) |

**One stage = one fresh process, reading ONE stage file.** Never re-read this SKILL.md from inside a stage. Resume order is `HANDOFF.md` → `STATE.json` → the named `.work/` file — never the public brief.

**Attended (a named module in chat):** S1 + S2 + draft brief in one conversation; the scout still must not see code. Offer S3 as a second turn. Sweeping every module is a driver loop, not a chat.

### A1 · Spine — how work crosses modules

A module can be internally perfect and still leave the business broken, because the work has to *cross* modules and nothing carries it. Each side looks finished and each blames the other. So the spine is built **once, app-level, before the first module is scoped**.

It is a directed graph of **work items moving between modules**, not a diagram of modules. Node = a work item in a state. Edge = a hand-off with an owner on each end.

> Field-service example: `Service request ─▶ Triage ─▶ Scheduled job ─▶ Engineer's day list ─▶ On-site report ─▶ Parts consumed ─▶ Warranty claim / Invoice`. Same test as an ERP's `PO ─▶ GRN ─▶ Invoice`.

Edge row:

| field | meaning |
|---|---|
| `from` / `to` | module + work item + the state that triggers the hand-off |
| `carrier` | **how** it moves: a route, a queue/worklist, a status flip, a push/notification, a scheduled job, or **"a human remembers"** |
| `trigger` | approval · posting · date · manual click |
| `payload` | fields the downstream side actually needs |
| `receiver` | the screen + role that picks it up. **Blank = the finding** |
| `reverse` | what happens on reject / cancel / amend — the path everyone forgets |
| `evidence` | E-class + where verified |

`carrier: a human remembers` is **never a valid carrier**. It is a C2 finding: the process runs on memory and cannot be audited.

**Edge severity floor:** BROKEN on a money/stock/safety edge → **S4 + DANGEROUS** · BROKEN elsewhere → S4 · MANUAL → S3 · PARTIAL with no reverse path → S3 · payload loss → S2 · no reference/identity → S2.

Do **not** browser-test in A1. Owner of an edge = whoever must *build* the carrier, usually the receiving side. **One id, one price, referenced by both modules.**

`A1.done` = `<n> edges, <n> blank receivers, <n> human-memory, <n> prd-vs-code diffs`

### S1 · EXPECTED — the yardstick

**No code, no route list, no inventory files, no browser.** Reads: the doc corpus slice for this module, domain/context docs, `SPINE.md`, any UX spec. ≤8 reads.

1. Boundary = `profile.moduleBoundary`. Disagreement with what the docs call the module is itself a SCOPE note.
2. One persona (from `profile.personas`), ≤3 goals — the three things they come to this module to do.
3. Capabilities that SHOULD exist, each with `src ∈ {persona, role, spine, prd}` and `crit 1-5`.
4. **ANCHOR-CHECK: if every `src` is `prd`, the yardstick is a doc echo — FAIL and re-derive from persona + spine.** More than 3 goals → two personas, split the module.

Writes `s1.json` (+ `s1.md` ≤60 lines). Hand off at 50%.
`S1.done` = `<n> caps, <n> goals, ANCHOR <pass|FAIL>`

### S2 · ACTUAL — what exists, from code

**No browser.** Start from the generated inventory (0 tokens), then targeted reads, ≤6 source files per capability cluster.

```
<scripts>/inventory-skeleton <module>     # routes, source units, exported handlers
<scripts>/inventory-static  <module>      # guards, audit writers, status writers, spine owners
```

Score every S1 capability with the **nine completeness checks** (§3) into `coverage.json`. Then:

- `gaps.jsonl` — only what code alone **settles**: `NOT_STARTED`, `BACKEND_ONLY`, proven asymmetry, blank spine receiver.
- `hypotheses.json` — **≤5**, the claims code cannot settle. Each row carries `unsettleableBy ∈ {persist, perms, downstream, carrier-works}`, a `strongestAlternative` (how this could be wrong) and an `altCheck` already grepped.

```
<scripts>/assert-hypotheses <module>      # must pass, or the stage is not done
<scripts>/render-brief      <module>      # draft brief, STATUS: actual — the user may stop here
```

**Never `FUNC_COMPLETE` from a static read.** Checks 3 / 6 / 8 stay `?` until S3 patches them. Walkable = `{PARTIAL, UI_ONLY, FUNC_COMPLETE, BROKEN}`; anything else is a JSONL gap with no walk. Hand off at **35%**, per cluster.

`S2.done` = `walkable <n> of <m>, hyp <n>` — not done if assert-hypotheses fails.

### S3 · GAPS — cheapest disproof

**One walker for the whole module.** Login, orientation and disclosure ritual are paid once.

```
walk = hypotheses.json (<=5)  UNION  owned spine edges whose S2 carrier is claimed WORKS
```

Blank / none / no-op carriers are already S2 gaps — **no browser**. This is not a persona-day tour and not a full re-inspection; S3 may only **confirm**, **falsify**, or **NEEDS-VERIFY** a named id.

Per unit: as the **persona role, never admin** · reload after every save (a persistence claim without a reload is not a check) · screenshots only on deviation, blocker, or persist-fail · ≤8 screens, depth 2 from the module landing page, ≤3 new records, ≤120 tool calls.

**Disclosure sweep on named screens only** — a collapsed screen is half read:
> Signals: `aria-expanded=false` · `<details>` · chevrons `▸ ⌄ › +` · overflow `⋮ …` · tooltips · inner tabs · "show more" · clickable rows. Open ≥3 rows: first, each distinct lifecycle state, densest. Record `DISCL <n> found <n> opened <n> blocked`. `0 found` is valid; `not checked` is a failed walk.

**The hand-off test** (claimed-WORKS edges only, **both ends or it does not count**):

```
1 UPSTREAM   advance a real work item to the triggering state
2 CARRIER    does anything change anywhere without a human retyping it?
3 DOWNSTREAM open the receiving module AS THE RECEIVING ROLE. Is the work visible
             WITHOUT knowing the item's number in advance?      <- the test that catches false passes
4 PAYLOAD    every field present, or does the receiver phone the sender?
5 REVERSE    cancel upstream. Does downstream learn? Is stale work withdrawn?
6 IDENTITY   does the downstream record carry the upstream reference?
```
Result ∈ `WORKS · PARTIAL · MANUAL · BROKEN · UNTESTABLE`. Told-the-number is a lookup, not a hand-off → C2.

New gaps only if they **block** the current claim; otherwise fold. Narrative ≤40 lines in `gaps-<id>.md`, **never** on the public brief. Hand off at 50% **between** units.

`S3.done` = `<n> confirmed/falsified, <n> gaps, <n> edges`

### S4 · ESTIMATE — script prices, LLM writes three blocks

```
<scripts>/estimate     <module>      # writes estimate.json — all arithmetic
<scripts>/render-brief <module>      # rewrites the brief from JSON
```

Then a cheap model edits **only**: the `VERDICT` line, `## The picture` (2–4 sentences), `## What matters` (≤8 bullets, worst first, **always one 🟢 that genuinely works**). Every number quoted from `estimate.json`; **never re-derive TEQ in prose**.

```
<scripts>/assert-brief <module>      # exit 1 = stage FAILED, delete S4.done and retry
```

`S4.done` = `<n>% -> <n>%, P50 <x>M / P80 <x>M, brief <n> lines`

### S5 · PORTFOLIO — what first

Reads each module's **brief** (STATUS + What matters + gap table) + `estimate.json` + `SPINE.md`. Never ingests walks or source. Writes `DEPS.md`, `ROADMAP.md`, `EXEC-SUMMARY.md` (≤60 lines, no codes, no jargon, no TEQ arithmetic), `_INDEX.md`.

Checks: topological order applied **after** scoring · leverage reciprocated (if A blocks B, B lists A) · three rankings (severity · cost · leverage) · **every shared gap priced exactly once** · a parked module appears as `NOT SCOPED — <reason>`, **never as zero**.

Then stop. No issues filed, no build.

---

## 3 · Taxonomy card — the only classification workers need

Answer all five on every finding: **kind · completeness · severity+impact · evidence+confidence · work type.**

**Kind — C** capability: `C1` missing · `C2` broken hand-off · `C3` false completeness · `C4` asymmetry (one layer without the other) · `C5` partial scope · `C6` role has no lens · `C7` unreachable state
**P** process (usually DANGEROUS): `P1` no control · `P2` no audit · `P3` no reconciliation · `P4` separation-of-duties breach
**O** observability: `O1` no finished-work ledger · `O2` supervisor blind · `O3` misleading metric · `O4` dev-process gap — **never in the feature backlog**
Screen defects (truncation, overflow, dead control) are `UX` work type; if a C/P/O also fits, price the C/P/O.

**Completeness — nine checks:** 1 UI · 2 API · 3 **persist (save + reload)** · 4 validation · 5 business rules · 6 **backend** permissions · 7 state transition · 8 **named downstream consumer** · 9 audit.
`COMPLETE` 9/9 · `WORKING` 7–8 with 3/5/6/7 passing · `PARTIAL` otherwise · `FACADE` 1–2 only (= C3) · `ABSENT` 0. Mark `NA` where genuinely not applicable. **Never `FUNC_COMPLETE` from static reading. An admin-only walk makes check 6 `UNVERIFIED`, not `pass`.**

**Severity:** `S4` process cannot complete in the app · `S3` completes wrong / unauditable / money-wrong · `S2` daily tax · `S1` trained-user friction · `S0` cosmetic. Impact ∈ business|user|process|data|financial|compliance|safety. **financial · compliance · safety · silent data loss ⇒ DANGEROUS** (overrides). Reach 1–5. **Severity is never fix cost.**

**Evidence:** `E4` reproduced walk · `E3` observed · `E2` file:line · `E1` docs only · **`E0` is never a finding.** HIGH = E4, or E3+E2 agreeing · MED = E3 or E2 · LOW = E1, or a contradiction (a contradiction is C3/C4 — never average two disagreeing sources).

**Absence must be earned. No `C1`/`C6` without all five not-found checks recorded:** route search · backend search · permission (is it hidden from this role?) · terminology (does the app call it something else?) · entry point in **another** module. Incomplete → `NEEDS-VERIFICATION`, excluded from the ranked backlog, listed with the cost of settling it.

**Work type:** `NEW` · `COMPLETE` (finishing half-built work — usually pricier than NEW) · `FIX` · `INTEGRATION` · `DATA` · `REFACTOR` · `UX` · `PERF` · `SECURITY`. **No `files[]` + `lanes[]` ⇒ NEEDS-SCOPING, no price.**

**S2 states:** `NOT_STARTED` `BACKEND_ONLY` `UI_ONLY` `PARTIAL` `FUNC_COMPLETE` `BROKEN` `OBSOLETE` `NA`. (`OBSOLETE` is a real result — deleting is work, and cheap.)

---

## 4 · Verdict policy — copy into every run dir as `policy.md` before judging

Every verdict cites its clause. No clause fits → `D`, with the reason.
Verdicts: **A** accept · **B** accept with a note (the note overrides) · **C** reject → `rejected.md` · **D** defer → `deferred.md`, *needs your call*.

**Bias toward recording, never toward inventing.** A wrong `A` costs the user two seconds to strike out; a wrong `C` is a gap they never hear about. Clauses P6–P8 exist to stop the inventing.

**Evidence** — P1 absence must be earned (§3 five checks) · P2 `E0` is never a finding, `E1` alone caps confidence at LOW · P3 a contradiction between code and browser is a **finding** (C3/C4) at the severity the *user's* experience implies, never the code's · P4 no reload, no persistence claim · P5 an admin session cannot judge permissions.

**Judgment** — P6 **persona cost is the currency**: accept only if a named person is measurably slower, blinder, more error-prone, or leaves the app; a costless workaround → `C` · P7 severity is set by process consequence, **never by fix cost** (a one-line fix to a process-blocker is still S4) · P8 reach and criticality are evidenced from the persona's frequency lines and the spine, else score 1 and say why · P9 **control and audit gaps outrank display gaps** — any P-class finding, and anything touching money, stock, compliance, safety or an audit trail, is `A` + DANGEROUS and hoisted above every C finding regardless of price · P10 documented standing law (design system, prior deliberate decisions) beats the worker: contradicting it makes the finding `B`, the note being the rule · P11 **fold, don't stack** — the same gap seen twice is one finding with two evidence lines; **double-pricing destroys the roadmap's credibility** · P12 one-way doors (deleting data, changing a grant, altering a posted record, destructive migration) are `D` but still priced — a decision whose cost is hidden cannot be weighed · P13 **cap 9 accepted findings per surface**; keep the worst and roll the tail into one line (`+N minor, ≈X TEQ, see …`) — **never silently drop it**, an invisible cap reads as "that is all there is" · P14 rendering defects are `UX` and go to a rendering list, never the feature backlog — getting this wrong tells the user to rebuild a screen that needed a CSS fix · P15 unpriceable ⇒ not `A`; it is `D` with reason `needs scoping` · P16 `O4` process gaps go to an appendix, never summed into the backlog · P17 **earlier modules bind later ones**: app-level `standing-rules.md` and `rejected.md` carry across the sweep; already rejected app-wide → `C` on sight, citing the earlier module.

**Budget** — P18 an exhausted budget is **reported, never hidden**: screens not walked, states not reached, listed by name with the cost of a deep pass; a partial survey that reads as complete is worse than no survey · P19 `UNTESTABLE` is a legitimate result — say what data or permission would make it testable; that seeds the next run's fixtures.

**Output** — P20 caps bind (§7) · P21 hand off on the percentages, mid-unit never · P22 no unrequested file, no "supporting analysis", no appendix; the run directory is not a scratchpad · P23 cheapest sufficient evidence: **a browser context costs ~800k TEQ, a grep costs ~2k.**

**Escalation** — park the **module** (never halt the sweep) for: dev server dead after one restart · login blocked · browser driver down · module boundary unresolvable · no persona identifiable. A parked module is `NOT SCOPED — <reason>` in the roadmap.

---

## 5 · Estimation — two numbers, deliberately different

### 5.0 The one thing to get right

**TEQ is not engineering effort.** It measures how much AI context a build of this shape historically consumes. It never tells you whether something is two days or three months, and it must never be presented as if it did.

| | answers | unit | calibrated |
|---|---|---|---|
| **AI cost** | what will it cost to have an agent fleet build this | TEQ P50/P80 | yes — from measured runs |
| **Engineering size** | how big is this for a human reading the roadmap | XS–XXL + risk | **no — relative only** |

Different inputs on purpose. When they disagree — a large engineering job with a small token cost, or the reverse — **that disagreement is the most interesting sentence in the estimate**.

> Never: "Jobs module = 5M TEQ." Always: "Jobs: 11 gaps, 3 process-blocking; engineering size L, high risk; AI cost P50 2.1M / P80 4.2M TEQ, medium confidence."

### 5.1 The unit

```
TEQ = input + 1.25 × cache_creation + 0.10 × cache_read + 5 × output
```

These are the standard price **ratios** relative to that model's own input token, so TEQ survives price changes. Consequences: it is **per-model** (never add a strong model's TEQ to a cheap model's — report separately, or a single `S-TEQ = cheap + 5 × strong`); **raw "tokens" is the wrong unit** because cache reads dominate and bill at ~10%; **output tokens alone undercount** the reading, which is most of what a builder does (~150 TEQ per output token).

### 5.2 Calibration — borrowed until you measure your own

Ship `calibration/calibration.json` with these **borrowed** anchors, measured over 272 agent runs on a TypeScript/Next/Prisma ERP. They are a starting point, **flagged `"basis":"borrowed"` in every report until re-measured on this repo.**

| cohort (bucket by **files the agent actually wrote**) | n | P50 | P80 | use for |
|---|---|---|---|---|
| frontend (screens, components) | 71 | **688k** | 1.27M | `ui` lane |
| backend (services, handlers, actions) | 17 | **707k** | 1.02M | `domain` `api` `permissions` lanes |
| full-stack (both sides in one packet) | 34 | **1.30M** | 1.91M | a gap whose lanes are not split |
| integration (≥2 modules) | 6 ⚠ | **835k** | 1.54M | `integration` lane |
| migration (schema/data) | 4 ⚠⚠ | **466k** | 512k | `data` lane |
| tests-only | 7 | 408k | 464k | a demanded pin suite |
| recon (read-only inspector) | 32 | 169k | 206k | `analysis` lane; prices the survey, not the build |
| one browser screen walk | 31 | 708k | 1.06M | S3 budgeting |
| spec / synthesis | 24 | 429k | 797k | S4/S5 |

Three findings the model is built on, and they transfer:

1. **Layer depth does not drive cost; crossing the seam does.** frontend ≈ backend, but full-stack ≈ double either. An earlier "backend is harder" ladder was refuted by measurement and deleted.
2. **Lanes are additive** (frontend + backend = 1.395M vs measured full-stack 1.30M, within 7%). That is what licenses lane-level estimation.
3. **P80/P50 = 2.0 and mean/P50 = 1.28.** So quote **P80 for commitments**, and use the **mean for portfolio totals** — summing medians understates a multi-packet module by ~28%.

**Re-measure on this machine** (generate this script at A0 if agent transcripts exist): read one file per dispatched agent from the agent-transcript directory, dedupe by message id, bucket by **written file set** (not by the agent's description — descriptions are three-word labels, the write set is ground truth), and emit the same JSON shape. `calibration.json` always outranks this document.

### 5.3 Price the **gap**, never the module

A module total that is not the sum of its gaps cannot be acted on, argued with, or checked.

**a. Decompose into lanes:** `analysis` (mandatory when confidence is LOW) · `domain` · `data` · `api` · `ui` · `integration` · `permissions` · `tests` (separate only for a demanded pin suite) · `docs` (~90k).

**b. Score 0–3 on nine complexity drivers:** scope breadth (1 surface → 7+) · dependency (self-contained → changes a shared contract) · domain logic (CRUD → money/tax/reconciliation) · data (none → rewrite of existing rows) · integration (none → multi-system bidirectional) · UI (existing archetype → wizard/real-time) · roles (one → SoD/approval chain) · incumbent quality (clean+tested → actively broken) · unknowns (settled → shape unsettled).

```
score      = Σ drivers (0-27)
multiplier = 0.6 + score / 15                    # 0.6 @0 · 1.0 @6 · 1.4 @12 · 2.4 @27
T_lane     = anchor(lane) × multiplier
T_gap      = Σ T_lane × (1 + 0.08 × (n_lanes - 1)) × typeModifier
```

`typeModifier`: `COMPLETE` **×1.35** (reading and preserving half-built work costs more than a clean build) · `FIX` ×0.7 · `REFACTOR` ×1.2 · `INTEGRATION` ×1.25 · `SECURITY`/`DATA` ×1.3 · else ×1.0.

**c. Module total:**

```
T_module = Σ T_gap + waves × 185k + (429k + 15k × packets) + 429k + screens_touched × 382k × 1.5
P50 = T_module × 1.28          P80 = P50 × 2.00
```
(`waves` = 1 + packets colliding on a shared file; the last term is rendering repair including the regression round every real UI sweep produces.)

Floors: any module with an accepted gap costs ≥1.0M TEQ. **Any single gap over 3M is not one gap** — split it or route it to a vertical-slice implementation skill and say so.

**d. Every estimate carries six fields:** `P50` · `P80` · `confidence` · `primary driver` · `largest unknown` · `historical analogue` (a real prior build + its actual TEQ, or "none — modelled"). Confidence: `HIGH` = E3/E4 + an analogue in this repo · `MED` = E2/E3 + a cohort anchor · `LOW` = E1, unsettled shape, or a cohort with **n < 10**. **A LOW-confidence gap is quoted at P80 only** — a P50 on an unsettled shape is a made-up number wearing a lab coat.

### 5.4 Engineering size — the second number, deliberately uncalibrated

From the same score: 0–3 `XS` · 4–7 `S` · 8–12 `M` · 13–17 `L` · 18–22 `XL` · 23–27 `XXL` (= decompose before quoting). Plus risk `LOW/MED/HIGH` from unknowns + incumbent quality + one-way-door status.

**Do not convert size to calendar time.** There are zero human-hour observations behind it. The report says: *"size is relative — XL is bigger than L, not '6 weeks'."* Record real hours in `calibration/actuals.csv` when they exist; publish a mapping only then.

### 5.5 Two mandatory cross-checks

**A — top-down:** `screens_needing_work × 900k`. Differ by >2× from bottom-up ⇒ the module is `LOW-CONFIDENCE` and says so. **Never average them into a comfortable middle** — find which assumption broke (usually: top-down assumes cost is screen-shaped, and this module's cost is integration or data).
**B — historical actual:** if this module was ever built or swept, its real cost is on disk. **A measured actual outranks the model** — quote it as `basis: measured (<run>)`.

### 5.6 Not estimated, and say so in every report

Review time · product decisions (a one-way door is priced; the deciding is not) · requirement churn · the survey's own cost · anything in a parked module.

**What the survey itself costs:** `≈ 3.0M + 0.8M × screens` TEQ per module. A 4-screen module ≈ 6.2M; 16 modules ≈ 100M — about the cost of building **one** average module. That is the argument for doing it: it is cheap relative to building the wrong thing first.

### 5.7 The calibration loop

Anything scoped here that later gets built produces an actual. Append `module, gap-id, type, lanes, score, estP50, estP80, actualTEQ, cohort, model, note` to `calibration/actuals.csv`. At **≥5 actuals in a cohort**, replace that anchor with the measured median and record the sample size. Track `bias = median(actual) ÷ median(estimate)`; **a bias > 1.3 means the decomposition is missing a lane**, not that the anchor is too low. **Never delete a bad estimate** — an anchor is trustworthy only because the misses were kept.

### 5.8 Banned

One number without the six fields · TEQ as schedule or headcount · a module priced without its gaps · story points or hours from a rubric with no time observations · pricing from a title instead of `files[]` + `lanes[]` · summing medians for a portfolio · a P50 on a LOW-confidence gap · adding strong-model TEQ to cheap-model TEQ · an anchor with n<10 quoted without its ⚠ and its n · this document outranking `calibration.json`.

---

## 6 · Efficiency — where the money actually goes

**The browser is ~60% of the bill.** Every lever below either avoids a browser context or makes one cheaper; trimming prose is rounding error.

- **L1 Model tiering.** Scout and estimator follow fixed templates — run them cheap. S2 and S3 judge completeness and persona reality — run them strong. Same token count, one fifth the price. *Do not* cheap-out the surveyor: it scores checks 3/6/8, which is exactly what separates a working capability from a facade.
- **L2 Small-module lane.** ≤2 routes ⇒ S1+S2 in one process, S3+S4 in another — each still dispatching its own sub-agents, so the read-bans survive.
- **L3 Walk only what claims to exist.** A capability code already resolved to `NOT_STARTED`/`BACKEND_ONLY` is a finding on E2 evidence; walking to it can only confirm an absence code already proved. A module whose capabilities are all `NOT_STARTED` gets **zero walks** — correctly, and for ~1.6M less.
- **L4 Prior-art delta.** For a module with a dated prior audit: pre-seed coverage as E3 (dated), `git diff --name-only <prior commit>..HEAD` scoped to the module, and walk only what changed, what the prior run left unresolved, and every spine edge. Label carried rows `basis: prior-run <id>` so their age is visible. **Guardrail:** prior art expires — a row older than the module's last commit is re-verified, and a prior-run row **never** satisfies checks 3/6/8. Verify the prior run actually executed; a preflight stub is not prior art.
- **L5 Browser primer.** The first walker in a module writes `.work/<m>/primer.md` (≤25 lines: how to log in, where the module lives, which seeded records sit in which state); every later walker gets it inline. ~15% off walkers 2..N, and it removes the commonest cause of a walker wandering out of budget.
- **L6 Budget guard.** Ceiling in `STATE.json` at S1: `3.0M + 0.9M × walkable capabilities`. At 100% the conductor finishes the unit and **parks the module** with `budget-exhausted` rather than continuing. A parked module is honest and re-runnable; an unbounded one eats the night.
- **L7 Never re-ingest the skill corpus.** A stage process reads **one** stage file + its agent-prompt section + the taxonomy card. Resume is HANDOFF → STATE → named work file. This SKILL.md is for humans and skill-matching.
- **L8 Scripted inventory.** Routes, source units and exported handlers cost **0 TEQ** from a script. One surveyor scores the checks instead of one strong agent per entity.
- **L9 One walker per module.** Login, primer and disclosure ritual paid once; units run sequentially in the same agent.
- **L10 Screenshots on deviation only.** A happy-path step is a text line.
- **L11 Truncate, don't re-dispatch for style.** An over-cap return is truncated to schema; re-dispatch only when a **required field** is missing.
- **L12 Hypothesis walk, not persona-day tour.** S2 already predicts most priced S3 gaps. `walk = hypotheses.json ∪ claimed-WORKS edges`; ≤5 claim-walks instead of 3 goals × 8 screens.

**Deliberately NOT done:** parallel modules (file-disjoint and safe, cuts wall-clock ~30%, saves **zero tokens** — pointless when the constraint is quota, and it doubles crash blast radius) · dropping the disclosure sweep (cheaper and wrong) · merging S1 into S2 (kills the read-ban that makes the yardstick independent) · splitting a unit below one handoff (a handoff costs ~40k; a half-walked unit crossing it is how the relaunched process invents the other half).

> **Efficiency that reduces evidence is not efficiency.** L12 removes duplicated confirmation tours, not checks 3/6/8 on the claims that need them.

---

## 7 · Style and hard caps

**Caveman-technical.** Drop articles, hedging, restating, process narration. Keep ids, paths, numbers, `file:line`, codes, verdicts. Prose only in: `VERDICT`, `## The picture`, `EXEC-SUMMARY.md`.

| output | cap | on breach |
|---|---|---|
| public `<module>.md` | **90 lines** | assert-brief fails the stage; S4 rewrites from template |
| public headings | STATUS + the 5 template sections | **no `## S1/S2/S3/S4`** |
| `## What matters` | 8 bullets | drop S2/S1/S0 to the one-line table |
| every gap on the brief | 1 table row | never the full JSON schema |
| worker return | **12 lines** | truncate; re-dispatch only if a required field is missing |
| `.work/s1.md` / `s2.md` | 60 / 80 lines | pointers, not ledgers |
| screenshots per unit | 12, deviation/blocker/persist-fail only | stop |
| source files per worker | 6 per cluster | stop |

`?` beats a guess. Stop when the deliverable exists.

---

## 8 · Agent prompts

Substitute the profile at dispatch. **Never tell a worker to read this SKILL.md.**

```
APP    = <profile.appRoot>          OUT  = <profile.out>
SKILL  = <this skill dir>           WORK = <OUT>/.work/<module>
MF     = <OUT>/<module>.md          <- HUMAN BRIEF. Scripts write it. LLM patches 3 sections at S4.
```

**Preamble (every worker):**
```
STYLE: caveman-technical. no articles, no hedging, no restating input. tables over prose.
CAPS:  return <=12 lines. read <=6 source files per cluster. every claim carries a pointer.
       over cap: TRUNCATE to schema, flag OVERCAP. re-dispatch ONLY if a required field is missing.
STOP:  deliverable exists => stop.
MF LAW: NEVER write ## S1/S2/S3/S4 onto <MF>. Evidence goes to <WORK> JSON. Scripts own <MF>.
HANDOFF: S2 at 35% (per cluster). S1/S3/S4 at 50% (per unit).
       finish CURRENT unit, write <WORK> JSON, write HANDOFF.md, END TURN. never mid-unit.
CARD:  <SKILL>/TAXONOMY-CARD.md      TEMPLATES: <SKILL>/templates/
```

**0 · Cartographer (strong) — A1, once.** Build the spine: work items moving between modules. Read ≤20: routing/nav source, module entry points, schema FKs, domain docs, PRDs **last**. Code graph first if one exists; never silent grep-only. Every edge gets `from|to|carrier|trigger|payload|receiver|reverse|ev`. **Blank receiver = the finding. Owner = who must build the carrier.** → `SPINE.md` + `edge-queue.md`. Return: `EDGES <n> | blank-receiver <n> | human-memory <n> | diffs <n>` + worst 5 + unowned ids.

**1 · Scout (cheap) — S1, one per module.** What SHOULD exist. **NO code, NO routes, NO inventory files, NO browser.** Read ≤8 from `profile.docs.sources` + `SPINE.md`. → `s1.json` (persona, ≤3 goals, caps with `src` + `crit`), `s1.md` ≤60. `src` order persona → role → spine → prd LAST. Return: `CAPS <n> (persona/role/spine/prd) | goals <n> | ANCHOR <pass|FAIL>`.

**2 · Surveyor (strong) — S2, ONE per module, never one per entity.** What ACTUALLY exists, E2 `file:line`. **NO BROWSER.** Start from `skeleton.md` then `static.md` (0 TEQ), then targeted reads ≤6 per cluster. → `coverage.json` · `hypotheses.json` (≤5, each with `unsettleableBy` + `strongestAlternative` + `altCheck` already grepped) · `gaps.jsonl` (S2-settled only; `lanes[]` + `files[]` required) · `s2.md` ≤80. Then run assert-hypotheses + render-brief. **Forbidden:** `FUNC_COMPLETE` from static; queueing a blank/no-op carrier as carrier-works. Return: `caps <n> | walkable <n> of <m> | hyp <n> | S2-gaps <n>`.

**3 · Walker (strong) — S3, ONE agent, hypotheses then claimed-WORKS edges.** Cheapest disproof: `confirm | falsify | NEEDS-VERIFY` a named id. Not a tour. Persona role, not admin. Reload after save. Primer first. Disclosure only on screens the hypothesis names. Standing rules: **last 15 lines only**. C1/C6 ⇒ five-check not-found on the walk file. New gaps only if they **block** the current claim. → append JSONL to `gaps.jsonl`, narrative ≤40 lines in `gaps-<id>.md`. Return per unit: `H-nn/EDGE | confirm|falsify|NEEDS-VERIFY | GAPS <id>|<code>|S<n>|<6 words>`.

**4 · Estimator (cheap) — S4.** **Do not re-derive TEQ.** Run estimate → render-brief → edit only VERDICT / The picture / What matters → run assert-brief; **fail the stage on exit 1**. Forbidden: source, screenshots, stage-dump headings, rollup arithmetic in prose. Return: `GAPS <n> | COMPL <n>% -> <n>% | P50/P80 | SIZE | CONF | BRIEF <n> lines`.

**5 · Synthesizer (strong) — S5, once.** Read briefs (STATUS + What matters + gap table) + `estimate.json` + `SPINE.md` only. → `DEPS.md`, `ROADMAP.md`, `EXEC-SUMMARY.md`, `_INDEX.md`. Return: `MODULES | APP % | P50/P80 | CRITICAL PATH | TOP5`.

---

## 9 · Script contracts — generate these at A0

All take `<module-slug> [appRoot]`, default `appRoot` from the profile, exit non-zero on contract failure, and print one line. **No LLM inside any of them.**

**`inventory-skeleton <m>`** → `.work/<m>/skeleton.md`: routes/entry points (from `routeDiscovery.cmd`), source units (`sourceDirs`), exported handlers/actions, and each one's file path. Deterministic, 0 TEQ.

**`inventory-static <m>`** → `.work/<m>/static.md`: for each handler — is it behind an authz guard (`authz.guardGrep`)? does it write to the audit log (`audit.writerGrep`)? does it write a status/state field? which spine edges does this module own? These are exactly the facts a surveyor would otherwise burn reads discovering.

**`assert-hypotheses <m>`** — fail unless `hypotheses.json` exists, parses, has ≤5 rows, and every row has `id` (unique), `claim`, `predictedCode`, non-empty `files[]`, `unsettleableBy ∈ {persist,perms,downstream,carrier-works}`, `strongestAlternative`. An empty list is legal **only** with `noneBecause`.

**`estimate <m>`** → `.work/<m>/estimate.json`, implementing §5.3 exactly. Also: fold duplicates (explicit `foldInto`, or identical `files[]` + same wound); skip `falsify` and `NEEDS-VERIFY` rows from pricing but keep them listed; force an `analysis` lane onto any LOW-confidence gap; null the `p50` on LOW-confidence (P80 only); flag `over3m` gaps; roll up severity counts, engineering sizes, module size/risk, `weakAnchorExposureTeq`, cross-check A, and lists for `needsVerification` / `notPriced` (no `files[]`) / `needsYourCall`.

**`render-brief <m>`** → `<out>/<m>.md` from `coverage.json` + `gaps.jsonl` + `estimate.json` (+ `s1.json`), to the §10 template. Writes STATUS `actual` when there is no estimate yet, `estimated` when there is. **Invents no number it cannot quote.** Run after S2 and again after S4.

**`assert-brief <m>`** — fail if: >90 lines · any `## S1/S2/S3/S4` heading · missing `STATUS:` · missing `## What matters` · missing `## All gaps`.

**Completeness maths (shared, in both estimate and render-brief):**
```
passRatio(cap)   = passed checks / applicable checks        # NA excluded; '?' counts as not passed
completeness     = Σ (crit × passRatio) / Σ crit            # weighted by capability criticality
afterBacklog     = same, with +0.25 ratio (capped at 1.0) for every capability named by an
                   accepted, non-folded, non-UX-only gap
```

---

## 10 · The deliverable

`<out>/<module>.md` — **≤90 lines**, written by scripts, three prose blocks patched by an LLM at S4. Evidence lives in `.work/<module>/` and is never dumped here. A `## S3 GAPS` heading on this file is a defect.

```markdown
# <module>

STATUS: <expected|actual|gaps|estimated|DONE|PARKED:<reason>>  updated <ISO>
COMPLETE: <n>%  ->  <n>% after backlog
GAPS: <n> (S4 <n> · S3 <n> · S2 <n> · S1/S0 <n>)  DANGEROUS <n> · needs-verify <n>
EST: P50 <x>M · P80 <x>M TEQ · size <XS-XXL> · risk <L/M/H> · conf <HIGH/MED/LOW> · basis <borrowed|measured>
VERDICT: <one plain sentence you could repeat in a meeting>

## The picture
<2-4 sentences. How done it is. The one headline lack. Spine vs capability if they disagree.>

## What matters, ranked
S4 / S3 / DANGEROUS / one-way doors only. Worst first. <=8 bullets. Always one 🟢 that works.
- 🔴 <what breaks, for whom> (G-nn, S4)
- 🟠 <daily tax> (G-nn, S3)
- 🟢 <what works end to end>
- ⚠ <number-health: LOW conf / weak anchor n=<n> / cross-check split>

## Numbers
| | |
|---|---|
| functionally complete | <n>% now → <n>% after backlog |
| backlog | P50 <x>M / P80 <x>M TEQ · conf <x> |
| cheapest big fix | <G-nn> at <x>k — <what it buys> |
| engineering size / risk | <XS–XXL> / <L·M·H> — **not a schedule** |

## Not finished / needs you
- **needs-verify:** <ids or none>
- **your call:** <ids or none>
- **not walked:** <goals / edges / screens, by name, or none>

## All gaps, one line each
| id | sev | ⚠ | what (plain words) | type | size | P50 | conf |
|---|---|---|---|---|---|---|---|
| G-nn | S3 | | <=12 words | FIX | S | 0.9M | MED |

Evidence: `.work/<module>/` · estimate: `.work/<module>/estimate.json`
```

**Work files:** `s1.json` (persona, goals, caps+`src`+`crit`) · `coverage.json` (per cap: `state`, `crit`, checks `1..9 ∈ {v,x,?,NA}`, `pointers[]`) · `hypotheses.json` · `gaps.jsonl` (one JSON object per line: `id code sev dangerous what type ev conf files[] lanes[] foldInto policyClause hypothesisId outcome caps[] reach crit needsCall uxOnly complexity{9 drivers}`) · `estimate.json` · `HANDOFF.md` · `STATE.json` · `primer.md` · `gaps-<id>.md`.
**App-level:** `SPINE.md` · `edge-queue.md` · `standing-rules.md` · `rejected.md` · `deferred.md` · `ROADMAP.md` · `DEPS.md` · `EXEC-SUMMARY.md` · `_INDEX.md`.

**`standing-rules.md` carries across modules** — that is where the compounding saving lives. One line, imperative, with provenance:
```
- a receiver that must be told the item number is MANUAL, not a hand-off   [spine, standing order]
- the redesign of the scheduling board is deliberate — never a finding     [scheduling, standing law]
- every work-item number links to its detail page                          [standing order]
```
**Findings per surface should fall as the sweep proceeds.** If they do not, the promotion step is broken — fix it before scoping another module, because every un-promoted rule is a duplicate line and a double-counted price.

---

## 11 · Banned patterns

Conductor reading source, docs, ledgers or screenshots "just to check" · slicing a ledger in the conductor instead of pointing a worker at it · scout reading code · surveyor opening the browser · walking a persona day when `hypotheses.json` exists · writing a gap before S2 exists, or a price before `lanes[]` and `files[]` exist · recording an absence without the five-check protocol · judging a screen whose disclosures were never opened · holding a verdict in chat across a dispatch · one agent per goal / edge / entity · re-dispatching a worker only because it went over 12 lines · reading this SKILL.md from a stage process · appending `## S1`–`## S4` onto the public brief · scoring one module against a different bar than its neighbour · quoting a number that is not in `estimate.json`, or an anchor without its `n` · presenting TEQ as schedule · **building, patching, or "quickly fixing" anything.**

## 12 · Boundaries

This skill **diagnoses and prices**. Repairing rendering, retrofitting a screen, building the backlog, or filing issues are other skills' jobs — hand them the brief and stop.
