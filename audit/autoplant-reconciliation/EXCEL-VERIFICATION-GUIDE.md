# Excel Verification Guide — NUVISTA

**For:** Excel 2016, no prior PivotTable experience assumed
**File:** `docs/autoplant/SUMMARY_REPORT.xlsx`, sheet `Sheet 1`
**Scope:** NUVISTA only. Every other company is out of scope here.
**Purpose:** let you confirm the reconciliation findings by hand before any code change lands.

Every number in this guide was recomputed from the workbook specifically for this document, not
copied from the earlier report. **One figure came out different — see the box in Check 7.**

---

## Read this first — 6 traps

**Trap 1 — Filtered row numbers lie.**
When you filter, Excel keeps the *original* row numbers. Scroll to the bottom of a filter showing
7,650 rows and you will still see something like row 25,209. That is not your count.
**Always read the count from the status bar at the bottom-left**, which says
`7650 of 25214 records found`. If you don't see it, right-click the status bar and tick **Count**.

**Trap 2 — Sum vs Count.**
Every column you will put into **Values** is *text*, not a number. If Excel defaults to **Sum**
you will get `0`. You must change it to **Count** every time. Instructions are in Check 2.

**Trap 3 — Never group on plant alone.**
`Plant Name` is not unique across companies in the wider dataset. In *this* file every row is
NUVISTA (`Company Name` has exactly one value), so grouping on plant alone is safe **here** — but do
not carry the habit into any file that contains more than one company.

**Trap 4 — `DEVICE NO` leading zeros.**
4,715 of the 25,214 device numbers begin with `0` (e.g. `0867440069793735`). **Do not format that
column as a number** and do not use Text-to-Columns on it — Excel will silently strip the zero and
the value will stop matching FSM.
*If it has already happened:* press Ctrl+Z immediately. If you have saved and closed, do not try to
re-pad with a formula — close without saving and take a fresh copy of the file. A stripped ID looks
valid, which is what makes it dangerous.

**Trap 5 — The `Grand Total` row.**
Row **25216** is a decorative label row (it contains the word `Total` in all 24 columns, and no
numbers). It must be excluded from every pivot. Your data range is **`A1:X25215`** — header on row
1, data on rows 2–25215. Type that range in by hand rather than letting Excel guess.

**Trap 6 — `IMSI_NO` is not a key.**
23,596 non-blank values but only 23,566 distinct — including `899192250` repeated **23 times**
(9 digits; a real IMSI is 15). 1,618 are blank. Never join or de-duplicate on it.
Use `VEHICLE NO` or `DEVICE NO`.

---

## Check 1 — Total vehicles, and are they unique?

**1. What this proves.** That the file really holds 25,214 NUVISTA vehicles and that no vehicle is
listed twice, so nothing downstream is double-counted.

**2. Excel steps.**

*Part A — the total:*
1. Click any cell with data in it.
2. Press **Ctrl+End**. The cursor lands on **X25216** — the last cell of the `Grand Total` row.
3. So the real data ends one row above, at row **25215**. Data rows = 25215 − 1 (header) = **25,214**.

*Part B — uniqueness (work on a copy — this step deletes rows):*
1. Click the **column A header** to select `VEHICLE NO`, then press **Ctrl+C**.
2. Right-click the sheet tab at the bottom → **Insert** → **Worksheet** → OK.
3. Click cell **A1** on the new sheet, press **Ctrl+V**.
4. On the new sheet, delete the last row (the `Total` label) so you have the header plus 25,214 values.
5. Ribbon → **Data** tab → **Remove Duplicates** (in the *Data Tools* group).
6. Tick **"My data has headers"**. Click **OK**.

*What the screen should look like:* a message box reading
**"0 duplicate values found and removed; 25,214 unique values remain."**

**3. The number I should see.**
- Total data rows: **25,214**
- Distinct `VEHICLE NO`: **25,214** → 0 duplicates
- Distinct `DEVICE NO`: **25,214** → 0 duplicates
- (For contrast, `IMSI_NO`: 23,596 non-blank but only **23,566** distinct — proof of Trap 6.)

**4. Where to find the same number in FSM.**
Dashboard → **Fleet Directory** → find the **Nuvista** company row → **Mirrored Devices** column.
No filter needed if you are OPERATIONS_HEAD or CENTRAL_SERVICE_MANAGER. A Zonal Manager sees only
their own zone and cannot reproduce a company total.

