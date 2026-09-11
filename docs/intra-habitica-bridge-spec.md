# intra-habitica-bridge — Architecture Spec

Status: new, self-contained project. An earlier design explored a
custom kid-facing PWA with its own database, PIN auth, and a from-
scratch XP/currency/pet economy — none of that carries forward here.
This document doesn't depend on that earlier work or reference it
further; it's a different project, not a revision of one.

## Purpose

A parent-only Home Assistant App that:

1. Scrapes SkoleIntra for homework (ported from the original
   `skoleintra-ha-bridge` project) and creates/updates Habitica To-Dos,
   per kid.
2. Reads each kid's HA calendar, if one's configured, and maintains a
   Habitica Daily (with a checklist) as their packing list.
3. Gives parents a dashboard — served via HA ingress, since only parents
   ever use it — for creating one-off To-Dos or recurring Dailies
   manually, targeted at a specific kid.
4. Relies on HA's own Habitica integration for due-date signaling —
   its native Dailies/To-Do calendars, not a custom sensor this app
   builds — see "Sensors and due-date signals" below for what that
   means in practice.

**Both automatic builders are agnostic per kid, not all-or-nothing.** A
kid with a `calendar_entity` configured gets a packing list; one without
doesn't, no error, it just doesn't run for them. Same independently for
`skoleintra_child_path` and homework. A kid could have one, both, or
neither — the parent dashboard and manual task creation work regardless.

**No kid-facing surface at all.** Kids interact entirely through
Habitica's own app — its own login, its own UI, its own economy. This
app never has a UI a kid opens.

## Design choices worth being explicit about

A few things deliberately aren't part of this design, worth stating
plainly rather than leaving as an implicit gap:

- **No custom gamification economy.** Habitica already has a mature,
  well-documented, actively-maintained task/reward system — XP, gold,
  a pet, a shop, streak achievements — built by people who've been at
  it for years. Building a competing version from scratch would always
  end up worse, not just slower.
- **No evidence-based completion validation, and that's a real,
  deliberate limitation, not an oversight.** Once completion happens
  inside Habitica's own app, there's no interception point — a kid taps
  done in Habitica, and that's that. Building a parallel approval layer
  in front of Habitica to gate that would defeat the entire reason for
  handing the UI over to it in the first place. If verifying actual
  completion, not just a checkbox, ever matters enough to be worth
  solving, that's a reason to reconsider this whole approach — not
  something this spec tries to half-solve.
- **No app-driven timer for the reading task**, for the same root
  reason — that needs a kid-facing UI to host a "start" button and a
  countdown, and there isn't one here. Reading becomes a plain, self-
  reported Habitica Daily. No timer, no
  auto-completion, no enforcement beyond whatever Habitica's own
  streak/consistency mechanics naturally provide.
- **No custom real-world Rewards** (`habitica.create_reward` — gold
  buying real-world privileges like extra screen time). Considered and
  deliberately declined: gold should stay spent inside the game, not
  become a lever for negotiating real-world permissions. This isn't a
  technical limitation — the action exists and the dashboard could
  support it trivially — it's a values call about what gold is allowed
  to mean in this household.
- **The gem/Mystic Hourglass monetization surface can't be controlled
  by this app at all, and that's worth knowing rather than assuming
  otherwise.** Confirmed against Habitica's own wiki: gold is fully
  free and earned through play; gems are primarily real-money (narrow
  free paths exist — winning specific Challenges, contributing to the
  open-source project — neither realistic for a kid); Mystic Hourglasses
  have no free-earning path at all, subscription-only. Since kids use
  Habitica's own app directly with nothing of this project's in front
  of it, there's no way to hide the gem shop or subscription prompts
  from them even if that were wanted — that's Habitica's own UI,
  entirely outside anything the bridge touches. Worth a deliberate
  parenting decision on this, not something to expect a technical fix
  for here.
- **Quests specifically are mostly-but-not-entirely gem-gated —
  confirmed against Habitica's own FAQ rather than assumed either
  way.** The bulk of the quest catalog genuinely is gem-purchase-only,
  and quest scrolls are never obtained as random task-completion
  drops. But there's a real, structured free path tied to ordinary
  play: a starter quest on account creation, one for inviting a party
  member, and automatic free quest scrolls at level 15, 30, 45, and 60
  regardless of spending. Pet-reward quests specifically have no
  confirmed free alternative. Also worth knowing: a quest scroll works
  for a whole Habitica Party once anyone in it owns one — so if both
  kids share a Party, only one person total ever needs gems for either
  of them to take part in a gem-gated quest, not each kid individually.

