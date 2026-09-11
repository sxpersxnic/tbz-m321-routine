// Routine – minimal web client. Talks only to the API gateway.

const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–');
const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'medium' }) : '–');

const state = {
  token: localStorage.getItem('routine.token'),
  email: localStorage.getItem('routine.email'),
  tab: 'routines',
  selectedExecution: null,
  timer: null,
};

// ---------------------------------------------------------------- API
async function api(method, path, body, headers = {}) {
  const response = await fetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(state.token ? { authorization: `Bearer ${state.token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401 && state.token) {
    logout();
    throw new Error('Sitzung abgelaufen');
  }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.detail ?? `HTTP ${response.status}`);
    error.details = data?.errors;
    throw error;
  }
  return data;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (element.hidden = true), 3500);
}

// ---------------------------------------------------------------- session
async function login(email, password, register = false) {
  if (register) await api('POST', '/api/v1/auth/register', { email, password });
  const result = await api('POST', '/api/v1/auth/login', { email, password });
  state.token = result.accessToken;
  state.email = result.user.email;
  localStorage.setItem('routine.token', state.token);
  localStorage.setItem('routine.email', state.email);
  render();
}

function logout() {
  state.token = null;
  localStorage.removeItem('routine.token');
  render();
}

$('#login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  login(form.get('email'), form.get('password')).catch(showLoginError);
});
$('#register').addEventListener('click', () => {
  const form = new FormData($('#login-form'));
  login(form.get('email'), form.get('password'), true).catch(showLoginError);
});
$('#logout').addEventListener('click', logout);

function showLoginError(error) {
  $('#login-error').textContent = error.message;
  $('#login-error').hidden = false;
}

// ---------------------------------------------------------------- navigation
document.querySelectorAll('#nav button').forEach((button) =>
  button.addEventListener('click', () => {
    state.tab = button.dataset.tab;
    render();
  }),
);

function render() {
  const loggedIn = Boolean(state.token);
  $('#login-view').hidden = loggedIn;
  $('#nav').hidden = !loggedIn;
  $('#session').hidden = !loggedIn;
  $('#user-email').textContent = state.email ?? '';
  document.querySelectorAll('.tab').forEach((section) => (section.hidden = !loggedIn || section.id !== `${state.tab}-view`));
  document.querySelectorAll('#nav button').forEach((button) => button.classList.toggle('active', button.dataset.tab === state.tab));
  clearInterval(state.timer);
  if (!loggedIn) return;
  loadActionTypes();
  refresh();
  const interval = { executions: 1000, system: 1000, notifications: 3000, tasks: 3000, routines: 5000 }[state.tab];
  state.timer = setInterval(refresh, interval);
}

async function refresh() {
  try {
    await { routines: loadRoutines, executions: loadExecutions, tasks: loadTasks, notifications: loadNotifications, system: loadSystem }[state.tab]();
    loadUnreadCount();
  } catch (error) {
    console.warn(error);
  }
}

// ---------------------------------------------------------------- routines
const TEMPLATES = {
  'Weekly Review': {
    name: 'Weekly Review',
    description: 'Wetter abrufen und Aufgabe erstellen (parallel), Zusammenfassung erzeugen, Benachrichtigung senden',
    trigger: { type: 'schedule', cron: '0 8 * * 1', timezone: 'Europe/Zurich' },
    actions: [
      { key: 'weather', type: 'weather.get', step: 1, params: { city: 'Zürich' } },
      { key: 'task', type: 'task.create', step: 1, params: { title: 'Wochenrückblick schreiben', dueInDays: 2, priority: 'high' } },
      { key: 'summary', type: 'summary.generate', params: { title: 'Weekly Review', sections: { Wetter: '{{actions.weather.summary}}', Aufgabe: '{{actions.task.title}} (fällig {{actions.task.dueDate}})' } } },
      { key: 'notify', type: 'notification.send', params: { title: 'Weekly Review bereit', body: '{{actions.summary.text}}' } },
    ],
  },
  'Morning Setup': {
    name: 'Morning Setup',
    trigger: { type: 'schedule', cron: '30 7 * * 1-5', timezone: 'Europe/Zurich' },
    actions: [
      { key: 'weather', type: 'weather.get', params: { city: 'Bern' } },
      { key: 'task', type: 'task.create', params: { title: 'Tagesplanung ({{actions.weather.condition}})', dueInDays: 0 } },
      { key: 'notify', type: 'notification.send', params: { title: 'Guten Morgen', body: '{{actions.weather.summary}}' } },
    ],
  },
  'Flaky Webhook (Retry)': {
    name: 'Flaky Webhook',
    description: 'Der Dienst beantwortet die ersten zwei Versuche mit 503',
    trigger: { type: 'manual' },
    actions: [
      { key: 'call', type: 'http.request', params: { method: 'POST', url: 'http://mock-external:8090/flaky?failTimes=2', body: { ping: true } } },
      { key: 'notify', type: 'notification.send', params: { title: 'Webhook nach {{actions.call.body.attempt}} Versuchen erfolgreich' } },
    ],
  },
  'Webhook auslösen': {
    name: 'Webhook',
    trigger: { type: 'manual' },
    actions: [{ key: 'hook', type: 'http.request', params: { method: 'POST', url: 'http://mock-external:8090/webhooks/demo', body: { routine: '{{routine.name}}', at: '{{now}}' } } }],
  },
  'Alle 30 Sekunden': {
    name: 'Heartbeat',
    trigger: { type: 'schedule', cron: '*/30 * * * * *', timezone: 'Europe/Zurich' },
    actions: [{ key: 'weather', type: 'weather.get', params: { city: 'Lugano' } }],
  },
  'Fehlerhafter Endpunkt': {
    name: 'Broken Endpoint',
    trigger: { type: 'manual' },
    actions: [
      { key: 'call', type: 'http.request', params: { url: 'http://mock-external:8090/status/404' } },
      { key: 'notify', type: 'notification.send', params: { title: 'wird nie gesendet' } },
    ],
  },
};

const templateSelect = $('#template');
for (const name of Object.keys(TEMPLATES)) templateSelect.add(new Option(name, name));
const applyTemplate = () => ($('#routine-json').value = JSON.stringify(TEMPLATES[templateSelect.value], null, 2));
templateSelect.addEventListener('change', applyTemplate);
applyTemplate();

$('#create-routine').addEventListener('click', async () => {
  const errorBox = $('#routine-error');
  errorBox.hidden = true;
  try {
    const routine = await api('POST', '/api/v1/routines', JSON.parse($('#routine-json').value));
    await api('POST', `/api/v1/routines/${routine.id}/activate`);
    toast(`Routine „${routine.name}" erstellt und aktiviert`);
    loadRoutines();
  } catch (error) {
    errorBox.textContent = [error.message, ...(error.details ?? []).map((d) => `• ${typeof d === 'string' ? d : `${d.instancePath} ${d.message}`}`)].join('\n');
    errorBox.hidden = false;
  }
});

