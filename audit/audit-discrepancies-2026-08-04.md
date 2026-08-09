# Discrepancies note — where the two 2026-08-04 audits were wrong, stale, over- or under-claimed

Written while building the remediation epic ([#197](../.scratch/fsm-platform-v1/issues/197-mobile-pilot-readiness-remediation-epic.md)).
Every finding in both audits was re-verified at its cited `file:line` before being turned into a slice.
This note records only the places where verification **disagreed** with the audit, plus what neither
audit caught.

Audits under review:
- `mobile-device-readiness-2026-08-04.md` (audit 1)
- `mobile-contract-sync-audit-2026-08-04.md` (audit 2)

---

## 1. Where the audits were wrong or over-claimed

### 1.1 Audit 2 over-claimed on #169's acceptance criterion (finding E)

It said #169's AC — *"the un-versioned path either redirects or is retired deliberately"* — **"can
never be satisfied without breaking admin"**, and framed the permanent dual-serve as a contradiction
of the AC's own wording.

**Wrong.** The AC is satisfiable in the intended order: repoint admin, *then* retire the alias. The
dual-serve was ratified as an explicitly time-boxed migration window, not a permanent design —
`mobile-backend-freeze-plan-2026-07-28.md:165`, `mobile-backend-independent-assessment-2026-07-28.md:318`,
and #169's own landing note at `:149-152` (*"the neutral alias is the migration window — do not remove
it until the admin client is repointed, which is a deliberate follow-up, not a tidy-up"*). What is
genuinely true — and what audit 2 under-claimed — is that **the follow-up was never filed**. Now
[#212](../.scratch/fsm-platform-v1/issues/212-admin-repoint-api-v1.md).

Consequence for the plan: this was going to be filed as a decision issue ("retire or keep co-equal?").
It is not a decision. It is already decided and simply unexecuted.

### 1.2 Both audits said "Issue: none" for findings that had owners

Audit 2 already flagged this failure mode after discovering #58 owned the troubleshoot-photo gap.
Duplicate-checking all ~15 "Issue: none" findings against the 218-file tracker found **eight** with
owners:

| Finding | Audit said | Actual owner |
|---|---|---|
| A1 — no token refresh (**the highest-severity finding in either audit**) | "Issue: none" | **#186**, whose AC#2 already says *"every authenticated call"* |
| D1 — day-plan removal signal unread | "none (#66 done; gap unfiled)" | #161 shipped the fields; #66 explicitly evaluated and declined the server-signal option |
| Offline durability | "#17" (correct) | confirmed #17, blocked on #82 |
| B1 — `BigInt` 500 | "none" | #174 owns request validation |
| D8 / D11 / B9 | partly "#169 family" | confirmed #169 items 2 + 7, #174 |
| Component-request terminal states | "none" | #22 + FE-15 + #62 |
| Admin availability | "none" | **#25** |
| Dev credentials | "#194" (correct) | confirmed — but #194 *explicitly excludes* work data, which nothing owned → #210 |

Only three of audit 2's "none" findings were genuinely unowned: admin media display, admin
notification consumption, and label parity.

### 1.3 Audit 1's `app.json` premise was already stale when written

Audit 1 was asked to check whether `app.json` still lacked `android.package` and was named "mobile".
It correctly reported this as **already fixed** (`app.json:3,16` — `in.autoplant.fsm`), but the
framing in the request implied otherwise. Recording it so the fix is not re-attempted: #170's decision
3 identified it, and #54's 2026-08-03 comment landed it.

### 1.4 Audit 2 rated B2 (`FAILED_ACTIVATION` badge) as a live defect in its "harmless" tier

Verified as **genuinely latent, not merely low-severity**: `VerificationScreen` is only rendered when
`state.status === 'verification-pending'` (`TicketDetailScreen.tsx:188`), and an install ticket never
enters `VERIFICATION_PENDING` — it goes `ACTIVATED → CLOSED | FAILED_ACTIVATION`. So the missing map
entry cannot be reached through the normal lifecycle. It remains worth fixing as an instance of the
`Record<string, …>` typing hole, which is why it sits in
[#205](../.scratch/fsm-platform-v1/issues/205-contract-typing-shared-enums.md) rather than in a
user-facing bug slice.

---

## 2. Where the audits were right but under-claimed

### 2.1 The SLA label divergence is a spec violation, not a design difference

Audit 2 filed C1 as an inconsistency needing a ruling. The PRD **does** rule: `PRD:824-834` and
`PRD:302` label buckets by severity name, with the time range as the definition column, and `PRD:517`
applies the same vocabulary to mobile. **Mobile is conformant; admin is the deviating surface.** No
decision is needed — it is a conformance fix.

Additionally, and caught by neither audit: the desktop reference image
`docs/ui/desktop/v2-reference/01-dashboard-zonal-manager.png` labels its bucket columns by time range
**and its band boundaries (`<4H`, `4-8H`, `8-16H`, `16-20H`, `20-24H`, `24H CRIT`, `<5D`, `>10D`) do
not match the PRD's own bands** (8-12h, 12-24h, 24-48h, 48-72h, 3-5d, 5-7d, 7d+). Per
`docs/agents/domain.md:37` the PRD wins and the discrepancy must be documented — now an AC on
[#208](../.scratch/fsm-platform-v1/issues/208-label-vocabulary-parity.md).

### 2.2 Admin notification absence has a specified shape

Audit 2 reported D5 as "admin consumes no notifications". True, and the fix is more constrained than
that implies: `PRD:213` + `workflow:1471-1483` specify in-app manager notification per event, but the
delivery surface is an **Action Required panel + header badge** (`PRD:99`, `:354`, `:384`) — the admin
page inventory at `PRD:320-345` contains **no** notifications page, while the SE mobile screen table at
`PRD:499` does. Building an inbox would invent a surface. Recorded as explicitly out of scope on
[#206](../.scratch/fsm-platform-v1/issues/206-admin-manager-action-surface.md).

### 2.3 The intraday gap is a false acceptance criterion, not just an unbuilt page

Audit 2's D4 said admin displays 0 of 5 insertion states. The sharper finding: **#29 carries
`[x] Intra-day Queue reflects PENDING_ACCEPTANCE / ACCEPTED / DECLINED status in real time`, and its
disposition asserts the admin page "consumes `/api/intraday-insertions`"** — both false, with zero such
references anywhere in `apps/admin/src`. FE-13 shipped the columns as "forward-compatible placeholders"
and filed no follow-up; #29 then ticked its own admin AC on the assumption FE-13 had bound them. The
gap was invisible precisely because the paperwork said it was done. Corrected in place on #29.

### 2.4 The one-active-device policy is handset-scoped in every ratifying document

Audit 2 called the cross-surface kill "by design (#91)". More precisely: **every rationale sentence in
every ratifying document is handset-framed** (`mobile-backend-freeze-plan-2026-07-28.md:423`,
`#91:371-384`, `#54:46-48`, `#76:125-129`), and no document extends it to the admin dashboard. The
implementation is per-`userId` with `device_id` stored but never compared
(`prisma-refresh-token-store.ts:47-50`). So admin-kills-mobile is an **unratified side-effect**, not a
design decision — which is what makes [#199](../.scratch/fsm-platform-v1/issues/199-decision-one-active-device-cross-surface.md)
a legitimate decision issue rather than a bug report.

### 2.5 The day boundary is not merely undocumented — it is unexamined

Audit 2's C7 noted three definitions of "today". Verification found something stronger: **the only IST
reference in the entire 218-file backlog is an unrelated prose aside in #122**, and no document in the
authority chain (`CONTEXT.md`, PRD, workflow, backend design docs, ADRs) defines a day boundary at all.
`fsm-backend-low-level-design.md:113` ("IST is a display concern only") is a *storage* convention that
is routinely misread as answering this. `utcDayStart` reached ~15 call sites as a side-effect of #146's
slice 3, never as a decision.

---

## 3. Materially broken things neither audit caught

| # | Finding | Evidence | Now owned by |
|---|---|---|---|
| N1 | Two screens instruct **"Pull to retry"** and `RefreshControl` appears **zero times** in the entire mobile app. The gesture does nothing; switching tabs re-runs the same effect with the same dead token. There is no in-app recovery from the A1 stuck state at all. | `StockScreen.tsx:80`, `TicketDetailScreen.tsx:273`; grep count 0 | #186 |
| N2 | **`@react-native-community/netinfo@12.0.1` is a major version above what Expo SDK 54 expects (11.4.1)** — and it is the native module backing `connectivity.ts`, i.e. the app's entire offline detection. A native-build risk *and* a correctness risk in the exact subsystem A1 already misuses. (`expo@54.0.35` vs `~54.0.36` is the trivial other half.) | `npx expo install --check`, run 2026-08-04 | #209 |
| N3 | **No error boundary** in `apps/mobile` (or `apps/admin`). An unhandled render throw white-screens the app with no recovery — poor for any user, worse for a field trial with no debugger attached. | zero `ErrorBoundary`/`componentDidCatch` hits | #209 |
| N4 | **`SYSTEM-STATE-2026-07.md` contradicts itself**: §1 (`:77-79`) says mobile is "auth shell only… every M-series surface is unbuilt", §4.4 (`:802-806`) says "substantially built as of 2026-08-04". The convention requires editing in place; §1 never was. | both cited | #211 |
| N5 | **#29's AC#6 is factually false** (see 2.3). | `grep` = 0 hits in `apps/admin/src` | #206 + #29 |
| N6 | **#38's photo-lightbox AC was silently broken by #81** changing `photoRef` from a URL to an opaque media id. True when written; false now. | `VoucherReviewPage.tsx:291` | #203 + #38 |
| N7 | **Six mobile issues sit at `ready-for-agent` with every AC ticked** (#55, #57, #59, #60, #147; #58 nearly). Conversely ~25 issues are `done` with unticked ACs (#128 has 15). "What is left on mobile" cannot be answered correctly from the tracker. | per-file check | #211 |

---

## 4. Verification status of previously-INFERRED claims

Audit 1 in particular leaned on inference. Promoted this session:

| Claim | Was | Now |
|---|---|---|
| Access TTL is 15 minutes | source-only | **OBSERVED** — live token `exp − iat` = 900s |
| Expo Go cannot run this app | INFERRED | **OBSERVED** — `react-native-keychain@10.0.0` ships `android/` + `ios/` native dirs |
| Release builds block cleartext `http://` | INFERRED | **OBSERVED (by absence)** — no `expo-build-properties`, no `usesCleartextTraffic` anywhere |
| Logout will 500 after the next backend restart | INFERRED | **OBSERVED by code path** — `auth.service.ts:44-47`; `DeviceTokenService` *is* injected via `AuthModule`, so `?.` does not save it. Fires only on a **valid** refresh token (an unknown token no-ops at `revoke`) |
| `CLAUDE.md` mobile line is stale | asserted | **CONFIRMED**, and `SYSTEM-STATE` §1 is stale the same way (N4) |
| Guard 401/403 carry no `code` | source-only | **OBSERVED** — live probes returned `{"message":"Unauthorized","statusCode":401}` and `{"message":"Forbidden","statusCode":403}` |
| Intraday `BigInt(id)` 500 | source-only | **OBSERVED** — live probe returned a 500 with a correlationId |

**Still untested, and recorded as such rather than assumed:** the Android **Gradle** build itself.
Running it generates `apps/mobile/android/`, which was outside the report-only scope of both audits and
of this planning pass. It is #209's first acceptance criterion for exactly that reason — the JS bundle
building clean (verified, exit 0, 1,036 modules) says nothing about autolinking, native permissions, or
the keychain on a real device.
