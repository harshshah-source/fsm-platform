# Today's Dispatch — a guide for managers

**Who this is for:** anyone who has to run a zone's day — a Zonal Manager, a Central Service Manager,
or an Operations Head. You do not need to know anything about how the software is built.

**What it covers:** the screen called **Today's Dispatch**, from the moment you open it. What every
part of it means, what happens when you click things, and what you can and cannot trust.

**How long:** about twenty minutes to read once. After that, use the [Common jobs](#14-common-jobs)
section as a quick reference.

> **A note for engineers reading this:** this is deliberately a plain-language manual. The technical
> record lives in the code comments, in `docs/SYSTEM-STATE-2026-07.md`, and in the design documents
> under `docs/audits/`. If this guide and those disagree, those are right.

---

## Contents

1. [What this screen is for](#1-what-this-screen-is-for)
2. [Six words you need first](#2-six-words-you-need-first)
3. [What happens overnight](#3-what-happens-overnight)
4. [Opening the screen](#4-opening-the-screen)
5. [The strip along the top](#5-the-strip-along-the-top)
6. [Red and amber banners: things that need you](#6-red-and-amber-banners-things-that-need-you)
7. [The left column: your engineers](#7-the-left-column-your-engineers)
8. [The middle: the plan itself](#8-the-middle-the-plan-itself)
9. [Reading the little boxes](#9-reading-the-little-boxes)
10. [The right column: work that did not get planned](#10-the-right-column-work-that-did-not-get-planned)
11. [Clicking something: the detail panel](#11-clicking-something-the-detail-panel)
12. [Changing the plan](#12-changing-the-plan)
13. [Handing out unassigned work](#13-handing-out-unassigned-work)
14. [Common jobs](#14-common-jobs)
15. [Numbers that could mislead you](#15-numbers-that-could-mislead-you)
16. [Who is allowed to do what](#16-who-is-allowed-to-do-what)
17. [What your engineers actually see on their phones](#17-what-your-engineers-actually-see-on-their-phones)
18. [Word list](#18-word-list)

---

## 1. What this screen is for

Every night the system works out **which engineer should visit which site to fix which device
tomorrow**. It does that automatically, for one zone at a time.

It is good at this, but it is not always right, and it cannot know everything. Somebody called in
sick. A customer escalated. A part arrived early. **Today's Dispatch is where you see what the system
decided, understand why it decided that, and change it.**

Three things to hold on to:

**The system plans one zone at a time.** There is no single national view of dispatch, on purpose. If
you look after several zones you pick one, look at it, then pick another. A screen showing you a
country-wide number would be showing you a number nobody can act on.

**Nothing on this screen is a guess.** Every explanation you read — why an engineer was chosen, why a
ticket could not be placed — was worked out by the system when it made the decision and saved at the
time. The screen is reporting, not re-calculating.

**You can always overrule it.** The system will not overload an engineer. You can. It will not send a
floating engineer where a dedicated one was available. You can. In every one of those cases the screen
tells you what you are doing and lets you do it, and it records that you did.

---

## 2. Six words you need first

The rest of this guide leans on these. There is a fuller list at the end.

| Word | What it means |
|---|---|
| **Zone** | A region. Everything on this screen is about one zone at a time. |
| **Engineer** (or SE) | A Service Engineer — the person who goes out and fixes things. |
| **Ticket** | One device that needs attention. One ticket, one device. |
| **Stop** | One site visit. A stop covers all the tickets at that site. |
| **Day plan** | One engineer's stops for one day, in the order they should do them. |
| **Capacity** | How many stops an engineer can handle in a day. Shown as `7/25`. |

And one distinction that matters more than any of the above:

> **Assigned** means the work is on somebody's day plan. **Unassigned** means it is not on anybody's.
> Almost every question on this screen is really a question about which of those two a ticket is in.

---

## 3. What happens overnight

You do not need this to use the screen. You do need it to trust the screen, and to answer engineers
who ask "why did I get this one?"

### It runs early, usually 5am

The planner runs once, early, before the working day. **5am is the normal time but it is not fixed** —
an Operations Head can change it. The screen always tells you when the next one is, rather than
assuming.

If the run fails, the system notices within a few minutes and tries again, up to three times, and
stops trying at 6pm. After that, the day has run out and somebody has to step in.

### It only looks at work nobody has yet

This one sentence explains most surprises:

> **The planner only considers tickets that are open and not yet assigned to anyone.**

Work already on someone's plan is never re-planned. This is why running the planner a second time
usually places nothing — and that is correct behaviour, not a fault. See
[Running the planner yourself](#125-running-the-planner-yourself).

It also deliberately holds some work back, and it keeps these separate rather than lumping them
together, because they need different people to fix them:

| Held back because | Who needs to do something |
|---|---|
| The device has not been quiet long enough yet to be worth a visit | Nobody. This is the policy working. |
| It is waiting on a spare part | The warehouse |
| Somebody parked it until a future date | Whoever parked it |
| Its severity could not be worked out | **Somebody technical — this is a data problem** |

### How it picks an engineer

For each ticket, in strict order:

**First, who covers this site?** Engineers fall into three groups, and the order is absolute:

1. **Dedicated** — this site is theirs
2. **Multi-plant** — they cover this site among several
3. **Floating** — they cover the area, not the site

**Second, who is actually able to go?** Five checks: is their vehicle free, are they available (not on
leave), do they have room in their day, do they have their standard kit, do they have the part.

Anyone who fails a check is set aside — **and the screen will show you them anyway, greyed out, with
the reason.** That matters: the system will not send someone who fails a check, but you might decide
to, and you cannot decide about people you cannot see.

> **Two of those five checks are not switched on yet** (vehicle status and part availability), because
> the data does not exist. When that is the case the screen says **"not enforced"** rather than
> pretending the check passed. Do not read a blank as an all-clear.

**Third, the strongest group wins — always.** If even one dedicated engineer passes the checks, the
job goes to a dedicated engineer. It only drops to multi-plant when every dedicated engineer was ruled
out, and to floating when every multi-plant engineer was too.

> **A floating engineer can never beat an available dedicated one, no matter how good their score.**
> Scores are only ever compared *within* one group.

**Fourth, within that group, a score decides.** The score balances how important the customer is, how
urgent the device is, whether it has failed repeatedly, how long it has been silent, and how far it is
from where the engineer already is. You can see this broken down term by term for any ticket
(§[11.3](#113-you-clicked-a-device)).

A manual pin from the SE Planner beats all of this. If somebody pinned an engineer, they get it.

### Two moods

The zone runs in one of two modes, chosen automatically depending on how much work is backing up:

- **Catch-up** — there is a backlog. Clear the urgent things first.
- **Steady** — things are under control. Get ahead: revisit repeat offenders and older devices.

You will see the mode named on future-day projections and in the score breakdown. It changes the
priorities, not the rules.

### When nobody can take a critical job

If a **critical** ticket has no engineer with room to spare, the system does **not** quietly overload
someone. It stops and escalates it to you. That is the red banner at the top of your screen
(§[6.2](#62-the-red-banner-critical-work-nobody-could-take)).

### Then it writes the plans

It creates one day plan per engineer, one stop per site, and sends each engineer a "your day plan is
live" message. **Each engineer's plan is written separately**, so if something goes wrong for one
person it does not wreck everybody else's day.

There is no approval step. The plans go live, and you adjust them afterwards.

---

## 4. Opening the screen

**Left menu → Dispatch → Today's Dispatch** ("What is happening now").

There are four related screens in that menu, and it is worth knowing which is which:

| Screen | Answers |
|---|---|
| **Today's Dispatch** | What is happening **right now** |
| Scheduler Preview | What the next run **would** do |
| Schedules | Committed day plans |
| Intra-day Queue | What has been changed today |
| Dispatch Runs | A history of past runs |

### The first thing you see

**If you look after one zone**, it opens straight into it. There is no zone selector because you do
not have a choice to make.

**If you look after several zones**, you get a card asking you to choose one:

> *The Console shows one zone's operating day. There is no pan-India dispatch view — the scheduler
> plans, and this screen reports, one zone at a time.*

That is not an error and not a loading screen. Pick a zone. The screen remembers your choice for next
time.

### The address bar is shareable

Everything you are looking at — the zone, the day, what you have selected — is in the web address. If
you want a colleague to see exactly what you are seeing, copy the URL and send it. It will open on the
same thing.

---

## 5. The strip along the top

This strip tells you **where you are standing**. It never goes away, whatever else you are doing.

```
Scheduler Console  [Zone ▾]  ‹Prev [TODAY] Next›  [Day|Week]  [Find ticket or SE]
                              ● Dispatched 10:53 · SUCCESS   Next run 05:00 1 Sept   [Run now]
[⚠ 6 need attention ▸]   [Assign work]   [Run facts ▾]   [?]
```

| Control | What it does |
|---|---|
| **Zone** | Switch zones. Doing so clears whatever you had selected, because it belonged to the old zone. |
| **‹ Prev · TODAY · Next ›** | Move to another day. `TODAY` is always one click away. |
| **Day / Week** | Show one day either side, or three. |
| **Find ticket or SE** | Type to narrow the screen down. Press `/` to jump into it. |
| **Dispatched 10:53 · SUCCESS** | Whether the planner has run today, and how it went. Or **No run today**. |
| **Next run 05:00 1 Sept** | When the next automatic run happens. Real, not assumed — if it cannot be looked up, it is left blank rather than guessed. |
| **Run now** | Run the planner immediately. See §[12.5](#125-running-the-planner-yourself). |
| **⚠ 6 need attention** | Things across the zone waiting on a manager. Click to see the list. |
| **Assign work** | Hand out work the planner could not place. See §[13](#13-handing-out-unassigned-work). |
| **Run facts ▾** | The full set of counts from today's run, plus a refresh button. |
| **?** | What the little boxes mean. Same as §[9](#9-reading-the-little-boxes). |

Two useful keyboard shortcuts: **`/`** jumps to the search box, **`Esc`** backs out one step. Nothing
you can do with the keyboard changes any data — that is deliberate.

**A word about the search box:** it filters what is already on screen; it does not go and fetch more.
If an engineer's name does not match but they are carrying a site or ticket that does, **they stay
visible** — otherwise the search would hide the very thing you searched for.

---

## 6. Red and amber banners: things that need you

These only appear when there is something to say. When they appear, read them before anything else.

### 6.1 The amber banner: this zone's planning run failed

Four versions, and the difference matters:

| It says | Meaning | Do you need to act? |
|---|---|---|
| …was automatically re-dispatched | It broke and the system fixed it | **No.** This is reassurance. |
| …a re-dispatch is queued | It broke, the system is still working on it | **No.** Check back. |
| …could not be recovered automatically | The system tried and gave up | **Yes.** |
| …the operating day ended first | It ran out of time | **Yes.** That work did not happen. |

The last two say plainly that nothing more will be tried today, and that you should run dispatch
manually once whatever caused it is sorted out.

### 6.2 The red banner: critical work nobody could take

> **225 critical tickets need manual assignment**
> No capacity-eligible engineer was available, so the scheduler escalated rather than overloading
> anyone.

Each line is one urgent ticket that needs a decision from you. On the right of each line is what to do
about it, and there are two versions:

- **Assign this work →** — nobody has it. You need to give it to someone.
- **Reassign this work →** — somebody *does* have it, but they have become unavailable. It needs
  moving.

Those are genuinely different situations and the button changes accordingly. Click either one and the
ticket opens in the detail panel at the bottom, where you can act on it.

The banner shows six lines and then a count. They all get resolved the same way.

---

## 7. The left column: your engineers

Everyone on this zone's roster today, whether or not they have work.

Each row shows:

- **Name** — click it to see their details
- **A load badge like `3/25`** — three stops today, twenty-five is their limit. **It turns amber when
  they are at or over their limit.**
- **Their coverage type** — dedicated, multi-plant or floating
- **`2 stops · 7 devices`**
- **Their availability** — shown in amber if they are on leave or off shift

Two things worth knowing:

**That load number is the real one.** It is the same number the planner itself checks before deciding
whether someone can take more work. It is not a separate estimate that might disagree.

**An engineer going on leave does not empty their plan.** Their work stays theirs until a human moves
it. The screen shows both facts: they are unavailable, *and* they are still holding this work. Moving
it is your call.

---

## 8. The middle: the plan itself

This is the main event. **Rows are engineers. Columns are days.** Where they cross, you see that
engineer's work for that day.

Today's column is the detailed one. A cell looks like this:

```
1  Kotputli Works
   ●a1b2c3d4  CRIT       ●e5f6a7b8
2  Neem Works
   ●c9d0e1f2  RET  CHR ×4
```

- **`1` and `2`** are the order of visits.
- **`Kotputli Works`** is the site — the stop. Click it to act on the whole visit at once.
- **The little boxes underneath** are the individual devices. Click one to act on just that device.
- **`adjusted`** next to a site name means a person has already changed it.
- **An amber cell** means that engineer is at or over their limit for that day.
- **`no stops — available`** means exactly that: free, and able to take work.

Only the day you are focused on shows the individual boxes. The days either side collapse to
`5 devices`, which is enough to see the shape of the week without drowning in it.

At the very bottom there may be a row called **Not on today's roster** — work on other days belonging
to engineers who are not working in this zone today. It is there so a day does not look emptier than
it really is.

---

## 9. Reading the little boxes

**This is the most useful page in this guide.** Each little box is one device. Its appearance tells
you four separate things at once, and they never interfere with each other.

### The border: who put this here

| Border | Means |
|---|---|
| **Solid, with a dot** | The **system** planned this |
| **Dashed** | A **person** put this here |
| **Dashed and purple** | A person put this here **and went outside the normal coverage order** |
| **Dotted and faded** | **We do not know who put this here** — it predates our record-keeping |

That last one is important. Faded-and-dotted does not mean "system". It means "unknown", and the
screen refuses to guess.

### The labels: what kind of work this is

| Label | Means |
|---|---|
| **`CRIT`** | Urgent. **This stays on the box no matter who assigned it.** |
| **`RET`** | The vehicle is due back today. |
| **`CHR ×4`** | This device has broken four times. Worth asking whether to replace the unit rather than fix it again. |
| **`~` and faded italic** | A *prediction* for a future day. Nothing has been decided. |

### The cell colour: capacity

**Amber background** = this engineer is at or over their limit that day. It colours the whole cell,
not individual boxes, because being overloaded is a fact about the person's day rather than about one
device.

### Selecting

Clicking a box puts a **ring** around it. The ring is only ever a selection marker — it never changes
the border, because the border is already saying who put the work there.

---

## 10. The right column: work that did not get planned

The middle shows what landed. This column shows what did not, and why. Three tabs:

| Tab | What is in it |
|---|---|
| **Unassigned** | The planner looked and could not find anyone eligible |
| **Held** | Deliberately parked until a date, with the date and who decided |
| **Changes** | What people have changed since the run |

Plus a **chronic** filter that works across whichever tab you are on — because "this device keeps
breaking" is a fact about the equipment, not about where the ticket sits.

Clicking any row here opens the same detail panel you would get by clicking the same ticket on the
board. It is a different door into the same thing.

**One thing you will see and should not chase:** some work is counted but never listed, with a note
saying so. That work was held back by policy before the planner looked at it in detail, so there is
genuinely nothing to list. It is shown as a count on purpose, so that nobody goes hunting for a list
that does not exist.

### The attention list

Clicking **⚠ 6 need attention** in the top strip swaps this column for a ranked list of everything in
**this zone** waiting on a manager — failed verifications, overdue parts, vehicle reports, and so on.
Each line has a count and a link to the right screen.

If a category is not being counted yet, it says **not counted** rather than showing `0`. Those are
different statements and the screen keeps them apart.

---

## 11. Clicking something: the detail panel

Click anything — an engineer, a site, a device, a run — and a panel opens along the bottom. **Only one
thing is ever selected at a time.**

### 11.1 You clicked an engineer

Their coverage, availability, stops and devices today, and their load. If they are over their limit it
says so: *"Dispatch will not add to this engineer; a human still may."*

There are no buttons here, and that is on purpose — every change is really a change to a *site visit*
or a *device*. The panel tells you so.

### 11.2 You clicked a site visit

Which engineer, which position in their day, the site, how many devices, and the list of them. Three
buttons: **Swap engineer**, **Split stop**, **Reorder**.

### 11.3 You clicked a device

Three tabs.

**Why** — the system's own explanation of this decision. Who it considered, which coverage group it
was working in, who it ruled out and for what reason, and how full everyone's day was at the time.

Underneath is the score, broken down:

| Term | Value | Weight | Effect |
|---|---|---|---|
| Company priority | 0.900 | 0.40 | +0.360 |
| Urgency | 0.571 | 0.30 | +0.171 |
| Repeat-failure penalty | 1.000 | 0.20 | −0.200 |
| Device age | 0.480 | 0.00 | +0.000 · *not used here* |
| Distance | 0.250 | 0.10 | +0.025 |
| **Total** | | | **0.356** |

*(Illustrative figures.)* Terms that were not used still appear, marked **not used here**, so that you
can see the difference between Catch-up and Steady mode rather than having to take it on trust.

If distance says **not available**, that means we do not know where the engineer was starting from —
not that the site is zero kilometres away.

**Alternatives** — everyone else who could have taken this, in the system's own order, grouped by
coverage type. Anyone ruled out is greyed with the reason. Every group heading appears even when
empty, because "no dedicated engineer covers this site" is exactly the fact that makes the floating
engineer below it make sense.

**History** — everything that has happened to this ticket, and every visit attempt, with a warning if
it has been attempted too many times.

### 11.4 You clicked "Run decisions"

Every decision the planner made this morning, **in the order it made them**, each one openable for the
full explanation.

Tickets it *could not* place appear here too. A list of only the successes would make the run look
like it did less than it did.

---

## 12. Changing the plan

Everything in this section **saves immediately**. There is no draft and no undo. (The one place that
works differently is handing out unassigned work — §[13](#13-handing-out-unassigned-work).)

**Four things that are always true:**

1. **You must give a reason.** The confirm button stays greyed out until you do. The reason is kept
   against the ticket.
2. **Only the buttons that make sense are shown.** If you cannot see a button, that action is not
   possible for this thing right now. Nothing is shown greyed-out to tease you.
3. **Some changes ask twice.** If a change would tread on something delicate, you get a second,
   deliberate confirmation that explains what it is — not a warning that flashes past.
4. **Where the system can show you the effect, it does.** Where it genuinely cannot, the button still
   works. The preview is there to inform you, never to block you.

### 12.1 What you can do to a device

| If the device is… | You can |
|---|---|
| On someone's plan | **Reassign** (give it to someone else) · **Defer** (do it another day) · **Remove** (take it off the plan) |
| On nobody's plan | **Assign** (give it to someone) · **Hold** (park it until a date) |
| Parked | **Release hold** (put it back in the running) |

### 12.2 What you can do to a site visit

**Swap engineer** — move the whole visit to somebody else.
**Split stop** — move *some* of the devices at that site to somebody else. This is the only place in
the whole product where you tick several things at once.
**Reorder** — move the visit earlier or later in the engineer's day.

### 12.3 Choosing who to move work to

The list only offers engineers from this zone. The current engineer is not in it — you cannot reassign
work to the person who already has it.

Each name shows their load, like `Priya S. (7/25)`. Someone who is already full is **marked, not
removed**:

> The planner will not choose an overloaded engineer. **You can.** The screen shows you what you are
> doing and lets you do it.

### 12.4 The two "are you sure?" moments

**The engineer is on site right now.** They are physically at the location, working on the thing you
are about to move. You can go ahead. It gets recorded.

**The work is parked until a vehicle comes back.** Somebody deferred it for a reason. You can override
that. It gets recorded.

Both show you exactly which tickets are affected before you decide.

> **One thing that catches people out:** when you park a ticket, the date you choose is the day it
> **comes back**, not the last day it stays parked. To keep something out of tomorrow's run, choose the
> day after tomorrow. The form says this underneath the date field.

Releasing a hold needs no reason and takes effect at the very next run.

### 12.5 Running the planner yourself

**Run now** in the top strip. You will be asked to confirm, and the confirmation says three things:

> **Engineers are notified.** A manual run commits day plans through the same path as the 05:00 run, so
> any work it places is pushed to engineers' phones immediately — mid-shift, if it is mid-shift.

That is the one consequence you cannot take back. Everything else on this screen you can adjust
afterwards; a notification that has gone out has gone out.

You can add a reason, which is kept on the record.

**If a run is already going** the button is disabled and tells you when it started. If you somehow get
past that, the system refuses and names the zone, the time and who started it.

**If it reports "No new assignments" — that is normal.** Read the message:

> The run completed and placed nothing — that is the expected result when nothing has changed. Dispatch
> only considers tickets that are still open and unassigned; work already on a plan is never
> re-planned.

Running it twice in a row legitimately does nothing the second time. This is the single most common
reason people think the planner is broken when it is not.

### 12.6 Dragging things

You can drag a device, or a whole site visit, onto another engineer. The cursor turns into a hand when
you are over something you can pick up.

> **Dragging never changes anything by itself.** It opens the normal dialogue with the target already
> filled in. You still get the preview, you still have to give a reason, and you still have to confirm.
> The item does not visibly move until the change is actually saved.

**Where you can drop things:**

| Drag | Onto | Opens |
|---|---|---|
| a device | **an engineer's name in the left-hand list** | Reassign |
| a device | that engineer's cell in **today's** column | Reassign (same thing, other door) |
| a device | the **same** engineer on a **later day** | Defer — "do it then, not today" |
| a device | the work column on the right | Remove |
| a whole site visit | another engineer, left list or today's column | Swap engineer |
| an unassigned row from the right | an engineer | Assign |

The left-hand engineer list is usually the easiest target — it is one column, always visible, and does
not require finding the right cell in the grid.

**Anything else simply will not accept the drop.** As you drag, every place you *can* drop lights up
with a dashed outline; anywhere else shows the "no" cursor. Nothing bad happens if you let go over the
wrong place — nothing happens at all.

Two that catch people out:

- **The engineer who already has it** is not a target. There would be nothing to change.
- **A different engineer on a different day** is not a target either. That would be two changes at
  once — move it to someone else *and* move it to another day — and there is no single dialogue for
  that. Do one, then the other.

---

## 13. Handing out unassigned work

The planner places what it can. **This is where you place the rest.**

Click **Assign work** in the top strip. You stay on the same screen — the zone, the day, the run
status and the banners all stay exactly where they were. Only the three columns change what they hold.

### 13.1 Why this works differently

Everywhere else on this screen, changing something saves it immediately. Here, **nothing is saved until
you say so.**

That is deliberate: handing out work is a plan you build up across several engineers and then commit
in one go. But it means the screen has to be absolutely clear about which of the two you are looking
at, which is why the board disappears while you are doing it. Two things that look alike but mean
opposite things must never be on screen together.

### 13.2 The three columns become three steps

Across the top:

```
① 1479  Not assigned yet        ② 606  Selected for assignment      ③ 873  Will remain unassigned
   waiting in North                  going to 1 engineer · 98 critical      after you commit

Nothing has changed in the system yet — your draft is written only when you commit,
one engineer at a time.
```

Read left to right: **what is available → what you have picked → what will be left over.**

That third number is a *prediction*, which is why it says **will remain** and not "remains". Nothing
has happened yet.

Below the columns are the same three ideas laid out:

- **Right** — *Not assigned yet*: everything you could hand out, grouped by customer and site
- **Middle** — *Your draft — nothing written yet*: what you have picked, grouped by engineer
- **Left** — your engineers, which is now the list of **people to hand work to**

### 13.3 How to actually do it

1. **Tick some work** on the right. Each line shows how many devices, how many are critical, and how
   long the oldest one has been silent.
2. The left column's heading changes to **"Add to whose plan?"** and every engineer gets an **Add 3 →**
   button.
3. **Click an engineer.** The work moves into their lane in the middle.

Repeat for as many engineers as you need. That is the whole operation.

### 13.4 What the screen tells you as you go

**On the engineer you chose:** `25 → 631 / 25` — what they had, what they would have, and their limit.
It turns amber if you are pushing them over.

**In the middle:** *"Will be added to Rahul Verma — 606 devices"*, with a **Take back** button, and the
work shown as small boxes. Those boxes use their own marks:

| Mark | Meaning |
|---|---|
| Solid with a dot | This is within the engineer's normal coverage |
| Dashed purple | You are going outside the normal coverage order |
| Heavy red with a flag | Critical work |
| Dashed red | This engineer does not cover this site at all |
| Amber lane | This would take them over their limit |

Critical work gets its own box — `Kotputli Works ×3 crit` next to `Kotputli Works ×15` — because a
site showing "15" tells you nothing about whether any of it is on a clock.

**None of these stop you.** They are all statements of fact. Overloading somebody is your decision to
make, and the screen makes sure you make it knowingly.

### 13.5 Two things that surprise people

**A shared site moves as one.** If two customers have equipment at the same site, ticking one of them
moves **all** the outstanding work at that site. The line says so — *"shared site — all of its work
moves together"* — and the counts include the lot, because a screen that counted less than it was
about to do would be lying to you.

**Sometimes nobody can take something.** If you use **Spread across engineers…** to share work out
automatically, anything it could not place stays visible in a dashed box with the reason:

- **no coverage** — none of the engineers you picked covers that site at all
- **all dropped** — some do, but every one of them failed a readiness check

Those need different fixes, so the screen keeps them apart. You cannot click these — no one in your
selection can take them. The fix is either coverage or freeing somebody up.

### 13.6 If you leave halfway through

If you have picked nothing, you just leave.

If you have picked something, you get asked:

> **606 devices are selected for 1 engineer and nothing has been written.** Leaving now hands out none
> of it.
> `[Keep drafting]` `[Leave and discard]`

Your selection lives only in this browser tab and disappears when you leave. That is by design. Being
told what you are about to lose is also by design.

### 13.7 Committing

**Review & commit** shows you a summary before anything happens:

- how many devices, to how many engineers
- how much will still be unassigned afterwards
- how many engineers you are pushing over their limit — marked *allowed, not blocked*
- a line per engineer: their coverage, sites, devices, and load before and after
- **a reason, which is required**

If you are overloading somebody it says so in words: *"Rahul Verma is being taken to 25× daily
capacity. This is allowed and will be recorded — it is not blocked."*

Then **Commit**.

### 13.8 What "commit" actually does

**Each engineer is written separately.** This matters:

> There is no all-or-nothing. Three engineers can be written successfully and a fourth can fail, and
> the receipt tells you exactly that instead of averaging it into a single "done".

You then get:

> **606 devices are now on 1 engineer's plan**
> Written one engineer at a time — each line below is its own transaction and its own result.

Per engineer you will see something like `assigned 604, 2 skipped`. Anything skipped because it was
parked can be sorted out right there, without touching the rest.

The commit button disappears afterwards, replaced by **Done** — the work is out and there is nothing
left to commit. Going back to the board shows it already in place.

### 13.9 The separate "Assign Work" page

There is also an **Assign Work** item in the left menu (and the **+ Assign SE** button at the top of
every screen). It works identically with one difference: **it is not limited to one zone.**

That is why it exists. *"Where in the country is the outstanding work?"* is a different question from
*"what is left in my zone today?"*, and it deserves a screen where there is no single-zone board next
to it saying something different.

---

## 14. Common jobs

### It is 9am. What needs me?

1. Open **Today's Dispatch**, pick your zone if asked.
2. **Read the banners first.** An amber failure notice or a red critical banner beats everything below.
3. Check **⚠ n need attention** and open it if the number is not zero.
4. Scan the board for **amber cells** (overloaded people) and **dashed boxes** (changes somebody made
   that you may not know about).
5. Open the right column's **Unassigned** tab to see what could not be placed.

### A critical ticket has nobody — sort it out

1. Click its reference in the red banner. The detail panel opens.
2. Read **Why**. Was it *no coverage* or *everyone was ruled out*? Those need different fixes.
3. Check **Alternatives** — people who were ruled out are listed with the reason, and you can still
   pick them.
4. **Assign**, pick someone, give a reason, confirm.

### An engineer has gone off sick

1. Their row already shows it, and **their work is still theirs** — nothing moved automatically.
2. Click each **site visit** on their row → **Swap engineer** → pick someone → check the effect → give
   a reason → confirm.
3. Move whole site visits rather than individual devices where you can. One action instead of ten.

### Hand out this morning's backlog

1. **Assign work** in the top strip.
2. Tick sites on the right. Watch the three numbers at the top move.
3. Click an engineer on the left for each batch. Watch their load change on their row.
4. Not sure who should get a site? Click the site's **name** — the panel at the bottom shows everyone
   who can cover it and everyone who cannot, with reasons.
5. **Review & commit** → read it → give a reason → **Commit**.
6. Read the receipt. It is per-engineer, and it tells you if any of them failed.

### Why on earth did it choose them?

1. Click the device on the board.
2. Read **Why** — who was considered, who was ruled out and for what reason.
3. Read the score breakdown below it for the actual arithmetic.
4. For the whole morning's reasoning, click **Run decisions →** in the day's column header.

### New urgent work has come in since this morning

1. **Run now** → read the notification warning → give a reason → confirm.
2. If it says **No new assignments**, that is normal — see §[12.5](#125-running-the-planner-yourself).
3. Anything it still could not place shows up in the red banner or the Unassigned tab. Handle it as
   above.

---

## 15. Numbers that could mislead you

This screen is careful about honesty in ways that are easy to miss. These are the ones worth knowing.

**A dash is not a zero.** `—` means *this was not recorded*. `0` means *it was recorded and there were
none*. Very different.

**"Not enforced" is not "passed".** A check the system cannot currently make says so. Do not read it
as an all-clear.

**"Not available" is not "zero kilometres".** It means we do not know where the engineer was starting
from.

**"Reason not recorded" is not a reason.** Where the record is blank, the screen says the record is
blank rather than inventing something.

**The counts do not add up, on purpose.** There are several different reasons work did not get placed,
each belonging to a different person to fix. Adding them into one number would produce a total nobody
can act on.

**A prediction is not a plan.** Future days show what *would* happen. Faded, italic, and not
clickable, because there is nothing there yet to act on.

**Being over capacity never blocks anything.** It is shown, everywhere, always — and it never stops
you.

---

## 16. Who is allowed to do what

Permissions are enforced by the system, not by hiding buttons. If you cannot do something, **you will
not see the button at all** rather than seeing it greyed out.

| | Zonal Manager | Central Service Manager | Operations Head |
|---|---|---|---|
| Which zone | Yours, automatically | Choose one | Choose one |
| Zone selector | Not shown | ✅ | ✅ |
| See the board and everything on it | ✅ | ✅ | ✅ |
| Change the plan (all the actions in §12) | ✅ | ✅ | ✅ |
| Run now | ✅ *(your zone only)* | ✅ | ✅ |
| Hand out work | ✅ your zone | ✅ | ✅ |
| The country-wide Assign Work page | Your zone | ✅ | ✅ |
| Bulk unassign | ✗ | ✗ | ✅ only |

A CSM or Operations Head can work **as** a zone using the *Act as ZM* control at the top. When you do,
the whole screen — including who is offered as a reassignment target — narrows to that zone. This is
important: on a screen about what is left in *this* zone, seeing the whole country's engineers would
be a good way to hand out another zone's work by mistake.

---

## 17. What your engineers actually see on their phones

**Please read this one.** The screen will not tell you, and it changes how you should work.

**The data is correct.** The app asks the right questions and gets the right answers. The day plan it
shows is real, properly ordered, and correctly grouped by site.

**But it is not delivered to them.** Four things are missing:

- **There are no push notifications.** "Your day plan is live" is written down, but nothing pushes it
  to the handset.
- **The app never asks again.** No pull-to-refresh, no automatic refresh. Each screen loads once when
  it opens.
- **The session expires after 15 minutes.** After that the app shows **"Offline"** even on a perfect
  connection, over data that is completely fine on our side.
- **Changes you make are not signalled.** The app has no way of knowing something moved.

**In practice:** an engineer sees whatever was true when they last opened the app fresh. If you
reassign something at 11am, they will not see it until they force-close the app and reopen it — and if
they logged in more than fifteen minutes earlier, reopening shows "Offline" until they log in again.

> **If a change matters today, phone them.** Do not assume the change you just made has reached the
> field.

---

## 18. Word list

| Word | What it means |
|---|---|
| **Zone** | A region. One zone at a time on this screen. |
| **Engineer / SE** | Service Engineer — the person who goes out and fixes things. |
| **Ticket** | One device needing attention. |
| **Stop / site visit** | One visit to one site, covering all its tickets. |
| **Day plan** | One engineer's stops for one day, in order. |
| **Capacity** | How many stops someone can do in a day. Shown `7/25`. |
| **Dedicated / Multi-plant / Floating** | The three coverage types, strongest first. |
| **Coverage** | Which sites an engineer is responsible for. |
| **Went outside the coverage order** | A person assigned work to a weaker coverage type when a stronger one was available. Allowed, marked in purple. |
| **Severity / SLA bucket** | How bad a device's condition is. **Critical** and **High critical** are the urgent ones. |
| **Chronic** | A device that keeps failing. Raises the question of replacing it rather than fixing it. |
| **Catch-up / Steady** | The two planning moods — clearing a backlog, or getting ahead. |
| **Hold / parked / deferred** | Deliberately kept out of planning until a date. |
| **Escalation** | Urgent work the system could not place, handed to a human. |
| **Draft** | Work you have picked but not yet committed. Lives in your browser tab only. |
| **Projection / prediction** | What a future day *would* look like. Nothing committed. |
| **Run** | One execution of the planner, for one or more zones. |
| **Unassignable** | The planner looked and found nobody eligible. |
| **Withheld** | The planner deliberately did not consider it yet. |

---

## If you need more detail

This guide covers the screen. Two other places go deeper:

- **Why a specific decision was made** — the screen itself, always. Click the device, read **Why**.
  There is nothing in a document that beats the system's own record of what it did.
- **How the system is built** — the code comments, `docs/SYSTEM-STATE-2026-07.md`, and the design
  documents in `docs/audits/`. Those are the technical record, and they are the authority if anything
  here disagrees with them.