function describeTrigger(trigger) {
  return trigger.type === 'schedule' ? `⏱ ${trigger.cron} (${trigger.timezone})` : '▶ manuell';
}

async function loadRoutines() {
  const { items } = await api('GET', '/api/v1/routines');
  $('#routine-list').innerHTML =
    items
      .map(
        (r) => `<div class="item">
          <div class="item-head">
            <span class="item-title">${esc(r.name)}</span>
            <span class="badge ${r.active ? 'active' : ''}">${r.active ? 'aktiv' : 'inaktiv'}</span>
          </div>
          <div class="meta">${esc(describeTrigger(r.trigger))} · ${r.actions.length} Aktionen: ${r.actions.map((a) => esc(`${a.key} (${a.type})`)).join(', ')}</div>
          ${r.nextRunAt ? `<div class="meta">nächster Lauf: ${dateTime(r.nextRunAt)}</div>` : ''}
          <div class="row">
            <button type="button" class="small" data-run="${r.id}" ${r.active ? '' : 'disabled'}>Jetzt ausführen</button>
            <button type="button" class="small ghost" data-toggle="${r.id}" data-active="${r.active}">${r.active ? 'Deaktivieren' : 'Aktivieren'}</button>
            <button type="button" class="small ghost" data-delete="${r.id}">Löschen</button>
          </div>
        </div>`,
      )
      .join('') || '<p class="muted">Noch keine Routinen – rechts eine Vorlage wählen.</p>';
}

