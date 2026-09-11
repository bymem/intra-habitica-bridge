// Configuration loading.
//
// Inside an HA App the Supervisor writes the saved options to /data/options.json
// whenever the config form is submitted, so there is nothing to parse from the
// shell. Locally, a hand-written ha_addon/options.json stands in for it.
//
// The parsed `children` list is the single source of "which kids exist": the
// SkoleIntra poller, the calendar sync and the dashboard's kid-picker all read
// this one in-memory list. Changing it means restarting the App.

import { existsSync, readFileSync } from 'node:fs';

const DEFAULTS = {
  poll_cron: '0 6,13,17 * * 1-5',
  packing_cron: '0 1 * * *',
  watchdog_cron: '15 * * * *',
  log_level: 'info',
  data_dir: '/data',
  sanity_brake: {
    enabled: true,
    min_changes: 3,
    max_change_ratio: 0.5,
  },
};

const DIFFICULTIES = ['trivial', 'easy', 'medium', 'hard'];

export function loadConfig({ env = process.env, explicitPath } = {}) {
  const candidates = [
    explicitPath,
    env.OPTIONS_FILE,
    '/data/options.json',
    new URL('../options.json', import.meta.url).pathname,
  ].filter(Boolean);

  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error(`No options file found. Looked in: ${candidates.join(', ')}`);
  }

  const options = JSON.parse(readFileSync(path, 'utf8'));
  const config = {
    ...DEFAULTS,
    ...options,
    sanity_brake: { ...DEFAULTS.sanity_brake, ...(options.sanity_brake ?? {}) },
    skoleintra: {
      // Env wins so local runs don't need credentials written to disk.
      base_url: env.SKOLEINTRA_BASE_URL || options.skoleintra?.base_url,
      username: env.SKOLEINTRA_USERNAME || options.skoleintra?.username,
      password: env.SKOLEINTRA_PASSWORD || options.skoleintra?.password,
    },
    sourcePath: path,
  };

  const missing = ['base_url', 'username', 'password'].filter((key) => !config.skoleintra[key]);
  if (missing.length) {
    throw new Error(`Missing required skoleintra config: ${missing.join(', ')}`);
  }
  if (!Array.isArray(config.children) || config.children.length === 0) {
    throw new Error('Config must define at least one child.');
  }

  const slugs = new Set();
  for (const child of config.children) {
    for (const key of ['slug', 'name', 'habitica_config_entry']) {
      if (!child[key]) {
        throw new Error(`Child ${child.slug ?? '(unnamed)'} is missing "${key}".`);
      }
    }
    if (slugs.has(child.slug)) {
      throw new Error(`Duplicate child slug "${child.slug}".`);
    }
    slugs.add(child.slug);

    // The two automatic builders are opt-in per kid: a blank value means
    // "don't run this one for them", never an error.
    child.skoleintra_child_path = child.skoleintra_child_path || null;
    child.calendar_entity = child.calendar_entity || null;
    child.homework_difficulty = child.homework_difficulty || 'medium';
    child.packing_difficulty = child.packing_difficulty || 'trivial';
    for (const key of ['homework_difficulty', 'packing_difficulty']) {
      if (!DIFFICULTIES.includes(child[key])) {
        throw new Error(`Child ${child.slug}: "${key}" must be one of ${DIFFICULTIES.join(', ')}.`);
      }
    }
  }

  return config;
}
