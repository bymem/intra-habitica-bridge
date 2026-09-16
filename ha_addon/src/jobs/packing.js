// Packing list: tomorrow's calendar events -> one Habitica Daily per kid, with
// the event descriptions as its checklist.
//
// The checklist is "what's needed tomorrow", not something with edit history
// worth keeping, so it's replaced wholesale every night. The Daily itself only
// repeats Sunday–Thursday: Friday and Saturday nights have no school morning
// to pack for.

const PACKING_TITLE = 'Pakkeliste';
const PACKING_NOTES = 'Pak tasken til i morgen.';
// HA's weekday codes for the Daily's weekly repeat.
const SCHOOL_NIGHTS = ['su', 'm', 't', 'w', 'th'];

export async function runPackingSync({ config, store, ha, habitica, log }) {
  const children = config.children.filter((child) => child.calendar_entity);
  if (children.length === 0) {
    log.info('no kids have calendar_entity set — packing sync skipped');
    return;
  }

  for (const child of children) {
    try {
      await syncChild({ child, store, ha, habitica, log: log.child(child.slug) });
    } catch (error) {
      log.error(`${child.slug}: packing sync failed: ${error.message}`);
    }
  }
}

/** Tomorrow's checklist for a kid: description lines across all events, deduped. */
export async function packingItemsFor(child, ha) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const events = await ha.calendarEvents(child.calendar_entity, start, end);
  const items = [];
  for (const event of events) {
    for (const line of (event.description ?? '').split('\n')) {
      const item = line.trim();
      if (item && !items.includes(item)) {
        items.push(item);
      }
    }
  }
  return { items, eventCount: events.length };
}

async function syncChild({ child, store, ha, habitica, log }) {
  const { items, eventCount } = await packingItemsFor(child, ha);
  log.info(`${eventCount} event(s) tomorrow, ${items.length} checklist item(s)`);

  const entry = child.habitica_config_entry;
  const dailies = await habitica.getTasks(entry, ['daily']);
  const mappedId = store.readPackingDaily(child.slug)?.habitica_task_id ?? null;
  const existing = mappedId ? dailies.get(mappedId) : null;

  // No Daily yet, or the mapped one was deleted: create fresh, same as the
  // first time — the calendar is re-read every night anyway.
  if (!existing) {
    const taskId = await habitica.createDaily(entry, {
      name: PACKING_TITLE,
      notes: PACKING_NOTES,
      priority: child.packing_difficulty,
      repeat: SCHOOL_NIGHTS,
      checklist: items,
    });
    log.info(`${mappedId ? 'RECREATED' : 'CREATED'} packing Daily task=${taskId}`);
    if (taskId) {
      store.writePackingDaily(child.slug, taskId);
    }
    return;
  }

  // Replace the checklist: add what's new, remove what's stale, one call.
  // Removal is by item text, which is why the current list is read first.
  const current = (existing.checklist ?? []).map((item) => item.text);
  const add = items.filter((item) => !current.includes(item));
  const remove = current.filter((item) => !items.includes(item));
  if (add.length === 0 && remove.length === 0) {
    log.info('checklist unchanged');
    return;
  }
  const fields = {};
  if (add.length) {
    fields.add_checklist_item = add;
  }
  if (remove.length) {
    fields.remove_checklist_item = remove;
  }
  await habitica.updateDaily(entry, mappedId, fields);
  store.touchPackingDaily(child.slug);
  log.info(`checklist updated: +${add.length} -${remove.length}`);
}