$('#routine-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.run) {
      const execution = await api('POST', `/api/v1/routines/${button.dataset.run}/executions`, undefined, { 'idempotency-key': crypto.randomUUID() });
      state.selectedExecution = execution.id;
      state.tab = 'executions';
      render();
    } else if (button.dataset.toggle) {
      await api('POST', `/api/v1/routines/${button.dataset.toggle}/${button.dataset.active === 'true' ? 'deactivate' : 'activate'}`);
      loadRoutines();
    } else if (button.dataset.delete && confirm('Routine inkl. aller Ausführungen löschen?')) {
      await api('DELETE', `/api/v1/routines/${button.dataset.delete}`);
      loadRoutines();
    }
  } catch (error) {
    toast(error.message);
  }
});

let actionTypesLoaded = false;
function loadActionTypes() {
  if (actionTypesLoaded) return;
  actionTypesLoaded = true;
  api('GET', '/api/v1/action-types')
  .then(({ items }) => {
    $('#action-types').innerHTML = items
      .map((t) => `<p><code>${esc(t.type)}</code> – ${esc(t.description)}<br><span class="muted small">Pflicht: ${esc(t.requiredParams.join(', '))} · Beispiel: <code>${esc(JSON.stringify(t.example))}</code></span></p>`)
      .join('');
  })
  .catch(() => (actionTypesLoaded = false));
}

// ---------------------------------------------------------------- executions
async function loadExecutions() {
  const { items } = await api('GET', '/api/v1/executions?limit=40');
  if (!state.selectedExecution && items[0]) state.selectedExecution = items[0].id;
  $('#execution-list').innerHTML =
    items
      .map(
        (e) => `<div class="item clickable ${e.id === state.selectedExecution ? 'selected' : ''}" data-execution="${e.id}">
          <div class="item-head"><span class="item-title">${esc(e.routineName)}</span><span class="badge ${e.status}">${e.status}</span></div>
          <div class="meta">${dateTime(e.createdAt)} · ${e.trigger === 'schedule' ? '⏱ Zeitplan' : '▶ manuell'}</div>
        </div>`,
      )
      .join('') || '<p class="muted">Noch keine Ausführungen.</p>';
  if (state.selectedExecution) await loadExecutionDetail(state.selectedExecution);
}

$('#execution-list').addEventListener('click', (event) => {
  const item = event.target.closest('[data-execution]');
  if (!item) return;
  state.selectedExecution = item.dataset.execution;
  loadExecutions();
});

function pipeline(status, log) {
  const waited = log.some((entry) => entry.kind === 'WAITING');
  const stages = ['PENDING', 'RUNNING', ...(waited || status === 'WAITING' ? ['WAITING'] : []), status === 'FAILED' ? 'FAILED' : 'COMPLETED'];
  const order = { PENDING: 0, RUNNING: 1, WAITING: 2, COMPLETED: 3, FAILED: 3 };
  return `<div class="pipeline">${stages
    .map((stage) => {
      const cls = stage === status ? `current ${stage}` : order[stage] < order[status] || (stage === 'WAITING' && waited) ? 'done' : '';
      return `<span class="stage ${cls}">${stage}</span>`;
    })
    .join('<span class="arrow">→</span>')}</div>`;
}

async function loadExecutionDetail(id) {
  const e = await api('GET', `/api/v1/executions/${id}`);
  $('#execution-detail').innerHTML = `
    <div class="item-head"><h2>${esc(e.routineName)}</h2><span class="badge ${e.status}">${e.status}</span></div>
    ${pipeline(e.status, e.log)}
    ${e.error ? `<p class="error">${esc(e.error)}</p>` : ''}
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Schritt</th><th>Aktion</th><th>Status</th><th class="num">Versuche</th><th>verarbeitet von</th></tr></thead>
      <tbody>${e.actions
        .map(
          (a) => `<tr>
            <td>${a.step}</td>
            <td><strong>${esc(a.key)}</strong><div class="meta">${esc(a.type)}</div>
              ${a.output ? `<pre class="output">${esc(JSON.stringify(a.output, null, 1))}</pre>` : ''}
              ${a.error ? `<div class="error small">${esc(a.error)}</div>` : ''}</td>
            <td><span class="badge ${a.status}">${a.status}</span></td>
            <td class="num">${a.attempts}</td>
            <td class="mono small">${esc(a.processedBy ?? '–')}</td>
          </tr>`,
        )
        .join('')}</tbody>
    </table></div>
    <h3>Verlauf</h3>
    <ul class="timeline">${e.log
      .map((entry) => `<li><span class="t">${time(entry.at)}</span><span class="k">${esc(entry.kind)}</span><span>${entry.actionKey ? `<strong>${esc(entry.actionKey)}</strong> ` : ''}${esc(entry.message)}</span></li>`)
      .join('')}</ul>
    <p class="meta">Correlation-ID <span class="mono">${esc(e.correlationId)}</span><br>
      Logs aller Services: <code>scripts/demo.sh trace ${esc(e.correlationId)}</code> ·
      <a href="http://localhost:16686/search?service=routine-service" target="_blank" rel="noopener">Jaeger</a></p>`;
}

