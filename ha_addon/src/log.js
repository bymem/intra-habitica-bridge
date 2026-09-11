/**
 * Minimal leveled logger. Writes to stdout so the Supervisor add-on log
 * picks it up without any extra plumbing.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel = LEVELS.info;

/** Set the active log level. Unknown names fall back to "info". */
export function setLogLevel(name) {
  currentLevel = LEVELS[name] ?? LEVELS.info;
}

function emit(level, prefix, args) {
  if (LEVELS[level] > currentLevel) {
    return;
  }
  const stamp = new Date().toISOString();
  console.log(`${stamp} [${level.toUpperCase()}]${prefix} ${args.join(' ')}`);
}

/**
 * Create a logger. An optional scope (e.g. a kid slug or job name) is printed with
 * every line so per-kid work stays readable in a single log stream.
 */
export function createLogger(scope = '') {
  const prefix = scope ? ` [${scope}]` : '';
  return {
    error: (...a) => emit('error', prefix, a),
    warn: (...a) => emit('warn', prefix, a),
    info: (...a) => emit('info', prefix, a),
    debug: (...a) => emit('debug', prefix, a),
    /** Derive a child logger with a narrower scope. */
    child: (childScope) => createLogger(scope ? `${scope}/${childScope}` : childScope),
  };
}