## Data ingestion — SkoleIntra polling

Unchanged in substance from the original bridge work — this is proven,
already-running logic, only the final destination changes (Habitica
instead of `todo.*` or a custom DB). Full detail ported forward:

**Package**: `skoleintra` (npm, CommonJS). If imported from ESM code,
`import SkoleIntraModule from 'skoleintra'` binds the whole
`module.exports` object, not the class — unwrap with
`const SkoleIntra = SkoleIntraModule.default ?? SkoleIntraModule;`.

**Login**: one shared credential pair — both kids are under the same
parent SkoleIntra login.

**Child identification**: `parent/{id}/{name}` path segments, captured
from the browser per child, not derivable:

- Elliot: `parent/931/Elliot`
- Mio: `parent/1040/Mio`

Stored as `children.skoleintra_child_path` (see Configuration below).
`childUrl` is a private field on the `SkoleIntra` instance, overridden
via a plain property assignment — but only *after* the instance has
made one authenticated request, since `authenticate()` overwrites it
from the login redirect as a side effect otherwise:

```javascript
const instance = new SkoleIntra(username, password, baseUrl);
await instance.getWeeklyPlan(correctedInputDate(new Date())); // triggers login
instance.childUrl = childPath; // only sticks now that the instance is authenticated
const plan = await instance.getWeeklyPlan(correctedInputDate(new Date()));
```

**Confirmed library bug — week numbers aren't ISO 8601.** SkoleIntra's
`DatetimeHelper.getWeekNumber()` computes `ceil(days-since-Jan-1 / 7)`,
not true ISO week numbering, which the site actually expects. Fix: feed
`getWeeklyPlan()` a fabricated date engineered to make the buggy formula
land on the real ISO week/year, rather than patching the library:

```javascript
function correctedInputDate(targetDate) {
  const isoYear = getIsoWeekYear(targetDate);
  const isoWeek = getIsoWeekNumber(targetDate);
  const daysOffset = isoWeek * 7 - 1;
  const jan1 = new Date(isoYear, 0, 1);
  return new Date(jan1.getFullYear(), jan1.getMonth(), jan1.getDate() + daysOffset);
}

function getIsoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function getIsoWeekYear(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  return d.getUTCFullYear();
}
```

Every `getWeeklyPlan()` call must go through this — permanent
requirement, not a one-off fix. Breaks only at the ISO year boundary
(late December, week 53) — irrelevant during winter break anyway.

**Cookie persistence**: one login, one cookie jar, one `SkoleIntra`
instance per poll cycle handling both kids (fetch child 1, override
`childUrl`, fetch child 2 on the same authenticated instance, persist
cookies once at the end).

**How to port it**: copy the actual source from the `skoleintra-ha-bridge`
repo rather than reimplementing from this summary — the real code has
error handling and defensive details a description like this won't
capture. Only the last step (what happens with the scraped data) changes.

**Poll schedule**: weekdays, 06:00 / 13:00 / 17:00.

## Configuration — via HA's native Options tab

Supervisor generates the config form from a schema — nothing custom to
build, same approach as any other HA App with real setup needs.

```yaml
options:
  skoleintra:
    base_url: "https://herlevprivatskole.m.skoleintra.dk"
    username: ""
    password: ""
  children:
    - slug: "elliot"
      name: "Elliot"
      skoleintra_child_path: "parent/931/Elliot"
      calendar_entity: ""
      habitica_config_entry: ""
      homework_difficulty: "medium"
      packing_difficulty: "trivial"
    - slug: "mio"
      name: "Mio"
      skoleintra_child_path: "parent/1040/Mio"
      calendar_entity: "calendar.mio_school"
      habitica_config_entry: ""
      homework_difficulty: "medium"
      packing_difficulty: "trivial"

schema:
  skoleintra:
    base_url: "url"
    username: "str"
    password: "password"
  children:
    - slug: "str"
      name: "str"
      skoleintra_child_path: "str?"
      calendar_entity: "str?"
      habitica_config_entry: "str"
      homework_difficulty: "list(trivial|easy|medium|hard)"
      packing_difficulty: "list(trivial|easy|medium|hard)"
```

