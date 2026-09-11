# Intra Habitica Bridge

Parent-only Home Assistant App that turns SkoleIntra homework and calendar
packing lists into Habitica tasks, per kid, and gives parents an Ingress
dashboard for manual To-Dos and Dailies. Kids only ever use Habitica's own app.

Full design: `docs/intra-habitica-bridge-spec.md` in the repository root.

## What it does

- **Homework** (weekdays 06:00 / 13:00 / 17:00): scrapes each kid's SkoleIntra
  Lektiebog and keeps one Habitica To-Do per assignment. An edit to homework
  the kid already finished never touches the finished task — a new To-Do
  titled `<subject> (opdateret)` is created instead. A deleted, unfinished
  To-Do is recreated on the next poll.
- **Packing list** (nightly 01:00): reads tomorrow's events from the kid's HA
  calendar and puts the description lines into a "Pakkeliste" Daily's
  checklist, replaced wholesale each night. The Daily repeats Sunday–Thursday.
- **Dashboard** (sidebar panel "Habitica"): create To-Dos or weekday-repeating
  Dailies for a kid with a difficulty set — the fields HA's own to-do card
  can't reach. Pause a Daily for holidays instead of deleting it. Tracked
  tasks that vanish from Habitica are recreated hourly (Dailies always,
  To-Dos only if they were still open).
- **Streak watch** (hourly): remembers each tracked Daily's streak and fires a
  `streak_dropped` event on the HA bus when it falls, with the old number.

## Setup

1. Add each kid's Habitica account in HA: Settings → Devices & services →
   Habitica. Then find its config entry ID: Developer tools → Actions → pick
   `habitica.get_tasks` → choose the kid's account in the "Config entry"
   dropdown → switch to YAML mode. The YAML shows `config_entry: <id>` — that
   32-character value is `habitica_config_entry`. (The ID in a device page's
   URL is the device ID, which is not the same thing.)
2. Fill in the Configuration tab: SkoleIntra login, and one `children` entry
   per kid. Leave `skoleintra_child_path` blank to skip homework for a kid,
   `calendar_entity` blank to skip the packing list.
3. Restart the App after any configuration change — the kid list is read once
   at startup.

## Streak-drop notification

The App only fires the event; an automation turns it into a notification with
a one-tap restore. `habitica.update_daily`'s `streak` field is exactly what
Habitica's own "Adjust Streak" does.

```yaml
alias: Habitica streak dropped
triggers:
  - trigger: event
    event_type: streak_dropped
actions:
  - action: notify.mobile_app_parent_phone
    data:
      title: "{{ trigger.event.data.child_name }}: streak dropped"
      message: >-
        {{ trigger.event.data.task_title }} went from
        {{ trigger.event.data.previous_streak }} to {{ trigger.event.data.current_streak }}
      data:
        actions:
          - action: "RESTORE_STREAK_{{ trigger.event.data.habitica_task_id }}"
            title: "Restore to {{ trigger.event.data.previous_streak }}"
  - wait_for_trigger:
      - trigger: event
        event_type: mobile_app_notification_action
        event_data:
          action: "RESTORE_STREAK_{{ trigger.event.data.habitica_task_id }}"
    timeout: "24:00:00"
    continue_on_timeout: false
  - action: habitica.update_daily
    data:
      config_entry: "{{ trigger.event.data.habitica_config_entry }}"
      task: "{{ trigger.event.data.habitica_task_id }}"
      streak: "{{ trigger.event.data.previous_streak }}"
```

Due-date signals don't come from this App: trigger on the Habitica
integration's own `calendar.*_dailies` / `calendar.*_todos` entities.

## Local development

```
cp options.example.json options.json   # then fill in credentials
npm install
npm run dry-run                        # one homework poll, nothing written
```

`SKOLEINTRA_USERNAME` / `SKOLEINTRA_PASSWORD` / `SKOLEINTRA_BASE_URL` in the
environment override the file. Outside the App, `data_dir` in options.json
points the SQLite state somewhere local. Habitica reads still go through the
Supervisor, so a dry run outside HA only exercises the scrape.
