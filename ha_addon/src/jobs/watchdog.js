// Watchdog: keeps dashboard-created tasks alive, and watches Daily streaks.
//
// Runs hourly — nothing here is time-sensitive. One get_tasks call per kid
// serves both halves.
//
// Recreate-on-delete for dashboard tasks: this is the one kind of task no
// other process re-derives from somewhere else, so the stored definition is
// the only way to bring it back. Dailies are always recreated — pausing
// (every_x: 0) is the sanctioned way to stop one, so a vanished Daily is
// either an accident or a dodge. To-Dos are only recreated if they were still
// open when last seen; deleting a finished To-Do is normal cleanup.
//
// Streaks: Habitica doesn't remember what a streak was before it reset. The
// last seen value is kept per tracked Daily so a drop can be reported with the
// old number, for a parent to restore (habitica.update_daily's `streak`).

export const STREAK_DROPPED_EVENT = 'streak_dropped';

export async function runWatchdog({ config, store, ha, habitica, log }) {
  for (const child of config.children) {
    try {
      await checkChild({ child, store, ha, habitica, log: log.child(child.slug) });
    } catch (error) {
      log.error(`${child.slug}: watchdog failed: ${error.message}`);
    }
  }
}

async function checkChild({ child, store, ha, habitica, log }) {
  const entry = child.habitica_config_entry;
  const tasks = await habitica.getTasks(entry, ['todo', 'daily']);

  // --- Dashboard-managed tasks ---------------------------------------------
  for (const row of store.listManagedTasks(child.slug)) {
    const task = tasks.get(row.habitica_task_id);
    if (task) {
      if (row.task_type === 'todo' && task.completed) {
        // A finished one-off is never recreated, so there is nothing left
        // to track; drop it rather than carry a row that can't act.
        log.info(`managed To-Do "${row.title}" finished — untracking`);
        store.deleteManagedTask(row.id);
        continue;
      }
      store.verifyManagedTask(row.id, {
        taskId: row.habitica_task_id,
        lastKnownStatus: task.completed ? 'completed' : 'needs_action',
      });
      continue;
    }

    if (row.task_type === 'todo' && row.last_known_status !== 'needs_action') {
      // A completed To-Do that got cleaned up (or aged out of Habitica's
      // completed list). Its job is done; stop tracking it.
      log.info(`managed To-Do "${row.title}" finished and gone — untracking`);
      store.deleteManagedTask(row.id);
      continue;
    }

    const taskId = await recreate(habitica, entry, row);
    log.warn(`managed ${row.task_type} "${row.title}" missing from Habitica — recreated as ${taskId}`);
    if (taskId) {
      store.verifyManagedTask(row.id, { taskId, lastKnownStatus: 'needs_action' });
      if (row.task_type === 'daily') {
        store.deleteStreak(child.slug, row.habitica_task_id);
      }
    }
  }

  // --- Streak snapshots ------------------------------------------------------
  const trackedDailies = [
    store.readPackingDaily(child.slug)?.habitica_task_id,
    ...store.listManagedTasks(child.slug).filter((row) => row.task_type === 'daily').map((row) => row.habitica_task_id),
  ].filter(Boolean);

  for (const taskId of trackedDailies) {
    const task = tasks.get(taskId);
    if (!task) {
      continue;
    }
    const current = Number(task.streak ?? 0);
    const previous = store.readStreak(child.slug, taskId);
    if (previous !== null && current < previous) {
      log.warn(`streak dropped on "${task.text}": ${previous} -> ${current}`);
      await ha.fireEvent(STREAK_DROPPED_EVENT, {
        child_slug: child.slug,
        child_name: child.name,
        habitica_config_entry: entry,
        habitica_task_id: taskId,
        task_title: task.text,
        previous_streak: previous,
        current_streak: current,
      });
    }
    // Updated regardless, so the next comparison is against reality rather
    // than a stale high-water mark.
    if (previous !== current) {
      store.writeStreak(child.slug, taskId, current);
    }
  }
}

/** Recreate a dashboard task from its stored definition; returns the new ID. */
export async function recreate(habitica, entry, row) {
  if (row.task_type === 'daily') {
    return habitica.createDaily(entry, {
      name: row.title,
      notes: row.notes,
      priority: row.difficulty,
      repeat: row.repeat_days ? row.repeat_days.split(',') : [],
    });
  }
  return habitica.createTodo(entry, {
    name: row.title,
    notes: row.notes,
    priority: row.difficulty,
    date: row.due_date,
  });
}
