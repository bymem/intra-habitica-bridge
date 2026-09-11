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
 *
 * Rate limit: Habitica allows 30 requests per minute per user, and each write
 * action costs four of them (the integration refreshes user + tasks +
 * completed To-Dos before creating/updating). Writes are therefore paced per
 * account, and a write that still hits the limit — HA answers with a bare
 * 500 — waits out one window and retries once. Reads come from HA's cache
 * and cost nothing.
 */

const WRITE_SPACING_MS = 12000;
const RATE_WINDOW_MS = 65000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HabiticaClient {
  constructor(ha, log) {
    this.ha = ha;
    this.log = log;
    // Per config entry: the promise chain that serialises writes, and when
    // the last one was sent.
    this.queues = new Map();
  }

  /** Run a write action for one account, paced and retried as described above. */
  async #write(configEntry, service, data, options) {
    if (this.ha.dryRun) {
      // Nothing is sent, so there is nothing to pace.
      return this.#send(service, data, options);
    }
    const queue = this.queues.get(configEntry) ?? { chain: Promise.resolve(), lastAt: 0 };
    this.queues.set(configEntry, queue);

    const run = async () => {
      const wait = queue.lastAt + WRITE_SPACING_MS - Date.now();
      if (wait > 0) {
        await sleep(wait);
      }
      try {
        return await this.#send(service, data, options);
      } catch (error) {
        if (!/Core API 500/.test(error.message)) {
          throw error;
        }
        this.log?.warn(`${service} hit Habitica's rate limit — retrying in ${RATE_WINDOW_MS / 1000}s`);
        await sleep(RATE_WINDOW_MS);
        return this.#send(service, data, options);
      } finally {
        queue.lastAt = Date.now();
      }
    };

    // Chain behind whatever write is in flight for this account; a failure
    // there must not poison the chain for the next caller.
    const result = queue.chain.then(run, run);
    queue.chain = result.catch(() => {});
    return result;
  }

  #send(service, data, options) {
    return this.ha.callService('habitica', service, data, options);
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
    const created = await this.#write(configEntry, 'create_todo', data, { returnResponse: true });
    return created?.id ? String(created.id) : null;
  }

  /** Update fields on an existing To-Do; `fields` uses the action's own names. */
  async updateTodo(configEntry, taskId, fields) {
    await this.#write(configEntry, 'update_todo', { config_entry: configEntry, task: taskId, ...fields });
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
    const created = await this.#write(configEntry, 'create_daily', data, { returnResponse: true });
    return created?.id ? String(created.id) : null;
  }

  /** Update fields on an existing Daily; `fields` uses the action's own names. */
  async updateDaily(configEntry, taskId, fields) {
    await this.#write(configEntry, 'update_daily', { config_entry: configEntry, task: taskId, ...fields });
  }
}
