import type {
  ActionType,
  Execution,
  ExecutionDetail,
  ExecutionStatus,
  Notification,
  Routine,
  RoutineInput,
  SystemStatus,
  Task,
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
    listeners.forEach((listener) => listener());
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

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { authorization: `Bearer ${session.token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401 && session && !path.startsWith('/api/v1/auth/login')) {
    sessionStore.set(null);
  }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const details = Array.isArray(data?.errors) ? data.errors.map(describeDetail) : [];
    throw new ApiError(response.status, data?.detail ?? `HTTP ${response.status}`, details);
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
  deleteRoutine: (id: string) => send<null>('DELETE', `/api/v1/routines/${id}`),
  setActive: (id: string, active: boolean) => send<Routine>('POST', `/api/v1/routines/${id}/${active ? 'activate' : 'deactivate'}`),
  async trigger(id: string): Promise<Execution> {
    // a fresh idempotency key per click: a network retry of this request never starts a second run
    const { data } = await request<Execution>('POST', `/api/v1/routines/${id}/executions`, undefined, {
      'idempotency-key': crypto.randomUUID(),
    });
    return data;
  },

  executions: async (filter: { status?: ExecutionStatus; limit?: number } = {}) => {
    const query = new URLSearchParams({ limit: String(filter.limit ?? 50), ...(filter.status ? { status: filter.status } : {}) });
    return (await get<{ items: Execution[] }>(`/api/v1/executions?${query}`)).items;
  },
  routineExecutions: async (id: string, limit = 20) =>
    (await get<{ items: Execution[] }>(`/api/v1/routines/${id}/executions?limit=${limit}`)).items,
  execution: (id: string) => get<ExecutionDetail>(`/api/v1/executions/${id}`),

  tasks: async (status?: Task['status']) => (await get<{ items: Task[] }>(`/api/v1/tasks${status ? `?status=${status}` : ''}`)).items,
  createTask: (input: { title: string; description?: string; priority?: string; dueDate?: string }) =>
    send<Task>('POST', '/api/v1/tasks', input),
  setTaskStatus: (id: string, status: Task['status']) => send<Task>('PATCH', `/api/v1/tasks/${id}`, { status }),

  notifications: async (unread = false) =>
    (await get<{ items: Notification[] }>(`/api/v1/notifications${unread ? '?unread=true' : ''}`)).items,
  markRead: (id: string) => send<Notification>('POST', `/api/v1/notifications/${id}/read`),

  system: () => get<SystemStatus>('/api/v1/system/status'),
};
