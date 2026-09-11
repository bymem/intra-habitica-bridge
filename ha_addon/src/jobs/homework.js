// Homework poll: SkoleIntra Lektiebog -> reconcile -> Habitica To-Dos.
//
// One SkoleIntraClient (one login, one cookie jar) serves every kid in a
// cycle; cookies are persisted once at the end.

import { SkoleIntraClient, dropPastItems } from '../skoleintra/scraper.js';
import { reconcile } from '../skoleintra/reconcile.js';

export async function runHomeworkPoll({ config, store, ha, log }) {
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
        await pollChild({ child, config, skoleintra, store, ha, log: log.child(child.slug) });
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

async function pollChild({ child, config, skoleintra, store, ha, log }) {
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
  if (operations.length === 0) {
    log.info(`nothing to do (${unchangedKeys.length} unchanged)`);
    return;
  }

  for (const op of operations) {
    log.info(`${op.type.toUpperCase()}  ${op.key}  hash=${op.contentHash.slice(0, 8)}`);
    log.debug(op.item.homework);
  }
  // Applying operations against Habitica lands in the next step; the
  // reconciler's verdict is logged so a dry run shows what it would do.
  void ha;
}
