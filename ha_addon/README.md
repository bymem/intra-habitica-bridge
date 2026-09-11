# Intra Habitica Bridge

Parent-only Home Assistant App that turns SkoleIntra homework and calendar
packing lists into Habitica tasks, per kid, and gives parents an Ingress
dashboard for manual To-Dos and Dailies. Kids only ever use Habitica's own app.

Full design: `docs/intra-habitica-bridge-spec.md` in the repository root.

## Setup

1. Add each kid's Habitica account in HA: Settings → Devices & services →
   Habitica. Note each config entry ID — that's `habitica_config_entry`.
2. Fill in the Configuration tab: SkoleIntra login, and one `children` entry
   per kid. Leave `skoleintra_child_path` blank to skip homework for a kid,
   `calendar_entity` blank to skip the packing list.
3. Restart the App after any configuration change — the kid list is read once
   at startup.

## Local development

```
cp options.example.json options.json   # then fill in credentials
npm install
npm run dry-run                        # one poll, nothing written
```

`SKOLEINTRA_USERNAME` / `SKOLEINTRA_PASSWORD` / `SKOLEINTRA_BASE_URL` in the
environment override the file. Outside the App, `data_dir` in options.json
points the SQLite state somewhere local.
