# intra-habitica-bridge

Home Assistant App (add-on) bridging SkoleIntra homework and HA calendars into
Habitica tasks per kid, via HA's own Habitica integration actions. Design
lives in `docs/intra-habitica-bridge-spec.md` — read it before changing
behaviour; it records decisions and things confirmed against Habitica/HA.

## Layout

- `repository.yaml` — HA add-on repository manifest.
- `ha_addon/config.yaml` — add-on manifest, options + schema.
- `ha_addon/src/index.js` — entry point, cron wiring.
- `ha_addon/src/config.js` — `/data/options.json` loader; the parsed
  `children` list is the single source of which kids exist.
- `ha_addon/src/db.js` — SQLite (`node:sqlite`, Node 24) state.
- `ha_addon/src/ha/client.js` — Supervisor Core API (actions, calendars, events).
- `ha_addon/src/skoleintra/` — Lektiebog scraper (ported from
  `skoleintra-ha-bridge`) and the pure reconcile step.
- `ha_addon/src/jobs/` — scheduled jobs.

## Conventions

- Node ESM, no build step, minimal dependencies (`node-cron`,
  `node-html-parser`, `skoleintra`).
- Habitica is the source of truth for task content and completion; the
  database only maps scraped items to Habitica task IDs.
- All Habitica calls go through `habitica.*` actions with `config_entry`,
  never Habitica's API directly.
- `--dry-run` must never write to HA or the database.
- Frontend (when added) follows HA's theme like `reolink-nvr-bridge`'s
  `src/web/`.

## Running locally

`cd ha_addon && npm install && npm run dry-run` with an `options.json`
(see `options.example.json`; `data_dir` keeps state local).