**5. Should these two match? — NO.**

FSM will show **11,886**, not 25,214. This is expected and is *not* a bug. FSM deliberately never
creates a record for a vehicle that has only ever been Undeployed. Check 6 walks through this
properly. Do not treat this gap as a defect.

---

## Check 2 — Vehicles per plant (your first PivotTable — go slowly)

**1. What this proves.** That the 25,214 vehicles split across exactly 12 plants, and that the 12
plant counts add back to the total with nothing lost or double-counted.

**2. Excel steps.**

1. Click the **`Sheet 1`** tab. Click any single cell inside the data.
2. Ribbon → **Insert** tab → **PivotTable** (far left).
3. A dialog opens. In **Table/Range**, delete whatever Excel guessed and type exactly:
   `'Sheet 1'!$A$1:$X$25215`
   *(the straight quotes around `Sheet 1` are required because the name has a space)*
4. Under *Choose where to place*, select **New Worksheet**. Click **OK**.
5. You now have an empty pivot outline on the left and a **PivotTable Fields** panel on the right.
   The panel has a field list on top and four empty boxes below: **Filters, Columns, Rows, Values**.
6. In the field list, find **`Plant Name`**. Drag it down into the **Rows** box.
   → The 12 plant names appear down column A.
7. Now find **`VEHICLE NO`**. Drag it into the **Values** box.
8. **Check what it says.** The Values box will read either `Count of VEHICLE NO` or
   `Sum of VEHICLE NO`.
   - If it already says **Count of VEHICLE NO** — correct, continue.
   - If it says **Sum**, or your numbers are all `0`: click the item in the **Values** box →
     **Value Field Settings…** → in the *Summarize value field by* list choose **Count** → **OK**.

*What the screen should look like:* two columns — plant names down the left, a count beside each,
and a bold **Grand Total** row at the bottom reading **25214**.
*(That Grand Total is Excel's own calculation, not the file's row 25216 label.)*

**3. The number I should see.**

| Plant | Vehicles |
|---|---:|
| RISDA | 7,685 |
| NIMBOL | 5,100 |
| CHITTOR | 4,075 |
| ARASMETA | 1,309 |
| ODISHA | 1,268 |
| JOJOBERA | 1,133 |
| BIHAR | 1,071 |
| HARYANA | 1,017 |
| PANAGARH | 1,015 |
| SONADIH | 950 |
| MEJIA | 421 |
| OTHERS | 170 |
| **Grand Total** | **25,214** |

**4. Where to find the same number in FSM.**
Dashboard → **Fleet Directory** → expand the **Nuvista** company → its **plants** rows →
**Mirrored Devices** per plant.

**5. Should these two match? — NO, and the plant *names* will not match either.**

FSM stores 22 plant codes where the Excel shows 12 names. You must add FSM's codes together to
compare. FSM will show these totals (measured 2026-08-07):

| Excel plant | FSM plant codes to add | FSM total | Excel |
|---|---|---:|---:|
| RISDA | RCP-9211 + RCP-5151 + RCP_NVL_HUB | 3,271 | 7,685 |
| NIMBOL | NCP-9117 | 2,293 | 5,100 |
| CHITTOR | CCP-9115 + CCP-9236 | 1,970 | 4,075 |
| ARASMETA | ACP-9106 + ACP-9231 | 557 | 1,309 |
| ODISHA | OCP-5152 + OCP-9215 | 396 | 1,268 |
| JOJOBERA | JCP-9105 + JCP-9234 | 841 | 1,133 |
| BIHAR | BCP-5153 + BCP-9216 | 282 | 1,071 |
| HARYANA | HCP-9116 | 542 | 1,017 |
| PANAGARH | PCP-5150 + PCP-9214 | 620 | 1,015 |
| SONADIH | SCP-9232 + SCP-9104 | 588 | 950 |
| MEJIA | MCP-9233 + MCP-9107 | 357 | 421 |
| OTHERS | SURAT CEMENT PLANT | 169 | 170 |
| **Total** | | **11,886** | **25,214** |

FSM is smaller everywhere for the Check 6 reason. **What is worth confirming is the mapping itself**
— every one of those 22 FSM plant codes maps to exactly one Excel plant, with no vehicle landing in
two places. That part is clean.

