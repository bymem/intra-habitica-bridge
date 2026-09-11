// Homework poll: SkoleIntra Lektiebog -> reconcile -> Habitica To-Dos.
//
// One SkoleIntraClient (one login, one cookie jar) serves every kid in a
// cycle; cookies are persisted once at the end.
//
// Habitica is the source of truth for completion. A teacher edit to homework
// the kid already finished never touches the finished task — its reward is
// earned and stays earned — a new, clearly labelled To-Do is created instead.

import { SkoleIntraClient, dropPastItems } from '../skoleintra/scraper.js';
import { reconcile } from '../skoleintra/reconcile.js';

const UPDATED_SUFFIX = ' (opdateret)';

export async function runHomeworkPoll({ config, store, habitica, log }) {
  const children = config.children.filter((child) => child.skoleintra_child_path);
  if (children.length === 0) {
    log.info('no kids have skoleintra_child_path set — homework poll skipped');
    return;
  }

  const skoleintra = new SkoleIntraClient({
    baseUrl: config.skoleintra.base_url,
    username: config.skoleintra.username,
    password: config.skoleintra.password,
    session: store,
  });

  try {
    await skoleintra.restoreSession();
    for (const child of children) {
      try {
        await pollChild({ child, config, skoleintra, store, habitica, log: log.child(child.slug) });
      } catch (error) {
        // One kid's failure must not abandon the other's poll.
        log.error(`${child.slug}: poll failed: ${error.message}`);
      }
    }
    await skoleintra.persistSession();
  } catch (error) {
    log.error(`poll failed: ${error.message}`);
  }
}

async function pollChild({ child, config, skoleintra, store, habitica, log }) {
  const childPath = child.skoleintra_child_path;
  const diaryId = await skoleintra.discoverDiaryId(childPath);
  if (!diaryId) {
    throw new Error('no Lektiebog diary found');
  }

  const { items: fetched, datesSeen } = await skoleintra.fetchHomework(childPath, diaryId);

  // The notes listing covers a period around today, past days included.
  const items = dropPastItems(fetched);
  const skipped = fetched.length - items.length;
  log.info(
    `diary ${diaryId}: ${items.length} current item(s) across ${datesSeen.length} day(s)` +
      (skipped ? `, ${skipped} past-dated item(s) skipped` : ''),
  );

  // Distinguish "everything fetched is in the past" from "the fetch returned
  // nothing". Only the latter is a scrape failure; letting the first case reach
  // the reconciler would trip the EMPTY_FETCH brake every poll over a holiday.
  if (items.length === 0 && fetched.length > 0) {
    log.info('all fetched homework is past-dated — nothing current to sync');
    return;
  }

  const previousMap = store.readHomeworkMap(child.slug);
  const { operations, unchangedKeys, brake } = reconcile({
    items,
    previousMap,
    brakeOptions: {
      enabled: config.sanity_brake.enabled,
      minChanges: config.sanity_brake.min_changes,
      maxChangeRatio: config.sanity_brake.max_change_ratio,
    },
  });

  if (brake) {
    log.error(`SANITY_BRAKE ${brake.reason}: ${brake.detail}`);
    return;
  }

  // One read of the kid's To-Dos serves every decision below: the live
  // finished-or-not check for edits, the existence check behind
  // recreate-on-delete, and the last_known_status refresh.
  const todos = await habitica.getTasks(child.habitica_config_entry, ['todo']);
  const entry = child.habitica_config_entry;

  for (const [key, known] of Object.entries(previousMap)) {
    const task = todos.get(known.taskId);
    if (task) {
      const status = task.completed ? 'completed' : 'needs_action';
      if (status !== known.lastKnownStatus) {
        store.updateHomeworkStatus(child.slug, key, status);
        known.lastKnownStatus = status;
      }
    }
  }

  // Unchanged homework whose To-Do was deleted while still open: recreate it
  // from what was just scraped, exactly like a brand-new assignment.
  for (const key of unchangedKeys) {
    const known = previousMap[key];
    if (todos.has(known.taskId) || known.lastKnownStatus !== 'needs_action') {
      continue;
    }
    const item = items.find((candidate) => `${candidate.date}::${candidate.subject}` === key);
    operations.push({ type: 'add', key, item, contentHash: known.contentHash, recreated: true });
  }

  if (operations.length === 0) {
    log.info(`nothing to do (${unchangedKeys.length} unchanged)`);
    return;
  }

  let applied = 0;
  for (const op of operations) {
    try {
      if (op.type === 'add') {
        const taskId = await habitica.createTodo(entry, {
          name: op.item.subject,
          notes: op.item.homework,
          priority: child.homework_difficulty,
          date: op.item.date,
        });
        log.info(`${op.recreated ? 'RECREATED' : 'ADDED'}  ${op.key}  hash=${op.contentHash.slice(0, 8)}  task=${taskId}`);
        if (taskId) {
          store.upsertHomework(child.slug, op.key, { taskId, contentHash: op.contentHash, lastKnownStatus: 'needs_action' });
        }
      } else {
        const known = previousMap[op.key];
        const task = todos.get(op.taskId);
        // Missing + completed means it aged out of Habitica's completed list,
        // not that it was deleted — treat it as finished, same as a live one.
        const finished = task ? task.completed : known.lastKnownStatus === 'completed';

        if (task && !finished) {
          await habitica.updateTodo(entry, op.taskId, { notes: op.item.homework });
          log.info(`UPDATED  ${op.key}  ${op.oldHash.slice(0, 8)} -> ${op.contentHash.slice(0, 8)}`);
          store.upsertHomework(child.slug, op.key, {
            taskId: op.taskId,
            contentHash: op.contentHash,
            lastKnownStatus: 'needs_action',
          });
        } else {
          // Finished: leave it frozen and spawn a labelled follow-up with the
          // full current text. Deleted while open: recreate as a fresh one.
          const name = finished ? `${op.item.subject}${UPDATED_SUFFIX}` : op.item.subject;
          const taskId = await habitica.createTodo(entry, {
            name,
            notes: op.item.homework,
            priority: child.homework_difficulty,
            date: op.item.date,
          });
          log.info(`${finished ? 'SPAWNED' : 'RECREATED'}  ${op.key}  hash=${op.contentHash.slice(0, 8)}  task=${taskId}`);
          if (taskId) {
            store.upsertHomework(child.slug, op.key, { taskId, contentHash: op.contentHash, lastKnownStatus: 'needs_action' });
          }
        }
      }
      applied += 1;
    } catch (error) {
      // One failed item must not abandon the rest of the cycle; the map is left
      // untouched for this key so the next poll retries it.
      log.error(`OP_FAILED  ${op.key}  ${error.message}`);
    }
  }
  log.info(`${applied}/${operations.length} operation(s) applied, ${unchangedKeys.length} unchanged`);
}
