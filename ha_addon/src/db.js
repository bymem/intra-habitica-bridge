import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * SQLite state. Deliberately small — Habitica is the source of truth for task
 * content and completion; this only remembers which Habitica task corresponds
 * to which scraped/calendar-derived item, so updates land in place instead of
 * creating duplicates.
 *
 * Uses Node's built-in SQLite so there is nothing to compile per architecture.
 * Lives in /data, which HA's own backups cover.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skoleintra_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cookie_data TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS homework_task_map (
  id INTEGER PRIMARY KEY,
  child_slug TEXT NOT NULL,
  source_key TEXT NOT NULL,            -- '<date>::<subject>'
  habitica_task_id TEXT NOT NULL,      -- the CURRENT task future updates apply to
  content_hash TEXT NOT NULL,
  last_known_status TEXT NOT NULL,     -- 'needs_action' | 'completed'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(child_slug, source_key)
);

CREATE TABLE IF NOT EXISTS packing_daily_map (
  child_slug TEXT PRIMARY KEY,
  habitica_task_id TEXT NOT NULL,      -- one Daily per kid, checklist replaced nightly
  created_at TEXT,
  updated_at TEXT                      -- last time the checklist actually changed
);

CREATE TABLE IF NOT EXISTS dashboard_managed_tasks (
  id INTEGER PRIMARY KEY,
  child_slug TEXT NOT NULL,
  habitica_task_id TEXT NOT NULL,
  task_type TEXT NOT NULL,             -- 'todo' | 'daily'
  title TEXT NOT NULL,
  notes TEXT,
  due_date TEXT,                       -- set for 'todo'
  repeat_days TEXT,                    -- set for 'daily', e.g. 'm,t,w,th,f'
  difficulty TEXT NOT NULL,
  last_known_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_streak_snapshots (
  child_slug TEXT NOT NULL,
  habitica_task_id TEXT NOT NULL,
  streak_value INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (child_slug, habitica_task_id)
);
`;

export class Store {
  /**
   * @param {string} dataDir  Directory the database file lives in.
   * @param {object} [opts]
   * @param {boolean} [opts.readOnly]  Backs --dry-run: nothing is written, so a
   *   rehearsal can't record fake task IDs that a real run would then trust.
   */
  constructor(dataDir, { readOnly = false } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.readOnly = readOnly;
    this.db = new DatabaseSync(path.join(dataDir, 'bridge.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Columns added after a table first shipped. CREATE TABLE IF NOT EXISTS
   * leaves an existing table alone, so these are applied on top when missing.
   */
  migrate() {
    const columns = this.db
      .prepare('PRAGMA table_info(packing_daily_map)')
      .all()
      .map((column) => column.name);
    for (const column of ['created_at', 'updated_at']) {
      if (!columns.includes(column)) {
        this.db.exec(`ALTER TABLE packing_daily_map ADD COLUMN ${column} TEXT`);
      }
    }
  }

  close() {
    this.db.close();
  }

  // --- SkoleIntra session ---------------------------------------------------

  readCookies() {
    const row = this.db.prepare('SELECT cookie_data FROM skoleintra_session WHERE id = 1').get();
    return row?.cookie_data ?? null;
  }

  writeCookies(cookieData) {
    if (this.readOnly) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO skoleintra_session (id, cookie_data, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET cookie_data = excluded.cookie_data, updated_at = excluded.updated_at`,
      )
      .run(cookieData, new Date().toISOString());
  }

  // --- Homework map ---------------------------------------------------------

  /** Every tracked homework item for one kid, keyed by source_key. */
  readHomeworkMap(childSlug) {
    const rows = this.db
      .prepare('SELECT * FROM homework_task_map WHERE child_slug = ?')
      .all(childSlug);
    return Object.fromEntries(
      rows.map((row) => [
        row.source_key,
        {
          taskId: row.habitica_task_id,
          contentHash: row.content_hash,
          lastKnownStatus: row.last_known_status,
        },
      ]),
    );
  }

  /** Tracked homework dated `fromDate` or later, oldest first, for the dashboard. */
  listHomework(childSlug, fromDate) {
    return this.db
      .prepare(
        `SELECT * FROM homework_task_map
         WHERE child_slug = ? AND substr(source_key, 1, 10) >= ?
         ORDER BY source_key`,
      )
      .all(childSlug, fromDate);
  }

  /** Create or replace the mapping; `updated_at` marks a content change or recreate. */
  upsertHomework(childSlug, sourceKey, { taskId, contentHash, lastKnownStatus }) {
    if (this.readOnly) {
      return;
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO homework_task_map
           (child_slug, source_key, habitica_task_id, content_hash, last_known_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(child_slug, source_key) DO UPDATE SET
           habitica_task_id = excluded.habitica_task_id,
           content_hash = excluded.content_hash,
           last_known_status = excluded.last_known_status,
           updated_at = excluded.updated_at`,
      )
      .run(childSlug, sourceKey, taskId, contentHash, lastKnownStatus, now, now);
  }

  /** Mirror Habitica's completion state. Not an update — the homework itself didn't change. */
  updateHomeworkStatus(childSlug, sourceKey, lastKnownStatus) {
    if (this.readOnly) {
      return;
    }
    this.db
      .prepare('UPDATE homework_task_map SET last_known_status = ? WHERE child_slug = ? AND source_key = ?')
      .run(lastKnownStatus, childSlug, sourceKey);
  }

  // --- Packing Daily --------------------------------------------------------

  readPackingDaily(childSlug) {
    const row = this.db.prepare('SELECT * FROM packing_daily_map WHERE child_slug = ?').get(childSlug);
    return row ?? null;
  }

  /** Map a (re)created packing Daily; both timestamps restart with it. */
  writePackingDaily(childSlug, taskId) {
    if (this.readOnly) {
      return;
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO packing_daily_map (child_slug, habitica_task_id, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(child_slug) DO UPDATE SET
           habitica_task_id = excluded.habitica_task_id,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(childSlug, taskId, now, now);
  }

  /** The checklist changed on this Daily. */
  touchPackingDaily(childSlug) {
    if (this.readOnly) {
      return;
    }
    this.db
      .prepare('UPDATE packing_daily_map SET updated_at = ? WHERE child_slug = ?')
      .run(new Date().toISOString(), childSlug);
  }

  // --- Dashboard-managed tasks ---------------------------------------------

  listManagedTasks(childSlug = null) {
    const sql = 'SELECT * FROM dashboard_managed_tasks' + (childSlug ? ' WHERE child_slug = ?' : '') + ' ORDER BY created_at DESC';
    const stmt = this.db.prepare(sql);
    return childSlug ? stmt.all(childSlug) : stmt.all();
  }

  getManagedTask(id) {
    return this.db.prepare('SELECT * FROM dashboard_managed_tasks WHERE id = ?').get(id) ?? null;
  }

  insertManagedTask({ childSlug, taskId, taskType, title, notes, dueDate, repeatDays, difficulty }) {
    if (this.readOnly) {
      return null;
    }
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO dashboard_managed_tasks
           (child_slug, habitica_task_id, task_type, title, notes, due_date, repeat_days, difficulty,
            last_known_status, created_at, last_verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'needs_action', ?, ?)`,
      )
      .run(childSlug, taskId, taskType, title, notes ?? null, dueDate ?? null, repeatDays ?? null, difficulty, now, now);
    return Number(result.lastInsertRowid);
  }

  updateManagedTask(id, { title, notes, dueDate, repeatDays, difficulty }) {
    if (this.readOnly) {
      return;
    }
    this.db
      .prepare(
        `UPDATE dashboard_managed_tasks
         SET title = ?, notes = ?, due_date = ?, repeat_days = ?, difficulty = ?
         WHERE id = ?`,
      )
      .run(title, notes ?? null, dueDate ?? null, repeatDays ?? null, difficulty, id);
  }

  /** Record the watchdog's verdict: current status, and a new task ID if it was recreated. */
  verifyManagedTask(id, { taskId, lastKnownStatus }) {
    if (this.readOnly) {
      return;
    }
    this.db
      .prepare(
        `UPDATE dashboard_managed_tasks
         SET habitica_task_id = ?, last_known_status = ?, last_verified_at = ?
         WHERE id = ?`,
      )
      .run(taskId, lastKnownStatus, new Date().toISOString(), id);
  }

  deleteManagedTask(id) {
    if (this.readOnly) {
      return;
    }
    this.db.prepare('DELETE FROM dashboard_managed_tasks WHERE id = ?').run(id);
  }

  // --- Streak snapshots -----------------------------------------------------

  readStreak(childSlug, taskId) {
    const row = this.db
      .prepare('SELECT streak_value FROM daily_streak_snapshots WHERE child_slug = ? AND habitica_task_id = ?')
      .get(childSlug, taskId);
    return row ? row.streak_value : null;
  }

  writeStreak(childSlug, taskId, streak) {
    if (this.readOnly) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO daily_streak_snapshots (child_slug, habitica_task_id, streak_value, recorded_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(child_slug, habitica_task_id) DO UPDATE SET
           streak_value = excluded.streak_value, recorded_at = excluded.recorded_at`,
      )
      .run(childSlug, taskId, streak, new Date().toISOString());
  }

  deleteStreak(childSlug, taskId) {
    if (this.readOnly) {
      return;
    }
    this.db
      .prepare('DELETE FROM daily_streak_snapshots WHERE child_slug = ? AND habitica_task_id = ?')
      .run(childSlug, taskId);
  }
}
