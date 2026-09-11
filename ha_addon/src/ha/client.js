/**
 * Home Assistant Core API, reached through the Supervisor proxy.
 *
 * `homeassistant_api: true` in the manifest gets us SUPERVISOR_TOKEN, which
 * the Supervisor injects and rotates — so there is no long-lived token to
 * create or store, and no Habitica credentials of our own either: every
 * Habitica call is an action on HA's own Habitica integration.
 */

const CORE_API = 'http://supervisor/core/api';

export class HomeAssistantClient {
  constructor({ token, baseUrl = CORE_API, dryRun = false, log }) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.dryRun = dryRun;
    this.log = log;
  }

  static fromEnvironment({ dryRun = false, log } = {}) {
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token && !dryRun) {
      throw new Error('SUPERVISOR_TOKEN is not set — not running as a Home Assistant App?');
    }
    return new HomeAssistantClient({ token: token ?? 'dry-run', dryRun, log });
  }

  /** Cheap liveness check; throws if the Core API is unreachable. */
  async ping() {
    await this.#request('GET', '/');
  }

  /**
   * Call an action (service). With `returnResponse` the action's response
   * data is returned — HA wraps it as `{ service_response: ... }` when asked.
   *
   * Writes are skipped on a dry run and logged instead, so a rehearsal shows
   * the exact calls a real run would make without making them.
   */
  async callService(domain, service, data, { returnResponse = false, readOnly = false } = {}) {
    if (this.dryRun && !readOnly) {
      this.log?.info(`DRY RUN  ${domain}.${service}  ${JSON.stringify(data)}`);
      return null;
    }
    const suffix = returnResponse ? '?return_response' : '';
    const body = await this.#request('POST', `/services/${domain}/${service}${suffix}`, data);
    return returnResponse ? body?.service_response ?? null : body;
  }

  /**
   * Events on a calendar entity in [start, end). Direct REST endpoint rather
   * than the calendar.get_events action: no response-variable dance, and it
   * returns each event's uid.
   */
  async calendarEvents(entityId, start, end) {
    const query = `?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
    const events = await this.#request('GET', `/calendars/${encodeURIComponent(entityId)}${query}`);
    return Array.isArray(events) ? events : [];
  }

  /** Fire an event on HA's bus, for automations to trigger on. */
  async fireEvent(eventType, data) {
    if (this.dryRun) {
      this.log?.info(`DRY RUN  event ${eventType}  ${JSON.stringify(data)}`);
      return;
    }
    await this.#request('POST', `/events/${eventType}`, data);
  }

  async #request(method, path, data) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(60000),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Core API ${res.status} on ${method} ${path}: ${text.slice(0, 300)}`);
    }
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Core API returned non-JSON on ${method} ${path}: ${text.slice(0, 200)}`);
    }
  }
}