- `skoleintra_child_path` and `calendar_entity` are both nullable — this
  is what makes the automatic builders agnostic per kid. A blank
  `calendar_entity` means no packing list for that kid, silently, not
  an error.
- `habitica_config_entry` is **not** nullable — every configured kid
  needs a Habitica destination, since manual task creation through the
  parent dashboard applies to any configured kid regardless of whether
  either automatic builder is active for them. Set up once per kid via
  Settings → Devices & services → Habitica in HA itself (their User ID
  and API Token entered there, not in this app's config) — this field
  just identifies which of those entries a given kid maps to.
- `homework_difficulty` / `packing_difficulty`: difficulty/priority is
  the one lever that actually affects Habitica's XP/gold payout that
  this app can set directly (confirmed against Habitica's own reward
  formula — see "Habitica mechanics notes" below). Defaulting homework
  to `medium` and packing to `trivial` reflects that packing was never
  meant to be a meaningful reward driver, expressed here through
  Habitica's own difficulty setting rather than anything custom-built.

### Configuration drives the dashboard directly — no separate setup step

The `children` array in Options isn't just input to the automatic
builders — it's also where the dashboard gets "which kids exist" at
all. On startup, this app reads `/data/options.json` once and holds the
parsed `children` list in memory; the dashboard's kid-picker, the
SkoleIntra poller's list of accounts to check, and the calendar-sync
job's list of kids to look at all read from that same in-memory list,
not three separate configuration surfaces.

No PIN-hashing step is needed here the way an earlier kid-facing design
would have needed — this app has no kid-facing auth to prepare, so
there's nothing to transform before use. That means no synced database
table for `children` either; the in-memory list built from `options.json`
at startup is the whole thing, not a cache in front of something else.

**Practical implication**: adding a kid, or changing any of their
settings, only takes effect after restarting the App — standard
Supervisor behavior, but worth being explicit about here specifically,
since "I added a kid in Options and they're not showing up in the
dashboard yet" is the most likely place for that general rule to
actually bite during setup.

## Talking to Habitica — through HA's integration

**Reversed twice now** — worth being upfront about that rather than
quietly landing here. An earlier version of this design routed
everything through HA's Habitica integration; a subsequent revision
moved to calling Habitica's raw API directly, citing a sensor-update
bug and a breaking API change as evidence of real fragility. On review,
that evidence was weaker than it was presented: the sensor bug was from
April 2025 — over a year of active HA development ago, with no check
on whether it was ever fixed — and the breaking-API-change report was
describing an old-style legacy integration (the kind installed by
copying a file into `custom_components/`), not the current
config-flow-based official one. Citing both as current risk to the
integration this app would actually use wasn't a fair comparison.

**What tips this back decisively**: the official integration turns out
to expose far more than the service actions and character-stat sensors
checked earlier. It creates real `todo` entities for both To-Dos and
Dailies — full add/edit/delete/check-off, not read-only — and real
calendar entities: a To-Do calendar (due dates for active to-dos), a
Dailies calendar (today's and upcoming daily tasks, active specifically
when something's unfinished today), plus separate reminder calendars
for each. That Dailies-calendar behavior — active when something's
outstanding today — is close to the entire due-date-checking mechanism
this app would otherwise need to build from scratch. Worth using
something that specific and that well-matched rather than
re-implementing it, especially from a team held to HA's quality-scale
standards (Silver tier and above explicitly require graceful recovery
from connection errors and reliable state — a real, checkable bar).

**Practical effect on this design**: creation and updates that need
Habitica-specific fields (particularly `priority` — the actual API
field name for what Habitica's own UI labels "Difficulty," confirmed
against HA's field reference — which isn't part of the generic `todo`
entity schema) go through the integration's own Habitica-specific
actions
(`habitica.create_todo`/`habitica.update_todo`/`habitica.update_daily`).
Due-date checking — the entire reason "Sensors published back to HA"
below was going to poll Habitica directly and compute state itself —
can likely just read the native Dailies/To-Do calendar entities
instead, no custom polling loop needed. Each kid's Habitica account is
one HA-side integration entry (`habitica_config_entry` identifies
which), and this app stores no Habitica credentials of its own at all.

**Confirmed**: the generic `todo.add_item`/`todo.update_item` actions do
not expose `priority` at all — that field, and the weekly `repeat`
pattern for Dailies, are only reachable through Habitica's own specific
actions (`habitica.create_todo`, `habitica.update_todo`,
`habitica.update_daily`). This settles it — task creation and updates
go through those, not the generic `todo.*` actions, as a functional
requirement rather than a stylistic preference. Still open: whether a
dedicated Daily-*creation* action exists at all (`update_daily` was
confirmed; a distinct creation action wasn't) — worth checking early,
same as before.

## Data model (SQLite)

Deliberately small — Habitica is the source of truth for task content
and completion, so this app only needs enough state to know which
Habitica task corresponds to which scraped/calendar-derived item, for
update-in-place rather than duplicate creation.

```sql
CREATE TABLE skoleintra_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cookie_data TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE homework_task_map (
  id INTEGER PRIMARY KEY,
  child_slug TEXT NOT NULL,
  source_key TEXT NOT NULL,            -- '${date}::${subject}'
  habitica_task_id TEXT NOT NULL,      -- the CURRENT task future updates apply to —
                                        -- reassigned to a new task's ID if an edit
                                        -- arrives after the previous one was completed
                                        -- (see "Homework: creation, updates..." below);
                                        -- the frozen original stays in Habitica, just
                                        -- no longer referenced here
  content_hash TEXT NOT NULL,
  last_known_status TEXT NOT NULL,     -- 'needs_action' | 'completed' — refreshed on
                                        -- every poll as a reference/fallback value;
                                        -- the actual finished-vs-not decision on a
                                        -- content change uses a live check instead,
                                        -- not this cached field (see below)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(child_slug, source_key)
);

CREATE TABLE packing_daily_map (
  child_slug TEXT PRIMARY KEY,
  habitica_task_id TEXT NOT NULL       -- one Daily per kid; checklist items inside
                                        -- it get wholesale-replaced nightly, not
                                        -- individually tracked
);
```

`dashboard_managed_tasks` — tracking recurring/manual tasks created
through the parent dashboard, for the recreate-on-delete behavior — and
`daily_streak_snapshots` — tracking current streak values for
drop-detection and parent-notification — are both defined under "Parent
dashboard" and "Reading task" below respectively, rather than here,
since each is specific to its own feature rather than core app state.
Task *content* itself always lives in Habitica as the source of truth
for anything the dashboard displays live; neither table duplicates that
data wholesale — each holds only the narrow slice needed for its own
feature (a recreate definition, or a comparison value for detecting a
drop).

## Homework: creation, updates, and handling teacher edits after completion

**New assignment** (`source_key` not in `homework_task_map`): create a
Habitica To-Do via `habitica.create_todo` (title = subject, notes = full
assignment text, due date = the assignment's date, priority = the
configured `homework_difficulty`), targeting the kid's
`habitica_config_entry`. Store the mapping row.

**Content changed** (`source_key` exists, `content_hash` differs): check
the *current* status of `homework_task_map`'s mapped task — live, not
the cached `last_known_status`, since this decision is consequential
enough to be worth one extra check rather than risk acting on stale
information. Two paths from there:

- **If unfinished**: update in place via `habitica.update_todo` — same
  task, new notes, no complications. This is the common case and needs
  nothing clever.
- **If already completed**: leave that task **completely untouched** —
  title, notes, completion state, rewards, all of it frozen exactly as
  it was — and create a **new** To-Do with the full current assignment
  text (not a diff of what changed) and a title clearly labeled as an
  update, e.g. `"{subject} (opdateret)"`, so it reads as "this one needs
  a closer look" rather than looking identical to a fresh assignment.
  Update `homework_task_map`'s row to point at this new task's ID —
  it's now the one future updates apply to, not the frozen original.

This never touches a reward that's already been earned, which was the
whole point of caring about this in the first place — no clawback, no
experienced dip, nothing happening to the kid because of something a
teacher did. The tradeoff is a second, separate task appearing rather
than one task quietly reopening, which is a fair trade: it's visible and
honest about what happened, rather than invisible in either direction.

**Why full content instead of a computed diff**: a real text diff
between the old and new description works fine when a teacher *adds*
something ("...also do exercises 6-7"), but degrades badly when they
*replace* something ("read chapter 3" becoming "read chapter 4" isn't a
clean addition, and a mechanical diff produces an awkward fragment
rather than a usable instruction). Danish prose won't reliably fall into
the clean-addition case, so the more robust choice is the complete
current text every time, clearly labeled — a full, readable assignment
beats a technically-more-minimal diff fragment.

`last_known_status` still gets refreshed on every poll — reading it off
HA's own Habitica-backed `todo` entity for that task, the same source
the due-date calendars pull from, not a separate call — and remains
useful as a general reference/fallback, just not the sole basis for the
finished/unfinished decision above, given how much that decision
actually matters.

## Packing list: calendar sync into a Habitica Daily

For each kid with `calendar_entity` set, nightly (same `node-cron`
infrastructure as the SkoleIntra poll, different schedule — 01:00 is a
reasonable default):

```
GET http://supervisor/core/api/calendars/<calendar_entity>
    ?start=<tomorrow 00:00 ISO>&end=<day after 00:00 ISO>
Authorization: Bearer $SUPERVISOR_TOKEN
```

Direct calendar REST endpoint, not the `calendar.get_events` action —
no automation/response-variable involved, and it returns `uid` per
event where the action-based call doesn't.

Per event: take `description`, split on newlines, trim, drop blanks,
flatten across all of tomorrow's events, dedupe. If `packing_daily_map`
has no row for this kid yet, create the Daily once — via HA's Habitica
integration if a dedicated creation action exists (see the still-open
question under "Talking to Habitica" above), `priority: packing_difficulty`
— and store its task ID.

**The Daily's own recurrence needs to match which nights actually have
a "next day" to pack for, not run every night.** Packing is for school
the next morning, so it only applies Sunday through Thursday — Friday
and Saturday nights have nothing to pack for. Confirmed against HA's
own `habitica.update_daily` field reference: `frequency: weekly` plus
`repeat` set to the specific weekday list (`sun`, `mon`, `tue`, `wed`,
`thu` — exact enum casing/format to confirm against a real call before
relying on it). This is set once at creation, not something the nightly
sync needs to touch again afterward. Worth being clear this is
independent of when the *sync job itself* runs — the job can still run
every night without issue, since a night with no calendar events just
produces an empty checklist regardless; what actually matters is that
the Daily doesn't show as something to check off on nights it doesn't
apply to at all.

Then replace the checklist wholesale — remove existing checklist items,
add the fresh set — every night, rather than diffing. A packing list is
"what's needed tomorrow," not something with edit history worth
preserving.

**Worth knowing, not a design decision needed now**: Habitica Daily
checklists don't affect XP/gold at all, only item-drop chance — checking
off "socks" then "lunchbox" individually pays nothing; only completing
the Daily itself does. Consistent with `packing_difficulty` defaulting
to `trivial` — this was never meant to be a meaningful reward driver.

## Parent dashboard

Served via HA ingress — no standalone port needed, since only parents
ever access this and they're always going through HA anyway. No PIN
system, no dual auth paths — a single, simple surface.

**Manual task creation**: pick a kid, pick To-Do or Daily, enter
title/notes/due-date (To-Do) or title/notes/repeat-days (Daily), submit
— calls `habitica.create_todo` or the Daily creation path against that
kid's `habitica_config_entry`.

**Confirmed the dashboard is genuinely required, not just a nicety on
top of what already exists.** HA's Habitica integration exposes the
underlying actions with real capability — repeat-day patterns,
difficulty, all of it — but the native `todo` card consuming those
entities doesn't surface those richer fields in its UI. A parent could
add a bare title through the native card, but not a properly-configured
recurring Daily with specific weekdays and a difficulty set — that gap
is exactly what this dashboard exists to close, not a matter of
convenience layered over something already sufficient.

**Recurring Dailies support specific weekdays** — Habitica's
`frequency: weekly` plus an explicit day list, e.g. Monday–Friday only,
confirmed via HA's own integration docs. This is the clearest example
of the gap above: real, natively-supported capability with nowhere in
HA's own UI to actually set it, so the dashboard's day-picker isn't
optional polish, it's the only way to reach it at all.

**Pausing, not deleting, for things like vacations**: confirmed against
HA's own `habitica.update_daily` field reference — setting `every_x` to
`0` makes a Daily inactive (shown greyed out) without losing its
accumulated history or streak. (Correcting an earlier draft of this
spec, which had this as `frequency: 0` — `frequency` is actually the
separate field for `daily`/`weekly`/`monthly`/`yearly`; `every_x` is
the repeat-interval count that `0` disables.) **This needs to be a
real, one-tap button in the dashboard UI** — "Pause until —" — not a
toggle buried inside an edit form. The whole point of offering pause as
the
sanctioned alternative to deletion is that it has to be at least as
easy to reach as deleting would be, or a parent (or kid) under time
pressure just deletes anyway out of habit.

### Interface design — match Home Assistant's own look, reference `reolink-nvr-bridge`

Same instinct as the earlier "modern and fun" design direction for the
retired kid-facing app, but inverted here — since this dashboard is
parent-facing and lives inside HA's own ingress panel, it should read
as a natural extension of HA itself, not a distinct app bolted on.
**Use the `reolink-nvr-bridge` project as the direct reference** — it
already solved this well, with a genuinely good HA-theme
implementation worth mirroring rather than re-deriving from scratch.
Whoever implements this should open that project's frontend code
directly for the actual patterns (theme variable usage, component
styling) rather than working from this description alone — same
principle as "copy the actual source" for the SkoleIntra polling logic
under "Data ingestion" above, not a one-off suggestion specific to this
section.

**Recreate-on-delete, now a real feature — and it turns out to need
three different mechanisms, not one, depending on where each task's
"true" content actually lives:**

- **Homework**: needs nothing new. The SkoleIntra poll already
  re-fetches the current assignment text on every cycle regardless. Add
  one check before the existing content-hash comparison: if
  `homework_task_map`'s mapped task no longer exists in Habitica, treat
  it exactly like a brand-new assignment — recreate from what was just
  scraped. No stored definition needed, since SkoleIntra itself is
  already the source of truth being re-read every cycle anyway.
- **Packing list**: same idea. The nightly calendar sync already
  regenerates the packing Daily's checklist from scratch every night. If
  `packing_daily_map`'s stored ID no longer exists, treat it as "no
  Daily yet" and create fresh, same as the first time. Nothing extra to
  store here either.
- **Dashboard-created tasks** (the reading Daily, and any other manually
  set-up recurring task or one-off To-Do): this is the one case with no
  other process already re-deriving the task from somewhere else, so
  it's the one that actually needs new tracking:

  ```sql
  CREATE TABLE dashboard_managed_tasks (
    id INTEGER PRIMARY KEY,
    child_slug TEXT NOT NULL,
    habitica_task_id TEXT NOT NULL,
    task_type TEXT NOT NULL,        -- 'todo' | 'daily'
    title TEXT NOT NULL,
    notes TEXT,
    due_date TEXT,                  -- set for 'todo'
    repeat_days TEXT,               -- set for 'daily', e.g. 'mon,tue,wed,thu,fri'
    difficulty TEXT NOT NULL,
    last_known_status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_verified_at TEXT NOT NULL
  );
  ```

  A periodic check (hourly is a reasonable default, nothing here is
  time-sensitive) verifies each row's `habitica_task_id` still exists.
  If not, what happens next depends on `task_type`:

  - **`daily`**: always recreate, no exceptions. Pausing (setting
    `every_x: 0`, per the section above) is the sanctioned way to
    legitimately stop a recurring task — so a Daily disappearing
    outside of that is either accidental or a deliberate dodge, and
    either way, restoring it is the right default. Update the row's
    `habitica_task_id` to the new task.
  - **`todo`**: only recreate if `last_known_status` was
    `'needs_action'` the last time it was checked. A completed To-Do
    that later gets deleted is normal, healthy cleanup — recreating
    that would just be annoying, not useful. Only an *incomplete* one
    disappearing looks like something worth restoring.

  **Worth being honest about the real cost, regardless of the
  decision**: recreation is not restoration. A deleted task's
  accumulated value and raw streak count don't come back — there's no
  undelete in Habitica's API, only a fresh task starting at zero. One
  genuine mitigation, confirmed against Habitica's own wiki: streak
  *achievements* (the permanent +0.5% drop-chance bonus earned every 21
  consecutive days) are retained forever, even through a deleted Daily,
  a lost streak, or a full account reset — so the loss from recreation
  is real but not total. The raw number resets; whatever milestone tier
  was already banked doesn't.

## Reading task: a Daily, with the streak actually protected

Reversed from an earlier version of this section, which recommended a
recurring To-Do specifically to avoid Habitica's native streak
mechanic. That recommendation was based on Habitica's streak being
*unprotected* — no freeze, no recovery path. Confirmed since then, from
Habitica's own settings screen and wiki, that this isn't accurate: it
has both a coarse tool (**Pause Damage**, née "Rest in the Inn" — an
account-wide toggle that stops HP loss and streak resets from missed
Dailies while active, renamed when the old Tavern/Inn location UI was
retired in 2023) and a precise one (**Adjust Streak** — manually
setting a Daily's streak count directly, no justification needed). The
earlier concern doesn't hold once real protection tools exist — so
reading is a Habitica Daily after all, with this app actively using
those tools rather than working around the mechanic entirely.

**The reward math independently points the same direction**, confirmed
against Habitica's own wiki rather than assumed: a Daily's streak adds
+1% of the task's value to gold (and +1% to drop chance) per
consecutive day, stacking on top of the normal value-based reward, with
no confirmed cap on that layer — plus a separate, *permanent* bonus
every 21-day streak multiple that survives even a later reset. A To-Do
recreated fresh each day stays near the top of the value-based reward
curve indefinitely, but that's a hard ceiling it never grows past. Early
on, the fresh-To-Do path likely pays slightly more, since the streak
bonus hasn't grown large enough yet to offset Habitica's usual
diminishing-returns curve on the base value — but over any real time
horizon, the compounding streak bonus and the permanent achievement
layer should overtake a path with nothing that grows over time at all.
Worth knowing this arrives at the same conclusion as the behavioral
case above from a completely different angle — not required to trust
one argument alone.

**The one real gap**: Habitica doesn't remember what a streak was
before it reset — there's no undo, a parent has to already know the
number to restore it via Adjust Streak. This app closes that gap almost
for free, since it's already polling Habitica regularly for other
reasons:

```sql
CREATE TABLE daily_streak_snapshots (
  child_slug TEXT NOT NULL,
  habitica_task_id TEXT NOT NULL,
  streak_value INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (child_slug, habitica_task_id)
);
```

One row per tracked Daily (the reading task, the packing Daily, and any
future one), holding only the *current* known value — not a growing
history log, since the only thing this needs to answer is "what was it
right before it dropped."

**On every poll cycle** (piggybacking on whatever cadence already
exists for status checks, no new schedule needed): read each tracked
Daily's current streak, compare to the stored snapshot. If it dropped:

1. Fire `POST /api/events/streak_dropped` with `{child_slug, task_title,
   previous_streak, current_streak}` — same event-firing mechanism
   already established for the reading-timer completion signal earlier
   in this project's history, reused here rather than invented fresh.
2. An HA automation with a matching `trigger: event` notifies the
   parent — "Mio's reading streak dropped from 12 to 0" — with the old
   number right there, not something the parent has to have remembered
   themselves.
3. Update the snapshot to the new (dropped) value regardless, so the
   next comparison is against reality, not a stale high-water mark.

**Confirmed**: `habitica.update_daily` takes a `streak` (integer)
parameter — "Adjust or reset the streak counter of the daily," directly
from HA's own field reference, matching exactly what "Adjust Streak"
does in Habitica's own UI. The parent notification can be a real
actionable button — tap to restore to the last known value, no
app-switching to Habitica's own Advanced Options screen required.

**Worth being honest about what this design still asks of a parent**:
unlike full automation, this requires someone to actually see the
notification and decide whether to act on it — a dropped streak that
nobody notices still sits dropped. That's a deliberate choice, not an
oversight: automatically restoring every drop with no judgment involved
would make the number meaningless regardless of how many days actually
get missed. A parent's judgment about "was this one forgetful day, or
has reading actually stopped" is doing real work here that shouldn't be
silently automated away, even in service of convenience.

## Sensors and due-date signals: mostly not this app's job anymore

**This section shrank considerably once the integration's actual
capabilities were checked properly** — most of what it was going to
build from scratch (poll Habitica, compute "is anything due," publish
that as a sensor) already exists as the integration's native Dailies
and To-Do calendars, per kid, once a `habitica_config_entry` is set up
for them. The Dailies calendar in particular is specifically described
as active when something's unfinished for today — that's the exact
signal a homework-due-tomorrow or reading-not-done automation would
want to trigger on, already built, already maintained by someone else.

**So, the default plan**: automations that care about "does this kid
have something outstanding" trigger directly on
`calendar.<habitica-entry>_dailies` / `calendar.<habitica-entry>_todos`
(exact entity naming to confirm once set up), not on anything this app
publishes. Nothing to build, nothing to keep in sync, one less thing
that can drift from what Habitica actually shows.

**Where this app might still publish something of its own**: only if a
signal doesn't map cleanly onto what the native calendars express —
for instance, a specific per-kid "homework due tomorrow" boolean scoped
tighter than "anything due today across all Dailies and To-Dos," if
that distinction ends up mattering for how the existing due-tomorrow
automations are rebuilt. Not designed in detail here, since it's
genuinely unclear yet whether it's needed at all once the native
calendars are actually in front of someone — worth revisiting after
they're set up and seeing what they cover before building anything
extra.

## Habitica mechanics notes (confirmed, worth keeping on record)

A few things confirmed through direct research while designing this,
worth having written down rather than re-deriving later:

- **Task value** (the color/diminishing-returns mechanic) barely
  affects homework — it only builds up through repeated interaction
  with the *same* task, and each homework item is a one-off. It matters
  for the reading Daily specifically, if that ends up being a single
  persistent recurring task.
- **Streaks are a separate mechanic from task value**, running
  alongside it, and do provide standing bonuses for consistency (drop-
  chance bonuses confirmed; the full scope of streak bonuses wasn't
  chased down further since it wasn't decision-relevant here).
- **Difficulty/priority is the one lever this app directly controls**
  that affects payout — trivial (0.1×), easy (1×, default), medium
  (1.5×), hard (2×). Task value, the player's own stats, and critical
  hits are either time-evolved or belong to the character, not
  something a task-creation call can set.
- **Habitica requires parental permission for any child under 13** —
  emailed to `admin@habitica.com` with the child's username and User
  ID, per Habitica's own published policy. A real, concrete step to
  actually do, not just a legal footnote — both kids are well under 13.
  Habitica's own guidance explicitly supports a parent creating and
  holding the account on a young child's behalf, which is the model
  this whole app assumes anyway (this app's config holds each kid's
  credential, entered by the parent — not the kid).

## Open decisions

- **No research found specific to children's response to streak
  mechanics** — the behavioral-science basis this design leans on
  (loss aversion, the "what-the-hell effect") is drawn from
  general-population studies (dieters, adult app users), extrapolated
  to this household's context rather than a direct match. Doesn't
  invalidate using Habitica's protection tools, but worth remembering
  this is an adaptation of adult-focused research, not a direct
  finding about children specifically.

## Implementation order

1. **Set up HA's Habitica integration for both kids first** (Settings →
   Devices & services → Habitica, one entry each) and confirm what
   remains genuinely open before building around it: whether a
   dedicated Daily-*creation* action exists (`update_daily` is
   confirmed, including its `streak`, `priority`, and weekly `repeat`
   fields — see "Talking to Habitica" and "Reading task" above for what
   that already settles), and the exact enum format `repeat` expects
   for weekday values (used for the packing Daily's Sunday–Thursday
   schedule — see "Packing list" above). Also worth a first look at the
   native Dailies/To-Do calendar entities once real tasks are in them,
   since "Sensors and due-date signals" depends on what they actually
   show.
2. Port SkoleIntra polling from the original bridge repo (copy the
   actual source, not a reimplementation from this summary) — proven
   logic, only the destination changes.
3. Habitica To-Do creation/update for homework, including the
   spawn-a-new-task-if-already-completed behavior on content change,
   *and* the existence check that makes recreate-on-delete work for
   homework (see "Recreate-on-delete" under "Parent dashboard") — via
   HA's integration per step 1's findings.
4. Calendar sync + packing-list Daily/checklist management (including
   the Sunday–Thursday `repeat` schedule), including its own existence
   check (same recreate-on-delete section).
5. Parent dashboard: manual To-Do/Daily creation (scoped to what the
   native to-do card doesn't cover — see "Parent dashboard" above),
   pause-not-delete for Dailies (`every_x: 0`), and the
   `dashboard_managed_tasks` watchdog job for anything created through
   it.
6. Streak-drop detection: `daily_streak_snapshots` polling, the
   `streak_dropped` event firing, and the one-tap restore action via
   `update_daily`'s confirmed `streak` field (see "Reading task"
   above).
7. Package as an HA App: `homeassistant_api: true`, `ingress: true` +
   panel config for the dashboard. No exposed `ports:` needed — there's
   no standalone kid-facing surface to support here.
8. Send Habitica's required parental-permission email for both kids
   before relying on this for real.
9. Once the dashboard and automatic builders are working, revisit
   whether any custom due-date sensor is actually needed on top of the
   native calendars from step 1 — see "Sensors and due-date signals"
   above. Deliberately last, not because it's unimportant, but because
   it's only answerable after seeing the native calendars in practice.