---

## Check 3 — Deployed vs Undeployed per plant

**1. What this proves.** How the fleet splits between vehicles currently on a trip (Deployed) and
vehicles that are not (Undeployed) — the split the whole departure bug turns on.

**2. Excel steps.**
1. Build a new PivotTable exactly as in Check 2 (steps 1–5), same range `'Sheet 1'!$A$1:$X$25215`.
2. Drag **`Plant Name`** → **Rows**.
3. Drag **`Deployment Status`** → **Columns**.
4. Drag **`VEHICLE NO`** → **Values**, and confirm it reads **Count of VEHICLE NO** (Trap 2).

*What the screen should look like:* plants down the left, two data columns headed **Deployed** and
**Undeployed**, a Grand Total column on the right and a Grand Total row at the bottom reading 25214.

**3. The number I should see.**

| Plant | Deployed | Undeployed | Total |
|---|---:|---:|---:|
| RISDA | 1,823 | 5,862 | 7,685 |
| NIMBOL | 1,258 | 3,842 | 5,100 |
| CHITTOR | 1,272 | 2,803 | 4,075 |
| ARASMETA | 356 | 953 | 1,309 |
| ODISHA | 217 | 1,051 | 1,268 |
| JOJOBERA | 732 | 401 | 1,133 |
| BIHAR | 176 | 895 | 1,071 |
| HARYANA | 400 | 617 | 1,017 |
| PANAGARH | 506 | 509 | 1,015 |
| SONADIH | 454 | 496 | 950 |
| MEJIA | 326 | 95 | 421 |
| OTHERS | 130 | 40 | 170 |
| **Total** | **7,650** | **17,564** | **25,214** |

