# Manual Excel Guide — checking `SUMMARYReport11thAug.xlsx` by hand

**Who this is for:** someone who has never used Excel before. Every step tells you the exact menu, the exact clicks, exactly what to type, what the screen should look like afterwards, and the mistake people most often make at that step.

**What you will end up with:** the same company and plant numbers the automated analysis produced, worked out with your own hands, so you can trust them.

**The file:** `docs\SUMMARYReport11thAug.xlsx` — 33,341 rows, 24 columns.

**Before you start, three facts about this file that will save you an hour:**

1. The **last row (33341) is not data.** It is a label row that says "Grand Total". If you leave it in, every count is 1 too high and every status column grows a phantom category called `Total`.
2. Some **device numbers begin with a zero** (`0869925073309393`). If Excel treats them as numbers it deletes that zero. Four pairs of devices in this file become indistinguishable when that happens.
3. There are **three** device states, not two: Active, Inactive **and NDD**. Adding Active + Inactive misses 848 vehicles.

---

## Step 1 — Open the file without destroying the device numbers

Excel's default behaviour is to look at `0869925073309393`, decide it is a number, and throw away the leading zero. This is silent. Nothing warns you.

**What the damage looks like.** Open it carelessly and column I (`DEVICE NO`) shows `869925073309393` — one character shorter — and the values sit **hard against the right edge** of the cell. Text sits against the **left** edge. That right-alignment is your tell.

Worse, four pairs in this file differ *only* by that leading zero:

| Correct | What Excel leaves you with |
|---|---|
| `0359688090185033` (vehicle MP19HA2419) | `359688090185033` |
| `359688090185033` (vehicle MP17HH5500) | `359688090185033` |

Two different trucks, now one device number. Every count involving them is wrong and nothing looks broken.

### Do this instead

1. Open Excel to the **start screen** (do **not** double-click the .xlsx file).
2. Click **Blank workbook**.
3. On the ribbon at the top, click the **Data** tab.
4. At the far left, click **Get Data** → **From File** → **From Workbook**.
   - *On older Excel (2016) this button is called* **New Query** → **From File** → **From Workbook**.
5. Navigate to `docs\SUMMARYReport11thAug.xlsx`, select it, click **Import**.
6. A **Navigator** window opens with a list on the left. Click **`Sheet 1`**. A preview appears on the right.
7. Click the **Transform Data** button at the bottom. **Do not click Load.** This is the important click.
8. The **Power Query Editor** opens — a separate window showing your data as a grid.
9. Find the **`DEVICE NO`** column. Look at the small icon to the left of the column name in its header:
   - `ABC` means text. This is what you want.
   - `123` means number. **This will delete your leading zeros.**
10. If it shows `123`: **right-click the `DEVICE NO` column header** → **Change Type** → **Text**.
11. A box appears saying *"Change Column Type — inserting a new step will..."*. Click **Replace current**.
12. Repeat steps 9–11 for **`IMSI_NO`** (column J). It has the same problem — 6,429 of its values start with a zero.
13. Click **Close & Load** (top-left of the Power Query window).
14. Wait. 33,000 rows takes a few seconds.

**Check it worked:** click any cell in `DEVICE NO`. The value should be **left-aligned**, and values like `0869925073309393` should still show all 16 characters. Count them if you need to.

> **Most common mistake:** clicking **Load** instead of **Transform Data** at step 7. Load skips the type-fixing screen entirely and you are back to broken device numbers. If you did this, close without saving and start again from step 1.

---

## Step 2 — Find and mark the Grand Total row

**Why this matters:** that row is a label, not a vehicle. Counted as data it adds 1 to every total and creates a fake category called `Total` in every status column — so your Deployment Status pivot grows a third column that should not exist.

1. Press **Ctrl + End**. This jumps to the last cell with anything in it. You land on **row 33341**, column X.
2. Press **Ctrl + Left Arrow** (or scroll left) to see column A of that row. It reads **`Grand Total`**.
3. Look at the row above it, row **33340**. It reads `WB972913` — a real vehicle. So:
   - **Rows 2 to 33340 are your data — 33,339 rows.**
   - **Row 33341 is the label row.**
