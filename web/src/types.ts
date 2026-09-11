// Client-side model of the API responses (see contracts/openapi). The web
// client owns these types – it shares no code with the services.

export type ExecutionStatus = 'PENDING' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED';
export type ActionStatus = 'PENDING' | 'DISPATCHED' | 'RETRYING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
export type Priority = 'low' | 'normal' | 'high';

export type Trigger = { type: 'manual' } | { type: 'schedule'; cron: string; timezone: string };

export interface ActionDefinition {
  key: string;
  type: string;
  step: number;
  params: Record<string, unknown>;
}

export interface Routine {
  id: string;
  name: string;
  description: string;
  trigger: Trigger;
  actions: ActionDefinition[];
  active: boolean;
  nextRunAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineInput {
  name: string;
  description: string;
  trigger: Trigger;
  actions: ActionDefinition[];
  version?: number;
}

export interface ActionType {
  type: string;
  description: string;
  requiredParams: string[];
  example: Record<string, unknown>;
}

export interface Execution {
  id: string;
  routineId: string;
  routineName: string;
  status: ExecutionStatus;
  trigger: 'manual' | 'schedule';
  scheduledFor: string | null;
  correlationId: string;
  traceId: string | null;
  currentStep: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ExecutionAction {
  id: string;
  key: string;
  type: string;
  step: number;
  status: ActionStatus;
  attempts: number;
  params: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  processedBy: string | null;
  dispatchedAt: string | null;
  finishedAt: string | null;
}

export interface ExecutionLogEntry {
  at: string;
  kind: string;
  actionKey: string | null;
  message: string;
}

export interface ExecutionDetail extends Execution {
  actions: ExecutionAction[];
  log: ExecutionLogEntry[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  status: 'OPEN' | 'DONE';
  dueDate: string | null;
  sourceExecutionId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface Notification {
  id: string;
  title: string;
  body: string;
  priority: Priority;
  category: 'action' | 'execution';
  executionId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface QueueStatus {
  name: string;
  ready: number;
  unacked: number;
  consumers: number;
}

export interface SystemStatus {
  services: Record<string, { status: 'up' | 'down'; instance?: string }>;
  broker: 'up' | 'down';
  queues: QueueStatus[];
}

export interface User {
  id: string;
  email: string;
  displayName: string;
}

export const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set(['COMPLETED', 'FAILED']);
