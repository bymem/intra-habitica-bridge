// Entry point: loads config, opens state, starts the dashboard and the jobs.
//
// Run modes:
//   node src/index.js              scheduled jobs + dashboard
//   node src/index.js --once       one homework poll, then exit
//   node src/index.js --dry-run    one poll with no writes to HA or the database

import cron from 'node-cron';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { createLogger, setLogLevel } from './log.js';
import { HomeAssistantClient } from './ha/client.js';
import { HabiticaClient } from './ha/habitica.js';
import { runHomeworkPoll } from './jobs/homework.js';
import { runPackingSync } from './jobs/packing.js';
import { runWatchdog } from './jobs/watchdog.js';
import { startServer } from './api/server.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const runOnce = args.includes('--once') || dryRun;

const log = createLogger();

let config;
try {
  config = loadConfig();
} catch (error) {
  // A stack trace here tells the reader nothing — the cause is always
  // configuration, and this runs in an App log where it just adds noise.
  log.error(`Cannot start: ${error.message}`);
  process.exit(1);
}
setLogLevel(config.log_level);

log.info(`intra-habitica-bridge ${process.env.ADDON_VERSION ?? 'dev'} — config from ${config.sourcePath}`);
log.info(`children: ${config.children.map((c) => `${c.name} (${c.slug})`).join(', ')}`);
if (dryRun) {
  log.info('DRY RUN — nothing will be written to Home Assistant or the database');
}

const store = new Store(config.data_dir, { readOnly: dryRun });
const ha = HomeAssistantClient.fromEnvironment({ dryRun, log });
const habitica = new HabiticaClient(ha);
const deps = { config, store, ha, habitica };

// Jobs never throw — each logs its own failures — so a scheduled run can't
// take the process down.
const homework = () => runHomeworkPoll({ ...deps, log: log.child('homework') });
const packing = () => runPackingSync({ ...deps, log: log.child('packing') });
const watchdog = () => runWatchdog({ ...deps, log: log.child('watchdog') });

if (runOnce) {
  await homework();
  store.close();
} else {
  startServer({ ...deps, log: log.child('dashboard') });

  for (const [name, expression, job] of [
    ['homework poll', config.poll_cron, homework],
    ['packing sync', config.packing_cron, packing],
    ['watchdog', config.watchdog_cron, watchdog],
  ]) {
    if (!cron.validate(expression)) {
      log.error(`invalid cron expression for ${name}: "${expression}" — job not scheduled`);
      continue;
    }
    log.info(`${name} scheduled: ${expression}`);
    cron.schedule(expression, job);
  }

  // A startup pass so a fresh install shows results immediately rather than
  // at the next scheduled time.
  await homework();
  await watchdog();

  const shutdown = () => {
    log.info('shutting down');
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