4. Press **Ctrl + Home** to jump back to the top.

### Filter it out (do this once, and everything downstream is safe)

1. Click any single cell inside your data, e.g. **A2**.
2. Click the **Data** tab → click **Filter** (the funnel icon).
3. Small dropdown arrows appear in every header cell in row 1.
4. Click the dropdown arrow on **`VEHICLE NO`** (cell A1).
5. A panel opens with a search box and a long ticked list. Click **(Select All)** to untick everything.
6. Type `Grand` into the search box. The list narrows to one entry: **Grand Total**.
7. Tick **Grand Total** and click **OK**. You now see *only* that row — this confirms there is exactly one.
8. Click the dropdown again → click **(Select All)** to tick everything → then scroll to find **Grand Total** and **untick just that one** → **OK**.

You now see all 33,339 real rows and not the label.

> **Most common mistake:** deleting the row instead of filtering it. Don't — you would be editing the source file, and this whole exercise is meant to be read-only.

---

## Step 3 — Verify that vehicle numbers are unique

You need to know whether one row means one vehicle before you count anything.

1. Click the **`VEHICLE NO`** column header (the letter **A**) to select the whole column.
2. Press **Ctrl + C**.
3. At the bottom of the screen, click the **`+`** next to the sheet tabs to create a new sheet.
4. Click cell **A1** on the new sheet.
5. Right-click → under **Paste Options** choose the **Values** icon (a clipboard with **123** on it). This pastes text, not formulas.
6. Click the **Data** tab → **Remove Duplicates**.
7. A small box appears. Tick **My data has headers**. Make sure **`VEHICLE NO`** is ticked in the column list. Click **OK**.
8. A result box appears. Read it carefully.

**What you should see:**

> *"0 duplicate values found; 33,339 unique values remain."*

That is the answer: **every vehicle number is unique.**

9. Click **OK**, then press **Ctrl + Z** to undo the removal (keep the sheet intact if you want to re-check).
10. Repeat steps 1–8 on the **`DEVICE NO`** column. You should again get **0 duplicates, 33,339 unique**.

> **Careful:** if `DEVICE NO` reports duplicates here, you did **not** import it as text — go back to Step 1. The duplicates you are seeing are Excel's zero-stripping, not real ones.
>
> **Note on `IMSI_NO`:** if you run this on column J you will get a very different answer — 3,039 blanks and 35 repeated values, one of them appearing 23 times. **`IMSI_NO` is not a usable identifier.** Never join or match on it.

---

## Step 4 — Your first PivotTable: vehicle count by company

A PivotTable is a summary table you build by dragging field names into boxes. Nothing you do to it changes your data.

1. Go back to the data sheet. Click any single cell inside the data, e.g. **A2**.
2. Click the **Insert** tab → click **PivotTable** (far left).
3. A dialog opens: *"Create PivotTable"*.
   - **Table/Range** should already read something like `'Sheet 1'!$A$1:$X$33341`. If it does not, click in the box, clear it, and type exactly:
     ```
     'Sheet 1'!$A$1:$X$33341
     ```
   - Under *"Choose where you want the PivotTable to be placed"*, select **New Worksheet**.
4. Click **OK**.
5. A new sheet appears with an empty pivot outline on the left and the **PivotTable Fields** panel on the right. That panel has a field list at the top and **four boxes** at the bottom: **Filters, Columns, Rows, Values**.
6. In the field list, find **`Company Name`**. Click and hold it, drag it into the **Rows** box, release.
   - Nine company names appear down the left: COKE, DGFC, NUVISTA, PRISM, SCL, SHREE BALAJI, UTCL, VBL, VICAT.
7. Now find **`VEHICLE NO`**. Drag it into the **Values** box.
8. Look at what appeared in the Values box. It probably says **"Count of VEHICLE NO"** — which is what you want, because the column is text. If it says **"Sum of..."**, fix it:
   - Click the item in the **Values** box → **Value Field Settings…** → choose **Count** → **OK**.

