import type {
  ActionType,
  Execution,
  ExecutionDetail,
  ExecutionStats,
  ExecutionStatus,
  Notification,
  Routine,
  RoutineInput,
  SystemStatus,
  Task,
  TaskList,
  TaskListInput,
  User,
} from './types.ts';

export class ApiError extends Error {
  status: number;
  details: string[];

  constructor(status: number, message: string, details: string[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// ---------------------------------------------------------------- session

export interface Session {
  token: string;
  user: User;
}

const SESSION_KEY = 'routine.session';
const listeners = new Set<() => void>();

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

let session = readSession();

export const sessionStore = {
  get: () => session,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  set(next: Session | null) {
    session = next;
    try {
      if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      // storage unavailable – session lives in memory only
    }
    listeners.forEach((listener) => {listener()});
  },
};

// ---------------------------------------------------------------- connection health

// Polling screens keep their last good data when a refresh fails, so a dead
// backend looks exactly like a quiet one. Every request reports here instead,
// and the shell turns that into one honest banner for the whole app.
const connectionListeners = new Set<() => void>();
let reachable = true;

function setReachable(next: boolean) {
  if (reachable === next) return;
  reachable = next;
  connectionListeners.forEach((listener) => { listener(); });
}

export const connectionStore = {
  get: () => reachable,
  subscribe(listener: () => void) {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  },
};

// ---------------------------------------------------------------- transport

function describeDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && 'message' in detail) {
    const { instancePath, message } = detail as { instancePath?: string; message?: string };
    return `${instancePath ?? ''} ${message ?? ''}`.trim();
  }
  return JSON.stringify(detail);
}

/** Gateway statuses that mean "the backend is unreachable", not "your request was wrong". */
const UNREACHABLE = new Set([502, 503, 504]);

/**
 * A fallback for responses that carry no `detail`. "HTTP 502" tells the user
 * nothing they can act on; it is a status code shown to someone who never asked
 * for one.
 */
function statusMessage(status: number): string {
  if (UNREACHABLE.has(status)) return 'The server is not responding. Please try again in a moment.';
  if (status === 401) return 'Your session has expired or is invalid.';
  if (status === 403) return 'You are not allowed to do that.';
  if (status === 404) return 'This no longer exists.';
  if (status === 409) return 'This was changed by someone else in the meantime.';
  if (status === 429) return 'Too many requests. Please wait a moment.';
  if (status >= 500) return 'Something went wrong on the server.';
  return 'The request was rejected.';
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(session ? { authorization: `Bearer ${session.token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    setReachable(false);
    throw new ApiError(0, 'The server cannot be reached.');
  }
  setReachable(!UNREACHABLE.has(response.status));
  if (response.status === 401 && session && !path.startsWith('/api/v1/auth/login')) {
    sessionStore.set(null);
  }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const details = Array.isArray(data?.errors) ? data.errors.map(describeDetail) : [];
    throw new ApiError(response.status, data?.detail ?? statusMessage(response.status), details);
  }
  return { data: data as T, headers: response.headers, status: response.status };
}

const get = async <T>(path: string) => (await request<T>('GET', path)).data;
const send = async <T>(method: string, path: string, body?: unknown) => (await request<T>(method, path, body)).data;

// ---------------------------------------------------------------- endpoints

export const api = {
  async login(email: string, password: string): Promise<Session> {
    const result = await send<{ accessToken: string; user: User }>('POST', '/api/v1/auth/login', { email, password });
    return { token: result.accessToken, user: result.user };
  },
  register: (email: string, password: string, displayName?: string) =>
    send<User>('POST', '/api/v1/auth/register', { email, password, ...(displayName ? { displayName } : {}) }),

  actionTypes: async () => (await get<{ items: ActionType[] }>('/api/v1/action-types')).items,

  routines: async () => (await get<{ items: Routine[] }>('/api/v1/routines')).items,
  routine: (id: string) => get<Routine>(`/api/v1/routines/${id}`),
  createRoutine: (input: RoutineInput) => send<Routine>('POST', '/api/v1/routines', input),
  updateRoutine: (id: string, input: RoutineInput) => send<Routine>('PUT', `/api/v1/routines/${id}`, input),
  setAppearance: (id: string, appearance: { icon?: string | null; color?: string | null }) =>
    send<Routine>('PATCH', `/api/v1/routines/${id}`, appearance),
  deleteRoutine: (id: string) => send<null>('DELETE', `/api/v1/routines/${id}`),
  setActive: (id: string, active: boolean) => send<Routine>('POST', `/api/v1/routines/${id}/${active ? 'activate' : 'deactivate'}`),
  async trigger(id: string): Promise<Execution> {
    // a fresh idempotency key per click: a network retry of this request never starts a second run
    const { data } = await request<Execution>('POST', `/api/v1/routines/${id}/executions`, undefined, {
      'idempotency-key': crypto.randomUUID(),
    });
    return data;
  },

  /** Rotating invalidates the old URL immediately. */
  rotateWebhook: (id: string) => send<Routine>('POST', `/api/v1/routines/${id}/webhook/rotate`),
  /** Calls a routine's webhook the way an external system would – used for test events and "run again". */
  async callWebhook(path: string, body: Record<string, unknown>): Promise<{ executionId: string }> {
    const { data } = await request<{ executionId: string }>('POST', path, body, { 'idempotency-key': crypto.randomUUID() });
    return data;
  },

  executions: async (filter: { status?: ExecutionStatus; limit?: number } = {}) => {
    const query = new URLSearchParams({ limit: String(filter.limit ?? 50), ...(filter.status ? { status: filter.status } : {}) });
    return (await get<{ items: Execution[] }>(`/api/v1/executions?${query}`)).items;
  },
  routineExecutions: async (id: string, limit = 20) =>
    (await get<{ items: Execution[] }>(`/api/v1/routines/${id}/executions?limit=${limit}`)).items,
  execution: (id: string) => get<ExecutionDetail>(`/api/v1/executions/${id}`),
  executionStats: (hours = 24) => get<ExecutionStats>(`/api/v1/executions/stats?hours=${hours}`),

  tasks: async (status?: Task['status']) => (await get<{ items: Task[] }>(`/api/v1/tasks${status ? `?status=${status}` : ''}`)).items,
  createTask: (input: { title: string; description?: string; priority?: string; dueDate?: string; listId?: string }) =>
    send<Task>('POST', '/api/v1/tasks', input),
  taskLists: async () => (await get<{ items: TaskList[] }>('/api/v1/task-lists')).items,
  createTaskList: (input: TaskListInput) => send<TaskList>('POST', '/api/v1/task-lists', input),
  updateTaskList: (id: string, input: Partial<TaskListInput>) => send<TaskList>('PATCH', `/api/v1/task-lists/${id}`, input),
  /** Deletes the list's tasks too. */
  deleteTaskList: (id: string) => send<null>('DELETE', `/api/v1/task-lists/${id}`),
  setTaskStatus: (id: string, status: Task['status']) => send<Task>('PATCH', `/api/v1/tasks/${id}`, { status }),

  /** Only what routine steps sent – run outcomes live on the Runs page, not in the inbox. */
  notifications: async (unread = false) => {
    const query = new URLSearchParams({ category: 'action', ...(unread ? { unread: 'true' } : {}) });
    return (await get<{ items: Notification[] }>(`/api/v1/notifications?${query}`)).items;
  },
  markRead: (id: string) => send<Notification>('POST', `/api/v1/notifications/${id}/read`),
  deleteNotification: (id: string) => send<null>('DELETE', `/api/v1/notifications/${id}`),

  system: () => get<SystemStatus>('/api/v1/system/status'),
};
