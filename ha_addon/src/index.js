// Entry point: loads config, opens state, schedules the jobs.
//
// Run modes:
//   node src/index.js              scheduled, per poll_cron
//   node src/index.js --once       one homework poll, then exit
//   node src/index.js --dry-run    one poll with no writes to HA or the database

import cron from 'node-cron';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { createLogger, setLogLevel } from './log.js';
import { HomeAssistantClient } from './ha/client.js';
import { runHomeworkPoll } from './jobs/homework.js';

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

const jobs = { config, store, ha, log: log.child('homework') };

if (runOnce) {
  await runHomeworkPoll(jobs);
  store.close();
} else {
  log.info(`homework poll scheduled: ${config.poll_cron}`);
  cron.schedule(config.poll_cron, () => runHomeworkPoll(jobs));
  await runHomeworkPoll(jobs);

  const shutdown = () => {
    log.info('shutting down');
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