**What the result should look like:**

```
Row Labels          Count of VEHICLE NO
COKE                              1350
DGFC                               326
NUVISTA                          25362
PRISM                             2560
SCL                                996
SHREE BALAJI                       295
UTCL                              1421
VBL                                151
VICAT                              878
Grand Total                      33339
```

> **Read this carefully.** The **Grand Total: 33339** at the bottom of the *pivot* is **Excel's own arithmetic** — it added your nine rows. It is **not** the "Grand Total" row from the file. They are different things that share a name.
>
> If your pivot shows **33340** and a tenth row labelled `Total`, the file's label row got included. Fix it: click the dropdown on **Row Labels** → untick **Total** → **OK**.

---

## Step 5 — Add Deployment Status (a two-dimensional pivot)

1. Stay on the same pivot. In the **PivotTable Fields** panel, find **`Deployment Status`**.
2. Drag it into the **Columns** box (not Rows).

Your single column of numbers becomes a grid:

```
Count of VEHICLE NO   Deployed   Undeployed   Grand Total
COKE                      1101          249          1350
DGFC                       326            0           326
NUVISTA                   7664        17698         25362
PRISM                     1196         1364          2560
SCL                        513          483           996
SHREE BALAJI               155          140           295
UTCL                       735          686          1421
VBL                        113           38           151
VICAT                      525          353           878
Grand Total              12328        21011         33339
```

**How to read an intersection cell.** The cell where row `NUVISTA` meets column `Undeployed` contains **17698**. That reads: *"17,698 NUVISTA vehicles have Deployment Status = Undeployed."* Row label + column label + the number is the whole sentence.

**Check the arithmetic yourself:** 12,328 + 21,011 = 33,339 ✓. Deployed and Undeployed account for every vehicle, with nothing left over.

> **Most common mistake:** dropping `Deployment Status` into **Rows** instead of **Columns**. You get a long nested list instead of a grid. Drag it out of Rows and into Columns to fix.

---

## Step 6 — Active / Inactive / NDD (and why two columns is the wrong answer)

1. In the **Columns** box, drag **`Deployment Status`** back out — drop it anywhere outside the panel to remove it.
2. Drag **`Active_Inactive`** into the now-empty **Columns** box.

```
Count of VEHICLE NO   Active   Inactive    NDD   Grand Total
COKE                    1016        310     24          1350
DGFC                     302         24      0           326
NUVISTA                13496      11527    339         25362
PRISM                   1541        671    348          2560
SCL                      255        695     46           996
SHREE BALAJI             110        175     10           295
UTCL                    1082        269     70          1421
VBL                      144          7      0           151
VICAT                    616        251     11           878
Grand Total            18562      13929    848         33339
```

**There are three columns, not two.** Verify they account for everything:

- 18,562 + 13,929 + 848 = **33,339** ✓
- 18,562 + 13,929 = **32,491** ✗ — **848 vehicles short**

**What NDD means.** It is not a flavour of Inactive. It is its own state: **a device that has never sent a single GPS position.** All 848 have a completely empty `GPS_DATE_TIME` (column P), and no other row in the file does. There is nothing to measure staleness against, so it cannot be "inactive for N days" — it is a separate condition, and it is a fault worth fixing, not a quiet zero.

> **The single most common reporting error with this file** is writing `=Active + Inactive` and presenting it as the fleet. It silently omits 848 vehicles — 2.5% of the fleet, and the 2.5% most likely to need an engineer.

---

## Step 7 — Drill down to plant level

1. In the **PivotTable Fields** panel, find **`Plant Name`**.
2. Drag it into the **Rows** box and drop it **below** `Company Name`. Order matters — the panel shows `Company Name` then `Plant Name`.

Each company now expands into its plants:

