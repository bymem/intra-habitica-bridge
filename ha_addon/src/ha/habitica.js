/**
 * Habitica, through Home Assistant's own Habitica integration actions.
 *
 * Every call is scoped to a config entry — one per kid's Habitica account,
 * set up in HA itself — so this app holds no Habitica credentials. Priority
 * strings (trivial/easy/medium/hard) are passed straight through: the action
 * schema uses the same names as this app's config.
 *
 * `get_tasks` serves the integration's cached data (refreshed every 30 s);
 * create/update actions force a refresh first. Completed To-Dos come from
 * Habitica's last-30 list, so an old completed To-Do eventually vanishes from
 * the response while still existing — callers decide what "missing" means
 * with that in mind.
 */

export class HabiticaClient {
  constructor(ha) {
    this.ha = ha;
  }

  /**
   * Tasks of the given types for one account, keyed by task ID. Each value is
   * the raw task as HA returns it (id, text, notes, completed, streak,
   * checklist, everyX, ...).
   */
  async getTasks(configEntry, types) {
    const response = await this.ha.callService(
      'habitica',
      'get_tasks',
      { config_entry: configEntry, type: types },
      { returnResponse: true, readOnly: true },
    );
    const tasks = new Map();
    for (const task of response?.tasks ?? []) {
      tasks.set(String(task.id), task);
    }
    return tasks;
  }

  /** Create a To-Do; returns the new task's ID (null on a dry run). */
  async createTodo(configEntry, { name, notes, priority, date }) {
    const data = { config_entry: configEntry, name, priority };
    if (notes) {
      data.notes = notes;
    }
    if (date) {
      data.date = date;
    }
    const created = await this.ha.callService('habitica', 'create_todo', data, { returnResponse: true });
    return created?.id ? String(created.id) : null;
  }

  /** Update fields on an existing To-Do; `fields` uses the action's own names. */
  async updateTodo(configEntry, taskId, fields) {
    await this.ha.callService('habitica', 'update_todo', { config_entry: configEntry, task: taskId, ...fields });
  }

  /**
   * Create a Daily; returns the new task's ID (null on a dry run).
   * `repeat` is a list of HA's weekday codes: m, t, w, th, f, s, su.
   */
  async createDaily(configEntry, { name, notes, priority, repeat, checklist }) {
    const data = { config_entry: configEntry, name, priority, frequency: 'weekly', every_x: 1 };
    if (notes) {
      data.notes = notes;
    }
    if (repeat?.length) {
      data.repeat = repeat;
    }
    if (checklist?.length) {
      data.add_checklist_item = checklist;
    }
    const created = await this.ha.callService('habitica', 'create_daily', data, { returnResponse: true });
    return created?.id ? String(created.id) : null;
  }

  /** Update fields on an existing Daily; `fields` uses the action's own names. */
  async updateDaily(configEntry, taskId, fields) {
    await this.ha.callService('habitica', 'update_daily', { config_entry: configEntry, task: taskId, ...fields });
  }
}