**4. Where to find the same number in FSM.**
Dashboard KPI strip → **Operational Devices** tile (this is the one previously labelled "Active
Fleet"). For Nuvista alone, use Fleet Directory → Nuvista row → **Operational Devices** column.
The companion tile is **Warehouse Devices**.

**5. Should these two match? — NO today, and that mismatch is exactly the bug.**

FSM will show **Operational 9,437** and **Warehouse 2,449** for Nuvista.

Excel says 7,650 are Deployed. Of those, 7,641 exist in FSM; FSM also holds 105 Deployed vehicles the
Excel does not list. So **a correct FSM would show roughly 7,750 operational — not 9,437.**

The ~1,690 excess is the defect: FSM's `is_departed` flag has stopped being updated, so it is both
counting undeployed vehicles as operational *and* hiding live ones in the warehouse. Check 7 lets you
see individual examples.

> Confidence: **high** on 7,650 / 17,564 (recomputed from the file) and on FSM's 9,437 / 2,449
> (queried directly). The "roughly 7,750" is an estimate, because the 105 extra vehicles cannot be
> checked against an Excel that does not contain them.

---

## Check 4 — Active / Inactive / NDD per plant, and the arithmetic closing

**1. What this proves.** That every vehicle sits in exactly one of three reporting states, that
**NDD is its own state and not a kind of Inactive**, and that the three add back to 25,214 exactly.

The three states mean:
- **Active** — the device reported GPS within the last 24 hours.
- **Inactive** — it last reported more than 24 hours ago.
- **NDD** — "No Device Data": it has **never** reported at all. `GPS_DATE_TIME` is blank on all 343
  of these rows. This is a third peer state — folding it into Inactive is a real and easy mistake.

**2. Excel steps.**
1. New PivotTable, same range.
2. Drag **`Plant Name`** → **Rows**.
3. Drag **`Active_Inactive`** → **Columns**.
4. Drag **`VEHICLE NO`** → **Values**; confirm **Count of VEHICLE NO**.

*What the screen should look like:* **three** data columns headed `Active`, `Inactive`, `NDD`, in
that order, plus Grand Total. If you see only two, this file is not the one these findings came from
— stop and tell me.

*To prove NDD really is "never reported", cross-check it:*
5. Build one more pivot. Drag **`Bucket By Days`** → **Rows** and **`VEHICLE NO`** → **Values**
   (Count). The row labelled **NDD** reads **343** — the same 343 rows, confirmed from a second,
   independent column.

**3. The number I should see.**

| Plant | Active | Inactive | NDD | Sum |
|---|---:|---:|---:|---:|
| RISDA | 3,742 | 3,806 | 137 | 7,685 |
| NIMBOL | 2,778 | 2,241 | 81 | 5,100 |
| CHITTOR | 2,391 | 1,665 | 19 | 4,075 |
| ARASMETA | 659 | 637 | 13 | 1,309 |
| ODISHA | 474 | 748 | 46 | 1,268 |
| JOJOBERA | 777 | 354 | 2 | 1,133 |
| BIHAR | 358 | 701 | 12 | 1,071 |
| HARYANA | 475 | 532 | 10 | 1,017 |
| PANAGARH | 628 | 384 | 3 | 1,015 |
| SONADIH | 672 | 272 | 6 | 950 |
| MEJIA | 338 | 83 | 0 | 421 |
| OTHERS | 137 | 19 | 14 | 170 |
| **Total** | **13,429** | **11,442** | **343** | **25,214** |

**The arithmetic closing:** `13,429 + 11,442 + 343 = 25,214`. ✅
Note MEJIA has **0** NDD — a legitimate zero, not a missing figure.

**4. Where to find the same number in FSM.**
Dashboard KPI strip → **Inactive Operational Devices** and **Healthy Operational Devices**.
Per company: Fleet Directory → Nuvista row, same two columns.

**5. Should these two match? — NO. Three separate reasons, and this is the easiest check to
misread.**

FSM will show **Inactive Operational 1,179** and **Healthy Operational 8,258** for Nuvista.

1. **FSM has no NDD state at all.** Its "healthy" figure is defined as *everything not inactive*, so
   a device that has never reported once gets counted as healthy. 51 of Nuvista's operational devices
   are in that position right now.
2. **FSM's inactive requires an SLA bucket**, and it never counts a device it believes is in the
   warehouse — so 11,442 and 1,179 are not measuring the same population.
3. **Scope**, as everywhere: FSM only holds 11,624 of these 25,214 vehicles.

Do **not** conclude anything from `11,442` vs `1,179`. Those two numbers were never meant to be equal.

---

## Check 5 — Deployed AND Inactive (two dimensions at once)

**1. What this proves.** How many vehicles are out on a trip yet have stopped reporting — the
population the departure bug actually harms, because these are the ones that should be raising
tickets.

**2. Excel steps.**
1. New PivotTable, same range.
2. Drag **`Plant Name`** → **Rows**.
3. Drag **`Active_Inactive`** → **Columns**.
4. Drag **`VEHICLE NO`** → **Values**; confirm **Count of VEHICLE NO**.
5. Now drag **`Deployment Status`** into the **Filters** box (the top box, above Columns).
6. A dropdown appears above the pivot, at cell **B1**, showing `(All)`. Click it, choose
   **Deployed**, click **OK**.

*What the screen should look like:* the same three columns as Check 4, but every number has dropped,
and the Grand Total now reads **7650** rather than 25214. The filter cell reads `Deployed`.

**3. The number I should see.**

With the filter set to **Deployed**, the grand totals across the three columns are:
**Active 7,021 · Inactive 597 · NDD 32** — and `7,021 + 597 + 32 = 7,650`. ✅

The **Inactive** column, per plant:

| Plant | Deployed & Inactive |
|---|---:|
| RISDA | 188 |
| NIMBOL | 103 |
| CHITTOR | 63 |
| HARYANA | 59 |
| JOJOBERA | 52 |
| ARASMETA | 25 |
| SONADIH | 27 |
| PANAGARH | 20 |
| MEJIA | 18 |
| ODISHA | 15 |
| OTHERS | 14 |
| BIHAR | 13 |
| **Total** | **597** |

*(Sanity check: flip the filter to `Undeployed` and the grand total becomes 17,564, splitting
6,408 / 10,845 / 311.)*

**4. Where to find the same number in FSM.**
Dashboard → **Inactive Operational Devices** tile, or Fleet Directory → Nuvista →
**Inactive Operational**.

**5. Should these two match? — NO.**

FSM will show **1,179**. The Excel's comparable figure is **597**.

FSM's number is roughly double, and that is consistent with the bug rather than a coincidence: FSM's
"operational" population is inflated by ~1,690 vehicles that are actually Undeployed, and some of
those have gone quiet and are being counted as inactive. **After the fix this figure should fall
substantially.** That makes it a good number to record now as a "before" reading.

> Confidence: **medium** on the prediction that 1,179 drops toward 597 after the fix. The direction
> is clear; the exact landing point is not, because FSM also applies an SLA-bucket condition the
> Excel has no equivalent for.

---

## Check 6 — The scope problem (read this one carefully)

**1. What this proves.** That the ~13,590 vehicles FSM does not hold are almost entirely Undeployed
ones, so FSM omitting them is a deliberate design decision rather than data loss.

**Plain English first.** FSM only creates a record for a vehicle once it has been seen *Deployed*.
A vehicle that has only ever sat Undeployed is read from AutoPlant, counted, and then deliberately
discarded — it is never written into FSM. This was decided on purpose (issue #128), because mirroring
the whole catalogue would roughly double every total on the dashboard and change what those totals
mean. So FSM holding fewer vehicles than the Excel is correct behaviour.

**2. Excel steps.**
1. Go back to your Check 3 pivot (plants in Rows, `Deployment Status` in Columns).
2. Read the **Undeployed** grand total: **17,564**.
3. Compare against the FSM figure from Check 1: FSM holds **11,886** Nuvista devices, of which
   **11,624** also appear in this Excel.
4. `25,214 − 11,624 = 13,590` vehicles are in the Excel but not in FSM.
5. Of those 13,590, **13,581 are Undeployed** and only **9 are Deployed** — 99.93%.

*To see the shape of it yourself without leaving Excel:* on `Sheet 1`, click any data cell →
**Data** tab → **Filter** → click the dropdown on **`Deployment Status`** → untick *(Select All)* →
tick only **Undeployed** → OK. Read the **status bar at the bottom-left** (Trap 1): it should say
`17564 of 25214 records found`. That 17,564 is the pool the 13,581 come out of.

*To spot-check that these really are absent from FSM*, take any of these six Undeployed vehicles and
search for them in FSM (Ops Explorer → *Devices & device state* → filter on `vehicleNo`). Each should
return **no rows**:

| VEHICLE NO | DEVICE NO | Plant | Excel state |
|---|---|---|---|
| CG10BP4831 | 0867440069776060 | ARASMETA | Active |
| CG10AE9689 | 862491075569192 | ARASMETA | Inactive |
| CG10AL8114 | 862491072685637 | ARASMETA | Inactive |
| CG04QD4216 | 862491072519778 | ARASMETA | Active |
| CG04PC5377 | 862491073529347 | ARASMETA | Inactive |
| CG29AB0150 | 866897058371248 | ARASMETA | Inactive |

**3. The number I should see.** 17,564 Undeployed · 13,590 absent from FSM · **13,581 of them
Undeployed (99.93%)** · 9 Deployed.

**4. Where to find the same number in FSM.** Fleet Directory → Nuvista → **Mirrored Devices** =
**11,886**. Also Dashboard → **Fleet Composition** funnel, which names each reduction step.

**5. Should these two match? — NO, and they never will. This is the key section.**

**Comparisons that are INVALID — never draw a conclusion from these:**
- Excel 25,214 vs FSM 11,886 total devices
- Any per-plant total from Check 2 vs FSM's per-plant figure
- Excel Undeployed 17,564 vs anything in FSM
- Excel Inactive 11,442 vs FSM Inactive Operational 1,179

**Comparisons that are VALID:**
- **Per-vehicle lookups** — take a specific registration from the Excel and find it in FSM. This is
  the strongest check available to you and it is what Check 7 uses.
- **Excel Deployed (7,650) vs FSM Operational (9,437)** — both aim to mean "in the field now", so
  the gap is meaningful. This is the bug.
- **Ratios within FSM**, compared against ratios within the Excel's Deployed-only subset.

**The 9 Deployed vehicles that are absent from FSM are a genuine open question**, not part of the
departure bug. I checked all 9 against the AutoPlant source database directly: the source says
**UNDEPLOYED** for every one of them, while this Excel says Deployed. So the Excel and the source
disagree with each other on those 9 rows. FSM is following the source correctly. I have not resolved
which of the two is right, and I flagged it rather than assuming.

---

## Check 7 — The finding itself, vehicle by vehicle

**1. What this proves.** That specific, named vehicles are out on a trip and actively transmitting
right now, while FSM has filed them as "departed to warehouse" — and therefore stopped monitoring
them.

> **⚠️ One number differs from my earlier report — flagging it as promised.**
> I previously reported this group as **795** vehicles. Recomputing for this guide, **755** of them
> appear in the Excel. Both are correct but count different things:
> - **795** = every Nuvista device FSM has flagged departed while its own source status still says
>   DEPLOYED. This is measured entirely inside FSM.
> - **755** = the subset that also appears in this Excel, and therefore the most you could ever
>   confirm by hand from this file. The other 40 are not in the Excel (the Check 6 gap, in reverse).
>
> Of the 755, **631** are the cleanest possible evidence: the Excel marks them **Deployed**,
> **ONLINE** *and* **Active** at the same time. The 10 below are drawn from those 631.

**2. Excel steps.**
1. On `Sheet 1`, click any data cell → **Data** tab → **Filter**.
2. On **`Deployment Status`**, untick *(Select All)*, tick **Deployed** only → OK.
3. On **`Device Status`**, untick *(Select All)*, tick **ONLINE** only → OK.
4. Press **Ctrl+F**, paste a registration from the table below into *Find what*, click
   **Find Next**.
5. Read that row across: `Deployment Status` = Deployed, `Device Status` = ONLINE,
   `Active_Inactive` = Active, and `GPS_DATE_TIME` = this morning.

**3. The number I should see.** Every one of the 10 rows below is present in the file, Deployed,
ONLINE, Active, with a GPS timestamp of **07-08-2026 06:49** — that is minutes before the report was
generated. These vehicles were unquestionably live.

| # | VEHICLE NO | DEVICE NO | Excel plant | GPS_DATE_TIME | FSM plant code |
|---|---|---|---|---|---|
| 1 | OD17AA3999 | 862491073494559 | SONADIH | 07-08-2026 06:49:11 | SCP-9232 |
| 2 | RJ09GF0578 | 860141076225706 | CHITTOR | 07-08-2026 06:49:11 | CCP-9115 |
| 3 | CG22AE0959 | 862608083806148 | RISDA | 07-08-2026 06:49:11 | RCP-9211 |
| 4 | CG09JN3336 | 860141073175383 | RISDA | 07-08-2026 06:49:10 | RCP-5151 |
| 5 | CG22AF4029 | 862608083506011 | RISDA | 07-08-2026 06:49:10 | RCP-9211 |
| 6 | CG04PU3529 | 860141073579352 | RISDA | 07-08-2026 06:49:10 | RCP-9211 |
| 7 | OD09AC7281 | 862608083611928 | RISDA | 07-08-2026 06:49:10 | RCP-9211 |
| 8 | CG22J2597 | 0867440069793735 | SONADIH | 07-08-2026 06:49:10 | SCP-9232 |
| 9 | MP20ZD5329 | 0869925070388465 | RISDA | 07-08-2026 06:49:10 | RCP-5151 |
| 10 | CG22W3366 | 862491077902417 | SONADIH | 07-08-2026 06:49:09 | SCP-9104 |

*(Rows 8 and 9 also demonstrate Trap 4 — their `DEVICE NO` starts with `0`.)*

**4. Where to find the same number in FSM.**

Use **Ops Explorer**, which is read-only and already enabled in this environment:

1. FSM admin → **Ops Explorer**.
2. Choose the **Devices & device state** dataset.
3. Filter **`vehicleNo`** equals the registration, e.g. `OD17AA3999`.
4. Add the **`isDeparted`** column to the output if it is not shown by default.
5. Read `isDeparted`. Also worth showing: `latestGpsDatetime`, `plantName`.

**Expected result: `isDeparted` = `true` for all ten.**

*Why not the device detail page:* the per-device departure/lifecycle display is issue **#129**, which
is still open — so the device detail screen may not show departed status yet. Ops Explorer is the
reliable route today.

> Confidence: **high** that `isDeparted` is `true` for these ten — it is queried directly from the
> database. **Medium** on the exact Ops Explorer labels and filter layout, because I verified the
> dataset definition in code but did not open the screen myself.

**5. Should these two match? — NO — and here the mismatch *is* the finding.**

The Excel says these vehicles are Deployed and transmitting. FSM says they are in a warehouse.
Both cannot be true. The Excel is ground truth, so FSM is wrong on all ten.

This matters because `isDeparted = true` switches off inactivity tracking, SLA bucketing, ticket
creation and dispatch for that device. Across the whole platform, **1,050 devices in this state have
been silent for more than 24 hours and cannot raise a ticket** — real faults nobody is being told
about.

If all ten come back `isDeparted = true`, the finding is confirmed and the root cause in the
report is the explanation for it.

---

## Fill-in comparison table

| Check | What | Excel value | FSM value | Match Y/N | Notes |
|---|---|---|---|---|---|
| 1 | Total vehicles | 25,214 | | | Expect NO — FSM ~11,886 by design |
| 1 | Distinct `VEHICLE NO` | 25,214 | — | — | 0 duplicates |
| 2 | RISDA | 7,685 | | | Sum 3 FSM plant codes |
| 2 | NIMBOL | 5,100 | | | NCP-9117 |
| 2 | CHITTOR | 4,075 | | | Sum 2 FSM codes |
| 2 | All 12 plants total | 25,214 | | | Expect NO |
| 3 | Deployed | 7,650 | | | **Expect NO — FSM 9,437. This is the bug** |
| 3 | Undeployed | 17,564 | | | Expect NO |
| 4 | Active | 13,429 | | | Expect NO |
| 4 | Inactive | 11,442 | | | Expect NO — FSM 1,179, different definition |
| 4 | NDD | 343 | | | FSM has no equivalent state |
| 4 | Sum closes to total | 25,214 | — | — | Arithmetic check only |
| 5 | Deployed & Inactive | 597 | | | Expect NO — FSM 1,179; record as "before" |
| 6 | Absent from FSM | 13,590 | — | — | 13,581 Undeployed = 99.93% |
| 7 | Vehicle 1 OD17AA3999 | Deployed/ONLINE | | | Expect `isDeparted = true` |
| 7 | Vehicle 2 RJ09GF0578 | Deployed/ONLINE | | | Expect `isDeparted = true` |
| 7 | Vehicle 3 CG22AE0959 | Deployed/ONLINE | | | Expect `isDeparted = true` |
| 7 | Vehicle 4 CG09JN3336 | Deployed/ONLINE | | | Expect `isDeparted = true` |
| 7 | Vehicle 5 CG22AF4029 | Deployed/ONLINE | | | Expect `isDeparted = true` |
| 7 | Vehicle 6 CG04PU3529 | Deployed/ONLINE | | | Expect `isDeparted = true` |
| 7 | Vehicle 7 OD09AC7281 | Deployed/ONLINE | | | Expect `isDeparted = true` |
| 7 | Vehicle 8 CG22J2597 | Deployed/ONLINE | | | Expect `isDeparted = true` |
| 7 | Vehicle 9 MP20ZD5329 | Deployed/ONLINE | | | Expect `isDeparted = true` |
| 7 | Vehicle 10 CG22W3366 | Deployed/ONLINE | | | Expect `isDeparted = true` |

---

## What to conclude

**If the numbers agree** — meaning your pivots reproduce 25,214 / 7,650 / 17,564 / 13,429 / 11,442 /
343 / 597, and all ten vehicles in Check 7 come back `isDeparted = true` in Ops Explorer — then the
finding is confirmed on evidence you have seen yourself. The Excel side is arithmetically sound and
closes on itself, and FSM is demonstrably marking live, transmitting vehicles as warehoused. The root
cause in `reconciliation-report.md` (a `import type` import that stops the departure service from
being injected, so the departure/restore pass silently does nothing) is then the explanation, and the
fix plus its dry-run gate is the right next step.

**If the numbers disagree** — stop before the fix and tell me which check broke. A mismatch in
Checks 1–5 would mean I derived the Excel side wrongly, and the entire report would need re-basing.
A mismatch in Check 7 — vehicles coming back `isDeparted = false` — would mean either the state has
changed since 2026-08-07 07:15 (possible if a sync has run through the CLI path, which *does* work)
or that my read of FSM was wrong. Either way it is far cheaper to find it now than after ~6,000
device records have been moved.

**A caution on re-running later:** these FSM figures are live and drift with every sync. If you
verify days from now and FSM's numbers have moved, that is not necessarily a contradiction — check
`master_sync_runs` for runs after 113 before concluding anything.