```
Row Labels              Active   Inactive   NDD   Grand Total
- NUVISTA                13496      11527   339         25362
    ARASMETA               681        638    13          1332
    BIHAR                  355        710    12          1077
    CHITTOR               2418       1646    19          4083
    HARYANA                476        536     9          1021
    ...
- PRISM                   1541        671   348          2560
    SATNA_PLANT           1541        671   348          2560
```

**Collapse and expand:** click the small **−** box beside a company name to collapse it to one line; click the **+** to expand it again. To collapse everything at once: right-click any company name → **Expand/Collapse** → **Collapse Entire Field**.

> ### ⚠ The one trap in this file
>
> **Never build a pivot with `Plant Name` in Rows without `Company Name` above it.**
>
> Two plant names are used by more than one company:
>
> | Plant Name | Used by |
> |---|---|
> | `OTHERS` | COKE (1), NUVISTA (195), UTCL (5) |
> | `TRANSPORTER` | DGFC (326), SHREE BALAJI (295) |
>
> Put `Plant Name` on its own and Excel merges those into a single fake plant called `OTHERS` with 201 vehicles and a single fake `TRANSPORTER` with 621 — neither of which exists anywhere.
>
> The file has **49 distinct plant names but 52 real (company, plant) combinations.** Always keep `Company Name` above `Plant Name` in the Rows box.

---

## Step 8 — Read the status bar, not the row numbers

This trips up almost everyone the first time.

When you filter, **Excel hides rows but never renumbers them.** Filter to one company and the row numbers down the left might read 2, 47, 1893, 24118 — jumping around, with the last one still showing 33,340. That is not a count. It is just where those rows happen to live.

**The real count lives in the status bar** — the thin grey strip along the very bottom of the Excel window.

After filtering, look at the **bottom-left corner**. It reads something like:

```
1350 of 33339 records found
```

That is your number.

### If you cannot see it

1. **Right-click anywhere on the grey status bar** at the bottom of the window.
2. A long menu appears (*Customize Status Bar*) with ticks beside the visible items.
3. Make sure **Count** is ticked. Click it if it is not.
4. Also tick **Filter Mode** if present — it shows the "of N records found" text.
5. Click anywhere else to close the menu.

**Alternative that always works:** select the filtered cells in one column with the mouse, then read **Count:** in the status bar. Excel counts only visible cells in a filtered range.

> This is identical in Excel 2016, 2019, 2021 and Microsoft 365. The status bar is at the bottom of the window in all of them.

---

## Step 9 — Filter to one company and cross-check

Now prove your pivot is right by getting the same number a completely different way.

1. Go to the **data sheet** (not the pivot sheet).
2. Make sure filters are on: **Data** tab → **Filter** should look pressed-in. If not, click it.
3. Click the dropdown arrow on **`Company Name`** (cell **D1**).
4. Click **(Select All)** to untick everything.
5. Scroll the list and tick **only** `COKE`.
6. Click **OK**.
7. Read the **bottom-left status bar**: it should say **`1350 of 33339 records found`**.
8. Compare against your pivot from Step 4: the COKE row reads **1350**. ✓

**Two independent methods, same number.** That is what verification means.

Repeat for any company you want to confirm:

| Company | Expected |
|---|---|
| COKE | 1,350 |
| DGFC | 326 |
| NUVISTA | 25,362 |
| PRISM | 2,560 |
| SCL | 996 |
| SHREE BALAJI | 295 |
| UTCL | 1,421 |
| VBL | 151 |
| VICAT | 878 |

**When you are done, clear the filter:** click the `Company Name` dropdown → **Clear Filter From "Company Name"**. Do this before the next step or your totals will only cover COKE.

> **Most common mistake:** leaving a filter on and then wondering why a later total is far too small. If a number looks wrong, the first thing to check is whether a funnel icon is showing on any column header.

---

## Step 10 — Reconciliation check: do the numbers add up?

1. Go to your pivot sheet from Step 6 (the Active / Inactive / NDD grid).
2. Click on an empty cell well clear of the pivot — say **J2**.
3. Type this and press Enter:
   ```
   =18562+13929+848
   ```
   You should get **33339**.
