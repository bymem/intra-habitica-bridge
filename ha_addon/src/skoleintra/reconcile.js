// Reconciliation: works out what has to change in Habitica, without touching it.
//
// Pure and side-effect free so it can be reasoned about against fixtures —
// which matters, because this is the code that decides when a kid's task gets
// touched.
//
// It only classifies: 'add' for homework never seen before, 'update' for a
// tracked item whose text changed. Whether an 'update' becomes an in-place
// edit or a new "(opdateret)" To-Do depends on the mapped task's live
// completion state, which the caller checks — that's a Habitica question, not
// a reconciliation one.

import { createHash } from 'node:crypto';

// Not cryptographic — just a stable fingerprint for "did the teacher edit this".
export function hashContent(text) {
  return createHash('sha256').update(text.trim()).digest('hex');
}

export function itemKey(item) {
  return `${item.date}::${item.subject}`;
}

// Decide what to do this cycle.
//
// previousMap: { "2026-08-17::HISTORIE": { taskId, contentHash, lastKnownStatus } }
// Returns operations for the caller to execute, or a brake explaining why not.
export function reconcile({ items, previousMap = {}, brakeOptions = {} }) {
  const { minChanges = 3, maxChangeRatio = 0.5, enabled = true } = brakeOptions;
  const trackedCount = Object.keys(previousMap).length;

  const operations = [];
  const unchangedKeys = [];
  const seenKeys = new Set();

  for (const item of items) {
    const key = itemKey(item);
    // A teacher listing the same subject twice on one day would otherwise
    // produce two items competing for one key.
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);

    const hash = hashContent(item.homework);
    const known = previousMap[key];

    if (!known) {
      operations.push({ type: 'add', key, item, contentHash: hash });
    } else if (known.contentHash !== hash) {
      operations.push({
        type: 'update',
        key,
        item,
        contentHash: hash,
        taskId: known.taskId,
        oldHash: known.contentHash,
      });
    } else {
      unchangedKeys.push(key);
    }
  }

  // --- Sanity brakes ----------------------------------------------------
  // These guard the one failure mode that silently makes a mess: a scrape or
  // parse regression making every item look edited, which would rewrite the
  // lot — and spawn a duplicate "(opdateret)" To-Do for every completed one.
  if (enabled && trackedCount > 0) {
    if (items.length === 0) {
      return {
        operations: [],
        unchangedKeys: [],
        brake: {
          reason: 'EMPTY_FETCH',
          detail: `Fetch returned no items while ${trackedCount} are tracked — treating as a scrape failure.`,
        },
      };
    }

    const updates = operations.filter((op) => op.type === 'update').length;
    const threshold = Math.max(minChanges, Math.ceil(trackedCount * maxChangeRatio));
    if (updates > threshold) {
      return {
        operations: [],
        unchangedKeys: [],
        brake: {
          reason: 'MASS_CHANGE',
          detail:
            `${updates} of ${trackedCount} tracked items changed at once (threshold ${threshold}) — ` +
            'likely a parser or site change rather than real edits.',
        },
      };
    }
  }

  return { operations, unchangedKeys, brake: null };
}
