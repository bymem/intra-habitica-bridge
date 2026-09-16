# Changelog

## 0.3.5

- Dashboard: homework and the packing list moved to their own "Synced" card,
  homework in due-date order.

## 0.3.4

- Dashboard lists homework To-Dos (today onwards) alongside dashboard and
  packing tasks, with a source badge and created/updated times.
- Homework `updated_at` now only moves on a content change or recreate, not
  when the kid completes the task.
- Packing Daily records when it was created and when its checklist last
  changed.

## 0.3.3

- Dashboard: "Sync packing" button runs the packing sync now; packing row
  shows its checklist item count.

## 0.3.2

- Completed one-off To-Dos disappear from the dashboard and are untracked
  by the watchdog.

## 0.3.1

- Dashboard scrolls inside the panel itself, fixing a stuck page in the HA
  iOS app.

## 0.3.0

- Dashboard: edit tracked tasks (title, notes, difficulty, due date or
  repeat days).

## 0.2.1

- Pace Habitica writes (12 s apart per account) and retry once after a
  rate-limit 500, so a first poll with many assignments no longer fails.

## 0.2.0

- Homework To-Dos in Habitica: create, update in place, spawn a labelled
  follow-up when the original is already done, recreate on delete.
- Packing-list Daily from the kid's HA calendar, Sunday–Thursday.
- Parent dashboard via Ingress: To-Do/Daily creation with difficulty and
  weekday repeat, pause/resume, untrack.
- Hourly watchdog: recreate dashboard tasks that disappear, `streak_dropped`
  event on the HA bus.

## 0.1.0

- Initial scaffold: configuration, SQLite state, SkoleIntra Lektiebog polling.
