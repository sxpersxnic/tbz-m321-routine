// Client-side model of the API responses (see contracts/openapi). The web
// client owns these types – it shares no code with the services.

export type ExecutionStatus = 'PENDING' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED';
export type ActionStatus = 'PENDING' | 'DISPATCHED' | 'RETRYING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

/** Why a step was skipped: its condition, an earlier failure, expiry, the user, or a test run. */
export type SkipReason = 'condition' | 'failure' | 'expired' | 'user' | 'test';

/** Why an action failed (docs/v2/05-messaging.md §6). */
export type ErrorCode =
  | 'NOT_FOUND' | 'UNAUTHORIZED' | 'FORBIDDEN_HOST' | 'TIMEOUT' | 'UNREACHABLE' | 'RATE_LIMITED' | 'INVALID_PARAMS'
  | 'TEMPLATE_ERROR' | 'NOT_AVAILABLE' | 'REFERENCE_GONE' | 'SUBROUTINE_FAILED' | 'AWAIT_EXPIRED' | 'QUOTA_EXCEEDED'
  | 'AI_REFUSED' | 'INPUT_TOO_LARGE' | 'CONFLICT' | 'CANCELLED' | 'INTERNAL';
export type Priority = 'low' | 'normal' | 'high';

export type Trigger = { type: 'manual' } | { type: 'schedule'; cron: string; timezone: string } | { type: 'webhook' };
export type TriggerType = Trigger['type'];
/** How a run started: its routine's trigger, or a "Run routine" step of another routine. */
export type ExecutionTrigger = TriggerType | 'routine';

export interface RunIf {
  /** Key of an earlier `condition.if` step. */
  action: string;
  is: boolean;
}

export interface ActionDefinition {
  key: string;
  type: string;
  step: number;
  params: Record<string, unknown>;
  /** Run only if that condition produced `is` – else the step is skipped. */
  runIf?: RunIf;
  /** One `{{…}}` reference to a list: the step runs once per item ({{item}}, {{index}}). */
  forEach?: string;
}

