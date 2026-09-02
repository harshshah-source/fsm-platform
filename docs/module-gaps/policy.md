# Verdict policy — copy into every run dir as `policy.md` before judging


Every verdict cites its clause. No clause fits → `D`, with the reason.
Verdicts: **A** accept · **B** accept with a note (the note overrides) · **C** reject → `rejected.md` · **D** defer → `deferred.md`, *needs your call*.

**Bias toward recording, never toward inventing.** A wrong `A` costs the user two seconds to strike out; a wrong `C` is a gap they never hear about. Clauses P6–P8 exist to stop the inventing.

**Evidence** — P1 absence must be earned (`TAXONOMY-CARD.md`, five checks) · P2 `E0` is never a finding, `E1` alone caps confidence at LOW · P3 a contradiction between code and browser is a **finding** (C3/C4) at the severity the *user's* experience implies, never the code's · P4 no reload, no persistence claim · P5 an admin session cannot judge permissions.

**Judgment** — P6 **persona cost is the currency**: accept only if a named person is measurably slower, blinder, more error-prone, or leaves the app; a costless workaround → `C` · P7 severity is set by process consequence, **never by fix cost** (a one-line fix to a process-blocker is still S4) · P8 reach and criticality are evidenced from the persona's frequency lines and the spine, else score 1 and say why · P9 **control and audit gaps outrank display gaps** — any P-class finding, and anything touching money, stock, compliance, safety or an audit trail, is `A` + DANGEROUS and hoisted above every C finding regardless of price · P10 documented standing law (design system, prior deliberate decisions) beats the worker: contradicting it makes the finding `B`, the note being the rule · P11 **fold, don't stack** — the same gap seen twice is one finding with two evidence lines; **double-pricing destroys the roadmap's credibility** · P12 one-way doors (deleting data, changing a grant, altering a posted record, destructive migration) are `D` but still priced — a decision whose cost is hidden cannot be weighed · P13 **cap 9 accepted findings per surface**; keep the worst and roll the tail into one line (`+N minor, ≈X TEQ, see …`) — **never silently drop it**, an invisible cap reads as "that is all there is" · P14 rendering defects are `UX` and go to a rendering list, never the feature backlog — getting this wrong tells the user to rebuild a screen that needed a CSS fix · P15 unpriceable ⇒ not `A`; it is `D` with reason `needs scoping` · P16 `O4` process gaps go to an appendix, never summed into the backlog · P17 **earlier modules bind later ones**: app-level `standing-rules.md` and `rejected.md` carry across the sweep; already rejected app-wide → `C` on sight, citing the earlier module.

**Budget** — P18 an exhausted budget is **reported, never hidden**: screens not walked, states not reached, listed by name with the cost of a deep pass; a partial survey that reads as complete is worse than no survey · P19 `UNTESTABLE` is a legitimate result — say what data or permission would make it testable; that seeds the next run's fixtures.

**Output** — P20 caps bind (`SKILL.md` §7) · P21 hand off on the percentages, mid-unit never · P22 no unrequested file, no "supporting analysis", no appendix; the run directory is not a scratchpad · P23 cheapest sufficient evidence: **a browser context costs ~800k TEQ, a grep costs ~2k.**

**Escalation** — park the **module** (never halt the sweep) for: dev server dead after one restart · login blocked · browser driver down · module boundary unresolvable · no persona identifiable. A parked module is `NOT SCOPED — <reason>` in the roadmap.

---

