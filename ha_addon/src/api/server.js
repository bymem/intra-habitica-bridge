import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recreate } from '../jobs/watchdog.js';

/**
 * Parent dashboard: backend API and static UI host.
 *
 * Served through Home Assistant Ingress, which terminates auth and proxies to
 * this port — nothing here is exposed externally and no login of our own is
 * needed. Ingress mounts the app under a generated path, passed per request in
 * X-Ingress-Path; the page needs that to build its own URLs, so it is injected
 * into the HTML rather than guessed at by the client.
 */

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const PORT = 8099;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const DIFFICULTIES = ['trivial', 'easy', 'medium', 'hard'];
const WEEKDAYS = ['m', 't', 'w', 'th', 'f', 's', 'su'];

export function startServer(deps) {
  const { log } = deps;
  const server = http.createServer((req, res) => {
    handle(req, res, deps).catch((error) => {
      log.error(`${req.method} ${req.url} failed: ${error.message}`);
      sendJson(res, 500, { error: error.message });
    });
  });
  server.listen(PORT, () => {
    log.info(`dashboard listening on port ${PORT}`);
  });
  return server;
}

async function handle(req, res, { config, store, habitica }) {
  // Ingress rewrites the path prefix; strip it so routing sees a stable URL.
  const ingressPath = req.headers['x-ingress-path'] ?? '';
  const url = new URL(req.url, 'http://localhost');
  const route = ingressPath && url.pathname.startsWith(ingressPath)
    ? url.pathname.slice(ingressPath.length) || '/'
    : url.pathname;

  if (route === '/api/children' && req.method === 'GET') {
    return sendJson(
      res,
      200,
      config.children.map((child) => ({ slug: child.slug, name: child.name })),
    );
  }

  if (route === '/api/tasks' && req.method === 'GET') {
    const child = childFor(config, url.searchParams.get('child'));
    if (!child) {
      return sendJson(res, 404, { error: 'unknown child' });
    }
    return sendJson(res, 200, await listTasks(child, store, habitica));
  }

  if (route === '/api/tasks' && req.method === 'POST') {
    const body = await readJson(req);
    const child = childFor(config, body.child);
    if (!child) {
      return sendJson(res, 400, { error: 'unknown child' });
    }
    const problem = validateTask(body);
    if (problem) {
      return sendJson(res, 400, { error: problem });
    }
    const row = {
      task_type: body.type,
      title: body.title.trim(),
      notes: body.notes?.trim() || null,
      difficulty: body.difficulty,
      due_date: body.type === 'todo' ? body.dueDate || null : null,
      repeat_days: body.type === 'daily' ? body.repeatDays.join(',') : null,
    };
    const taskId = await recreate(habitica, child.habitica_config_entry, row);
    if (!taskId) {
      return sendJson(res, 502, { error: 'Habitica did not return a task ID' });
    }
    const id = store.insertManagedTask({
      childSlug: child.slug,
      taskId,
      taskType: row.task_type,
      title: row.title,
      notes: row.notes,
      dueDate: row.due_date,
      repeatDays: row.repeat_days,
      difficulty: row.difficulty,
    });
    return sendJson(res, 201, { id, taskId });
  }

  // Edit a dashboard task: Habitica first, then the stored definition so a
  // later recreate uses the new one. Type and kid are fixed.
  const edit = /^\/api\/tasks\/(\d+)$/.exec(route);
  if (edit && req.method === 'PUT') {
    const row = store.getManagedTask(Number(edit[1]));
    if (!row) {
      return sendJson(res, 404, { error: 'not found' });
    }
    const child = childFor(config, row.child_slug);
    const body = await readJson(req);
    const problem = validateTask({ ...body, type: row.task_type });
    if (problem) {
      return sendJson(res, 400, { error: problem });
    }
    const title = body.title.trim();
    const notes = body.notes?.trim() || null;
    const fields = { rename: title, notes: notes ?? '', priority: body.difficulty };
    let dueDate = null;
    let repeatDays = null;
    if (row.task_type === 'todo') {
      dueDate = body.dueDate || null;
      if (dueDate) {
        fields.date = dueDate;
      } else {
        fields.clear_date = true;
      }
      await habitica.updateTodo(child.habitica_config_entry, row.habitica_task_id, fields);
    } else {
      repeatDays = body.repeatDays.join(',');
      await habitica.updateDaily(child.habitica_config_entry, row.habitica_task_id, {
        ...fields,
        frequency: 'weekly',
        repeat: body.repeatDays,
      });
    }
    store.updateManagedTask(row.id, { title, notes, dueDate, repeatDays, difficulty: body.difficulty });
    return sendJson(res, 200, { ok: true });
  }

  // Pause (every_x: 0) or resume a Daily without losing its history/streak.
  if (route === '/api/tasks/pause' && req.method === 'POST') {
    const body = await readJson(req);
    const child = childFor(config, body.child);
    if (!child || typeof body.taskId !== 'string') {
      return sendJson(res, 400, { error: 'child and taskId are required' });
    }
    await habitica.updateDaily(child.habitica_config_entry, body.taskId, { every_x: body.paused ? 0 : 1 });
    return sendJson(res, 200, { ok: true });
  }

  // Stop tracking a dashboard task: the watchdog stops recreating it, and it
  // is left in Habitica as-is for the parent to finish or delete there.
  const untrack = /^\/api\/tasks\/(\d+)$/.exec(route);
  if (untrack && req.method === 'DELETE') {
    if (!store.getManagedTask(Number(untrack[1]))) {
      return sendJson(res, 404, { error: 'not found' });
    }
    store.deleteManagedTask(Number(untrack[1]));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  return serveStatic(route, ingressPath, res);
}

/**
 * The kid's dashboard-managed tasks plus the packing Daily, merged with what
 * Habitica currently says about each (done, streak, paused, still exists).
 */
async function listTasks(child, store, habitica) {
  const live = await habitica.getTasks(child.habitica_config_entry, ['todo', 'daily']);
  const tasks = store.listManagedTasks(child.slug).map((row) => ({
    id: row.id,
    taskId: row.habitica_task_id,
    source: 'dashboard',
    type: row.task_type,
    title: row.title,
    notes: row.notes,
    dueDate: row.due_date,
    repeatDays: row.repeat_days ? row.repeat_days.split(',') : [],
    difficulty: row.difficulty,
    ...liveState(live.get(row.habitica_task_id)),
  }));

  const packingId = store.readPackingDaily(child.slug);
  if (packingId) {
    const task = live.get(packingId);
    tasks.push({
      id: null,
      taskId: packingId,
      source: 'packing',
      type: 'daily',
      title: task?.text ?? 'Pakkeliste',
      notes: null,
      dueDate: null,
      repeatDays: [],
      difficulty: child.packing_difficulty,
      ...liveState(task),
    });
  }
  return { tasks };
}

function liveState(task) {
  if (!task) {
    return { exists: false, completed: false, streak: null, paused: false };
  }
  return {
    exists: true,
    completed: Boolean(task.completed),
    streak: task.streak ?? null,
    paused: task.everyX === 0,
  };
}

function validateTask(body) {
  if (!['todo', 'daily'].includes(body.type)) {
    return 'type must be todo or daily';
  }
  if (typeof body.title !== 'string' || !body.title.trim()) {
    return 'title is required';
  }
  if (!DIFFICULTIES.includes(body.difficulty)) {
    return `difficulty must be one of ${DIFFICULTIES.join(', ')}`;
  }
  if (body.type === 'todo' && body.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)) {
    return 'dueDate must be YYYY-MM-DD';
  }
  if (body.type === 'daily') {
    if (!Array.isArray(body.repeatDays) || body.repeatDays.length === 0) {
      return 'pick at least one weekday';
    }
    if (body.repeatDays.some((day) => !WEEKDAYS.includes(day))) {
      return 'unknown weekday';
    }
  }
  return null;
}

function childFor(config, slug) {
  return config.children.find((child) => child.slug === slug) ?? null;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) {
      throw new Error('request body too large');
    }
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error('invalid JSON body');
  }
}

async function serveStatic(route, ingressPath, res) {
  const requested = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
  // Resolve and confirm containment rather than trusting the request path.
  const filePath = path.resolve(WEB_ROOT, requested);
  if (!filePath.startsWith(path.resolve(WEB_ROOT))) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  let body;
  try {
    body = await readFile(filePath);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }

  const type = CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
  if (filePath.endsWith('index.html')) {
    // The page cannot know its own Ingress prefix, so hand it over.
    body = Buffer.from(body.toString('utf8').replace('__BASE_PATH__', ingressPath));
  }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