export interface Routine {
  id: string;
  name: string;
  description: string;
  trigger: Trigger;
  actions: ActionDefinition[];
  active: boolean;
  nextRunAt: string | null;
  /** Path of the secret webhook URL – only for webhook routines. */
  webhookPath: string | null;
  /** Chosen look; null = taken from the first action. */
  icon: string | null;
  color: string | null;
  version: number;
  /** Notify after this many failures in a row; null = never. */
  alertAfterFailures: number | null;
  health: RoutineHealth;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineHealth {
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Finished runs in the last 30 days. */
  runs30d: number;
  failures30d: number;
}

export interface RoutineInput {
  name: string;
  description: string;
  trigger: Trigger;
  actions: ActionDefinition[];
  /** Omitted = unchanged, null = taken from the first action. */
  icon?: string | null;
  color?: string | null;
  /** Omitted = unchanged (2 for a new routine), null = never. */
  alertAfterFailures?: number | null;
  version?: number;
}

/** The kind of write that produced a version (docs/v2/06-engine.md §7). */
export type VersionOrigin = 'create' | 'edit' | 'appearance' | 'activate' | 'deactivate' | 'webhook' | 'restore' | 'backfill';

/** A routine as its history keeps it. */
export interface VersionDefinition {
  name: string;
  description: string;
  trigger: Trigger;
  actions: ActionDefinition[];
  icon: string | null;
  color: string | null;
  alertAfterFailures?: number | null;
  active: boolean;
}

export interface RoutineVersion {
  version: number;
  createdAt: string;
  origin: VersionOrigin;
  definition: VersionDefinition;
}

// ---------------------------------------------------------------- catalog (docs/v2/07-web.md §3, copied from 04 §2)

export type ParamType =
  | 'text' | 'longText' | 'number' | 'integer' | 'money' | 'boolean'
  | 'date' | 'time' | 'duration' | 'choice' | 'ref' | 'list' | 'object' | 'value';

export interface ParamSpec {
  name: string;
  label: string;
  type: ParamType;
  required?: boolean;
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
  ref?: { domain: string; collection: string };
  min?: number;
  max?: number;
  placeholder?: string;
  hint?: string;
  /** Default true: `{{…}}` allowed. */
  templating?: boolean;
  /** Shown under "More options". */
  advanced?: boolean;
}

export interface OutputField {
  name: string;
  label: string;
  type: ParamType;
  example?: unknown;
}

export type Tint = 'sky' | 'indigo' | 'violet' | 'pink' | 'orange' | 'green' | 'teal' | 'grey';

export interface Capability {
  type: string;
  kind: 'action' | 'value' | 'human';
  label: string;
  /** `Record {amount} for {category}` – `{param}` placeholders. */
  sentence: string;
  description: string;
  icon?: string;
  tint?: Tint;
  params: ParamSpec[];
  output: OutputField[];
  sideEffects: boolean;
  preview?: boolean;
  human?: { awaits: 'task' | 'question' | 'checkIn'; defaultTimeout?: string };
  acceptsSecrets?: string[];
  since: number;
  deprecated?: { since: number; replacedBy?: string; message: string };
}

export interface TriggerSpec {
  type: string;
  label: string;
  sentence: string;
  description: string;
  fields: OutputField[];
  since: number;
  deprecated?: { since: number; replacedBy?: string; message: string };
}

export interface CollectionSpec {
  label: string;
  list: string;
  idField: string;
  labelField: string;
  iconField?: string;
  tintField?: string;
}

/** A domain as GET /api/v1/catalog returns it: its manifest, and whether it is on for the user. */
export interface CatalogDomain {
  contract: 1;
  domain: string;
  manifestVersion: number;
  service: string;
  name: string;
  description: string;
  icon: string;
  tint: Tint;
  order: number;
  optional: boolean;
  prefixes: string[];
  page?: string;
  collections?: Record<string, CollectionSpec>;
  capabilities: Capability[];
  triggers?: TriggerSpec[];
  enabled: boolean;
}

export interface Execution {
  id: string;
  routineId: string;
  routineName: string;
  status: ExecutionStatus;
  trigger: ExecutionTrigger;
  /** The run whose "Run routine" step started this one. */
  calledBy?: string | null;
  /** How often "Retry from here" was used on this run. */
  resumeCount: number;
  /** The routine version the run used – null for runs before v2. */
  routineVersion: number | null;
  scheduledFor: string | null;
  correlationId: string;
  traceId: string | null;
  currentStep: number;
  error: string | null;
  /** Error code of the failed step – null unless FAILED, and for runs that failed before v2. */
  errorCode: ErrorCode | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type StatusCounts = Partial<Record<ExecutionStatus, number>>;

export interface ExecutionStats {
  since: string;
  /** executions created since `since` */
  byStatus: StatusCounts;
  /** all executions still in flight, however old */
  inFlight: StatusCounts;
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
  errorCode: ErrorCode | null;
  /** Why it was skipped – null for runs from before v2. */
  skipReason: SkipReason | null;
  processedBy: string | null;
  dispatchedAt: string | null;
  finishedAt: string | null;
  runIf?: RunIf;
  forEach?: string;
  /** Set on the actions a "repeat for each" step was expanded into. */
  parentId?: string;
  loopIndex?: number;
}

export interface ExecutionLogEntry {
  at: string;
  kind: string;
  actionKey: string | null;
  message: string;
}

export interface ExecutionDetail extends Execution {
  /** JSON body of the webhook call that started the run. */
  triggerPayload: Record<string, unknown> | null;
  actions: ExecutionAction[];
  log: ExecutionLogEntry[];
}

export interface TaskList {
  id: string;
  name: string;
  description: string;
  color: string;
  /** Chosen symbol; null = checklist. */
  icon: string | null;
  /** "Todo" – where tasks without a list go; cannot be deleted. */
  isDefault: boolean;
  createdAt: string;
}

export interface TaskListInput {
  name: string;
  description: string;
  color: string;
  icon: string | null;
}

export interface Task {
  id: string;
  listId: string;
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

export interface DeadLetter {
  messageId: string | null;
  type: string | null;
  error: string | null;
  failedAt: string | null;
  attempts: number | null;
  routingKey: string;
  body: unknown;
}

/** One domain in the registry (GET /api/v1/system/registry, admin – routine-service.md §4). */
export interface RegistryEntry {
  domain: string;
  name: string | null;
  service: string;
  builtIn: boolean;
  version: number | null;
  versions: number[];
  digest: string | null;
  registeredAt: string | null;
  lastHeartbeatAt: string;
  status: 'up' | 'stale' | 'rejected';
  rejected: { reason: string; manifestVersion: number | null; digest: string | null; service: string | null; instance: string; at: string } | null;
  bindings: string[];
  usage: Record<string, number>;
}

export interface DeadLetterQueue {
  queue: string;
  workQueue: string;
  count: number;
  /** Up to 20 messages from the head (a peek). */
  sample: DeadLetter[];
}

export interface QueueStatus {
  name: string;
  ready: number;
  unacked: number;
  consumers: number;
  /** Deliveries per second (absent from older gateways). */
  rate?: number;
}

export interface SystemStatus {
  services: Record<string, { status: 'up' | 'down'; instance?: string }>;
  broker: 'up' | 'down';
  /** Nodes of the broker cluster; empty while no node is reachable. */
  brokerNodes?: Array<{ name: string; running: boolean }>;
  queues: QueueStatus[];
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  /** `admin` opens the system views (dead letters …); every signed-in user is `user`. */
  roles: Array<'user' | 'admin'>;
}

export const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set(['COMPLETED', 'FAILED']);