// ---------------------------------------------------------------- tasks
async function loadTasks() {
  const { items } = await api('GET', '/api/v1/tasks');
  $('#task-list').innerHTML =
    items
      .map(
        (t) => `<tr class="${t.status === 'DONE' ? 'done' : ''}">
          <td><input type="checkbox" data-task="${t.id}" ${t.status === 'DONE' ? 'checked' : ''} aria-label="erledigt"></td>
          <td>${esc(t.title)}</td><td>${esc(t.priority)}</td><td>${esc(t.dueDate ?? '–')}</td>
          <td class="small">${t.sourceExecutionId ? 'Routine' : 'manuell'}</td><td class="small">${dateTime(t.createdAt)}</td>
        </tr>`,
      )
      .join('') || '<tr><td colspan="6" class="muted">Keine Aufgaben.</td></tr>';
}

$('#task-list').addEventListener('change', async (event) => {
  const id = event.target.dataset.task;
  if (!id) return;
  await api('PATCH', `/api/v1/tasks/${id}`, { status: event.target.checked ? 'DONE' : 'OPEN' }).catch((error) => toast(error.message));
  loadTasks();
});

// ---------------------------------------------------------------- notifications
async function loadNotifications() {
  const { items } = await api('GET', '/api/v1/notifications');
  $('#notification-list').innerHTML =
    items
      .map(
        (n) => `<div class="item clickable ${n.readAt ? '' : 'unread'}" data-notification="${n.id}">
          <div class="item-head"><span class="item-title">${esc(n.title)}</span><span class="badge ${n.priority === 'high' ? 'FAILED' : ''}">${esc(n.category)}</span></div>
          ${n.body ? `<div style="white-space: pre-wrap; margin-top: 6px">${esc(n.body)}</div>` : ''}
          <div class="meta">${dateTime(n.createdAt)}</div>
        </div>`,
      )
      .join('') || '<p class="muted">Keine Benachrichtigungen.</p>';
}

$('#notification-list').addEventListener('click', async (event) => {
  const item = event.target.closest('[data-notification]');
  if (!item || !item.classList.contains('unread')) return;
  await api('POST', `/api/v1/notifications/${item.dataset.notification}/read`).catch(() => undefined);
  loadNotifications();
});

async function loadUnreadCount() {
  const { items } = await api('GET', '/api/v1/notifications?unread=true');
  $('#unread').textContent = items.length;
  $('#unread').hidden = items.length === 0;
}

// ---------------------------------------------------------------- system
async function loadSystem() {
  const status = await api('GET', '/api/v1/system/status');
  $('#service-grid').innerHTML = [...Object.entries(status.services), ['rabbitmq', { status: status.broker }]]
    .map(
      ([name, s]) => `<div class="item"><div class="item-head"><span class="item-title">${esc(name)}</span><span class="badge ${s.status}">${s.status}</span></div>
        ${s.instance ? `<div class="meta mono">${esc(s.instance)}</div>` : ''}</div>`,
    )
    .join('');
  $('#queue-list').innerHTML = status.queues
    .filter((q) => !q.name.includes('.retry.') || q.ready > 0)
    .map(
      (q) => `<tr><td class="mono">${esc(q.name)}</td><td class="num ${q.ready > 0 ? 'hot' : ''}">${q.ready}</td>
        <td class="num">${q.unacked}</td><td class="num ${q.consumers === 0 && !q.name.endsWith('.dlq') && !q.name.includes('.retry.') && !q.name.includes('unrouted') ? 'hot' : ''}">${q.consumers}</td></tr>`,
    )
    .join('');
}

render();