4. Now compare that against the raw row count. In cell **J4**, type:
   ```
   ='Sheet 1'!A1
   ```
   …no — better, count the data directly. In **J4** type:
   ```
   =COUNTA('Sheet 1'!A2:A33340)
   ```
   Press Enter. You should get **33339**.

**Both give 33,339. Your pivot reconciles to the raw data.**

### If J4 gives you 33340 instead

You included the Grand Total row. The range `A2:A33340` stops one row short of it deliberately. If you typed `A2:A33341` you counted the label. Fix the range.

### If your pivot total is 33340 and shows a `Total` column

The label row is inside the pivot. Two fixes:

- **Quick:** click the **Column Labels** dropdown at the top of the pivot → untick **`Total`** → **OK**.
- **Proper:** click inside the pivot → **PivotTable Analyze** tab → **Change Data Source** → set the range to end at row **33340** instead of 33341 → **OK**.

### A useful COUNTIFS cross-check

To count one company and one state together without any pivot at all, type into an empty cell:

```
=COUNTIFS('Sheet 1'!$D$2:$D$33340,"NUVISTA",'Sheet 1'!$U$2:$U$33340,"NDD")
```

You should get **339** — matching the NUVISTA/NDD cell in your Step 6 pivot.

Reading it: column **D** is `Company Name`, column **U** is `Active_Inactive`, and both ranges stop at **33340** to exclude the label row. The `$` signs lock the ranges so you can copy the formula around without them sliding.

---

## Step 11 — Export your pivot as a plain table

A PivotTable's cells are not ordinary values. Point a formula at one and Excel writes `GETPIVOTDATA(...)` instead of a cell reference, which breaks the moment the pivot is refreshed or rearranged. To compare your numbers against anything else, you need flat values.

1. Click any cell inside the pivot.
2. Press **Ctrl + A**. This selects the entire pivot including headers and totals.
   - *If Ctrl+A selects the whole sheet instead, drag-select the pivot's cells with the mouse.*
3. Press **Ctrl + C**.
4. Click the **`+`** at the bottom of the screen to create a new sheet.
5. Click cell **A1**.
6. Right-click → under **Paste Options**, click the **Values** icon (clipboard showing **123**).
   - *Long way round:* right-click → **Paste Special…** → select **Values** → **OK**.
7. Rename the sheet: double-click its tab, type `Company Benchmark`, press Enter.

**Why this matters.** What you now have is ordinary numbers. You can:
- write formulas against them that will not turn into `GETPIVOTDATA`
- sort and filter them freely
- paste them beside a set of FSM numbers and subtract one column from the other
- send the sheet to someone who does not have the source file

**Check it worked:** click any number in the new sheet and look at the formula bar at the top. It should show a plain number like `13496`, **not** a formula. If you see `=GETPIVOTDATA(...)` you pasted normally instead of pasting values — undo with **Ctrl + Z** and redo step 6.

---

## Quick reference — the numbers you should get

| Check | Expected |
|---|---|
| Data rows (excluding the label row) | **33,339** |
| Distinct vehicle numbers | **33,339** |
| Distinct device numbers | **33,339** |
| Deployed / Undeployed | **12,328 / 21,011** |
| Active / Inactive / **NDD** | **18,562 / 13,929 / 848** |
| Deployed + Undeployed | 33,339 ✓ |
| Active + Inactive + NDD | 33,339 ✓ |
| Active + Inactive *(wrong — omits NDD)* | 32,491 ✗ |
| Companies | **9** |
| Distinct plant **names** | 49 |
| Real **(company, plant)** pairs | **52** |

**The three things most likely to make your numbers wrong, in order:**

1. Opening the file by double-clicking it — leading zeros are silently deleted (Step 1).
2. Including row 33341 — everything is 1 too high and a phantom `Total` category appears (Step 2).
3. Grouping on `Plant Name` without `Company Name` — `OTHERS` and `TRANSPORTER` merge across companies into plants that do not exist (Step 7).
