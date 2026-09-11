// Parent dashboard: pick a kid, create a To-Do or Daily, manage tracked tasks.

import { followHomeAssistantTheme } from './theme.js';

const base = window.BASE_PATH || '';
const api = (path) => `${base}/api/${path}`;

const DAY_LABELS = { m: 'Mon', t: 'Tue', w: 'Wed', th: 'Thu', f: 'Fri', s: 'Sat', su: 'Sun' };

const el = {
  children: document.getElementById('children'),
  status: document.getElementById('status'),
  form: document.getElementById('create-form'),
  typeButtons: [...document.querySelectorAll('.type-toggle .type')],
  title: document.getElementById('title'),
  notes: document.getElementById('notes'),
  difficulty: document.getElementById('difficulty'),
  dueField: document.getElementById('due-field'),
  dueDate: document.getElementById('due-date'),
  daysField: document.getElementById('days-field'),
  submit: document.getElementById('submit'),
  formError: document.getElementById('form-error'),
  taskList: document.getElementById('task-list'),
};

const state = { children: [], child: null, type: 'todo' };

async function request(path, options = {}) {
  const response = await fetch(api(path), {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  return body;
}

// --- Kids ------------------------------------------------------------------

function renderChildren() {
  el.children.replaceChildren(
    ...state.children.map((child) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = child.name;
      button.classList.toggle('on', child.slug === state.child);
      button.addEventListener('click', () => selectChild(child.slug));
      return button;
    }),
  );
}

async function selectChild(slug) {
  state.child = slug;
  try {
    localStorage.setItem('habitica-child', slug);
  } catch {
    // Remembering the pick is a convenience only.
  }
  renderChildren();
  await loadTasks();
}

// --- Create form -----------------------------------------------------------

function setType(type) {
  state.type = type;
  for (const button of el.typeButtons) {
    button.classList.toggle('on', button.dataset.type === type);
  }
  el.dueField.hidden = type !== 'todo';
  el.daysField.hidden = type !== 'daily';
}

function selectedDays() {
  return [...el.daysField.querySelectorAll('input:checked')].map((input) => input.value);
}

el.typeButtons.forEach((button) => button.addEventListener('click', () => setType(button.dataset.type)));

el.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.formError.textContent = '';
  el.submit.disabled = true;
  try {
    await request('tasks', {
      method: 'POST',
      body: {
        child: state.child,
        type: state.type,
        title: el.title.value,
        notes: el.notes.value,
        difficulty: el.difficulty.value,
        dueDate: el.dueDate.value,
        repeatDays: selectedDays(),
      },
    });
    el.title.value = '';
    el.notes.value = '';
    el.dueDate.value = '';
    await loadTasks();
  } catch (error) {
    el.formError.textContent = error.message;
  } finally {
    el.submit.disabled = false;
  }
});

// --- Task list -------------------------------------------------------------

async function loadTasks() {
  el.status.textContent = 'Loading…';
  try {
    const { tasks } = await request(`tasks?child=${encodeURIComponent(state.child)}`);
    renderTasks(tasks);
    el.status.textContent = '';
  } catch (error) {
    el.status.textContent = error.message;
  }
}

function renderTasks(tasks) {
  if (tasks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nothing tracked for this kid yet.';
    el.taskList.replaceChildren(empty);
    return;
  }
  el.taskList.replaceChildren(...tasks.map(renderTask));
}

function renderTask(task) {
  const item = document.createElement('div');
  item.className = 'task';
  item.classList.toggle('done', task.completed);
  item.classList.toggle('paused', task.paused);
  item.classList.toggle('missing', !task.exists);

  const title = document.createElement('div');
  title.className = 'title';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = task.source === 'packing' ? 'packing' : task.type;
  title.append(badge, task.title);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = describe(task);

  const buttons = document.createElement('div');
  buttons.className = 'buttons';

  if (task.type === 'daily' && task.exists) {
    const pause = document.createElement('button');
    pause.type = 'button';
    pause.textContent = task.paused ? 'Resume' : 'Pause';
    pause.addEventListener('click', () => act(pause, () =>
      request('tasks/pause', { method: 'POST', body: { child: state.child, taskId: task.taskId, paused: !task.paused } })));
    buttons.append(pause);
  }

  if (task.source === 'dashboard') {
    const untrack = document.createElement('button');
    untrack.type = 'button';
    untrack.className = 'danger';
    untrack.textContent = 'Untrack';
    untrack.title = 'Stop recreating this task. It stays in Habitica.';
    untrack.addEventListener('click', () => act(untrack, () => request(`tasks/${task.id}`, { method: 'DELETE' })));
    buttons.append(untrack);
  }

  item.append(title, meta, buttons);
  return item;
}

function describe(task) {
  const parts = [task.difficulty];
  if (task.type === 'todo' && task.dueDate) {
    parts.push(`due ${task.dueDate}`);
  }
  if (task.type === 'daily' && task.repeatDays.length) {
    parts.push(task.repeatDays.map((day) => DAY_LABELS[day] ?? day).join(' '));
  }
  if (!task.exists) {
    parts.push('missing from Habitica — will be recreated');
  } else if (task.paused) {
    parts.push('paused');
  } else if (task.completed) {
    parts.push('done');
  }
  if (task.streak) {
    parts.push(`streak ${task.streak}`);
  }
  return parts.join(' · ');
}

async function act(button, work) {
  button.disabled = true;
  try {
    await work();
    await loadTasks();
  } catch (error) {
    el.status.textContent = error.message;
    button.disabled = false;
  }
}

// --- Boot ------------------------------------------------------------------

async function boot() {
  followHomeAssistantTheme();
  setType('todo');
  try {
    state.children = await request('children');
  } catch (error) {
    el.status.textContent = error.message;
    return;
  }
  let remembered = null;
  try {
    remembered = localStorage.getItem('habitica-child');
  } catch {
    // No stored pick; fall through to the first kid.
  }
  const initial = state.children.find((child) => child.slug === remembered) ?? state.children[0];
  if (initial) {
    await selectChild(initial.slug);
  }
}

boot();
