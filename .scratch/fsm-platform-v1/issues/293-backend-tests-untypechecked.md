# 293 — Backend spec files are not typechecked, and a signature change slipped through because of it

Status: **ready-for-agent**
Type: Bug · Tooling · Backend · S
Found: 2026-08-28, by the full backend run at the end of the Scheduler Console slice — **after**
`npx tsc --noEmit` had reported the backend clean.

---

## What happened

`apps/backend/tsconfig.json` is `"include": ["src/**/*.ts"]`. Nothing typechecks `test/`, and
`vitest` transpiles without checking types. So `npx tsc --noEmit` — the command every session in this
programme has treated as *the* backend typecheck — is blind to ~430 spec files.

The Console slice's **B5** gave `DashboardService.actionRequired` a `filters` parameter, inserted
**before** the existing trailing `now`:

```ts
actionRequired(scope, now)                        // before
actionRequired(scope, filters = {}, now = new Date())   // after
```

Two specs called it positionally as `actionRequired(scope, NOW)`. After B5 that hands the frozen test
clock to `filters` and lets `now` default to the **real** clock, which moved a 7-day cutoff by two
months and made a deliberately-not-overdue fixture start counting. It surfaced as
`expected 2 to be 1` in `waiting-component-escalation.e2e-spec.ts` — a wrong number, not a type error,
which is the expensive way to find this.

Both call sites are fixed. This issue is about the three reasons it got that far:

1. **No typecheck.** `Date` is not assignable to `{ zoneId?: string }`; a compiler pointed at `test/`
   would have said so at the moment of the edit.
2. **A parameter inserted before an optional trailing one is a silent break** for every positional
   caller. It compiles, it runs, it returns plausible numbers.
3. **A changed-route spec run does not cover it.** These two specs call the *service* directly, so
   the previous session's "specs for every route this session changed pass" was true and still
   missed them. Only the full suite catches it.

## Acceptance criteria

- [ ] AC1 — `test/**/*.ts` is typechecked. A separate `tsconfig.test.json` extending the base is
      likely cleaner than widening `include`, so `tsc --noEmit` for `src` stays fast and the two are
      separately runnable.
- [ ] AC2 — Whatever that check surfaces across the existing specs is **fixed or explicitly listed**,
      not silenced with a blanket `skipLibCheck`-style escape or `any`.
- [ ] AC3 — The typecheck command that the workflow docs tell a session to run covers both, so
      "typecheck clean" means what every session has assumed it means. Update
      `docs/agents/workflow.md` if it names a specific command.
- [ ] AC4 — A regression test or lint rule is **not** required for the parameter-ordering habit; AC1
      makes it a compile error, which is the durable fix.
