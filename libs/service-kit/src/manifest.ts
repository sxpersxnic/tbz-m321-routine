import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';

/**
 * Domain manifest: what a domain offers (triggers, actions, values, collections, Today cards).
 * A technical contract like the envelope (docs/v2/04-domain-platform.md §2), so sharing the types
 * does not share a domain model. The JSON Schema next to this file is identical to
 * contracts/schemas/domain-manifest.v1.schema.json (a kit test keeps them in step).
 */

export type Tint = 'sky' | 'indigo' | 'violet' | 'pink' | 'orange' | 'green' | 'teal' | 'grey';

export interface DomainManifest {
  /** Manifest format version (this file). */
  contract: 1;
  /** `budget` */
  domain: string;
  /** Integer ≥ 1, bumped on every change. */
  manifestVersion: number;
  /** `budget-service` – for the Infrastructure page. */
  service: string;
  name: string;
  /** One sentence, shown in "Add a domain". */
  description: string;
  /** Icon name from the web icon set. */
  icon: string;
  tint: Tint;
  /** Default position in the sidebar. */
  order: number;
  /** false = always on (tasks, notifications, routines, scripting, connections). */
  optional: boolean;
  prefixes: string[];
  /** Web route of the domain page, e.g. `/budget`. */
  page?: string;
  collections?: Record<string, CollectionSpec>;
  capabilities: CapabilitySpec[];
  triggers?: TriggerSpec[];
  quickEntry?: QuickEntrySpec[];
  /** Which card kinds this domain publishes. */
  todayCards?: CardKind[];
  /** Single-domain templates (cross-domain ones live in routine-service). */
  templates?: RoutineTemplate[];
}

/** A ready-made routine. `{{setup.<name>}}` placeholders are replaced once, at creation. */
export interface RoutineTemplate {
  /** `budget.monthEndCheck` */
  id: string;
  name: string;
  description: string;
  icon: string;
  tint: Tint;
  /** Domains that must be enabled, e.g. `['budget', 'tasks']`. */
  requires: string[];
  /** At most 3 questions. */
  setup: Array<Pick<ParamSpec, 'name' | 'label' | 'type' | 'required' | 'default' | 'options' | 'ref'>>;
  /** A RoutineInput (docs/v2/06-engine.md §2) that may contain `{{setup.<name>}}`. */
  routine: Record<string, unknown>;
}

export type CapabilityKind = 'action' | 'value' | 'human';

export interface CapabilitySpec {
  /** `budget.recordTransaction` */
  type: string;
  kind: CapabilityKind;
  label: string;
  /** `Record {amount} for {category}` – `{param}` placeholders. */
  sentence: string;
  /** One sentence for the step picker. */
  description: string;
  /** Defaults to the domain icon. */
  icon?: string;
  /** Defaults to the domain tint. */
  tint?: Tint;
  params: ParamSpec[];
  /** What `{{actions.<key>.<field>}}` can read. */
  output: OutputField[];
  /** false for values; true for actions and human steps. */
  sideEffects: boolean;
  /** The action can answer mode `test` with a preview. */
  preview?: boolean;
  /** `defaultTimeout` is an ISO 8601 duration. */
  human?: { awaits: 'task' | 'question' | 'checkIn'; defaultTimeout?: string };
  /** Param names that may contain `{{secrets.<name>}}`. */
  acceptsSecrets?: string[];
  /** manifestVersion that introduced it. */
  since: number;
  deprecated?: Deprecation;
}

export interface Deprecation {
  since: number;
  replacedBy?: string;
  message: string;
}

export type ParamType =
  | 'text'
  | 'longText'
  | 'number'
  | 'integer'
  | 'money'
  | 'boolean'
  | 'date'
  | 'time'
  | 'duration'
  | 'choice'
  | 'ref'
  | 'list'
  | 'object'
  | 'value';

export interface ParamSpec {
  /** `^[a-z][a-zA-Z0-9]*$` */
  name: string;
  label: string;
  type: ParamType;
  required?: boolean;
  default?: unknown;
  /** For `choice`. */
  options?: Array<{ value: string; label: string }>;
  /** For `ref` (value = entity id). */
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
  /** camelCase, money in major units: `remaining`, not `remainingMinor`. */
  name: string;
  label: string;
  type: ParamType;
  /** Shown as the pill's example before a real run exists. */
  example?: unknown;
}

export interface TriggerSpec {
  /** `budget.incomeRecorded` – also the routing key on `domain.events`. */
  type: string;
  label: string;
  /** `When income {filter} is recorded` */
  sentence: string;
  description: string;
  /** Payload fields: filterable, and readable as `{{trigger.event.<field>}}`. */
  fields: OutputField[];
  since: number;
  deprecated?: Deprecation;
}

export interface CollectionSpec {
  label: string;
  /** GET path returning `{ items: [...] }`, e.g. `/api/v1/budget/categories`. */
  list: string;
  idField: string;
  labelField: string;
  iconField?: string;
  tintField?: string;
}

export interface QuickEntrySpec {
  /** `expense` */
  id: string;
  /** Anchored JS regex source with named groups (client-side suggestion only). */
  pattern: string;
  /** POST path receiving `{ text }`, e.g. `/api/v1/budget/transactions/quick`. */
  endpoint: string;
  /** `Record {amount} · {note}` – `{group}` placeholders. */
  label: string;
}

export type CardKind = 'item' | 'checklist' | 'metric' | 'event' | 'question' | 'checkIn' | 'attention' | 'suggestion';

// ---------------------------------------------------------------- validation

export const MANIFEST_SCHEMA_ID = 'https://routine.example/contracts/schemas/domain-manifest.v1.schema.json';

/** The manifest JSON Schema, as shipped with the kit. */
export const manifestSchema: Record<string, unknown> = JSON.parse(
  readFileSync(join(import.meta.dirname, 'domain-manifest.v1.schema.json'), 'utf8'),
);

const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile<DomainManifest>(manifestSchema);

export type ManifestValidation = { valid: true; manifest: DomainManifest } | { valid: false; errors: string[] };

/**
 * Checks a manifest against the schema, then the rules a schema cannot express: every capability and
 * trigger type starts with one of the domain's prefixes and is unique, param names are unique per
 * capability, `choice` params have options and `ref` params a collection.
 */
export function validateManifest(value: unknown): ManifestValidation {
  if (!validateSchema(value)) {
    return { valid: false, errors: (validateSchema.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`) };
  }
  const manifest = value;
  const errors: string[] = [];
  const owned = (type: string) => manifest.prefixes.includes(type.slice(0, type.indexOf('.')));
  const seen = new Set<string>();
  const types = [
    ...manifest.capabilities.map((capability, index) => ({ type: capability.type, path: `/capabilities/${index}` })),
    ...(manifest.triggers ?? []).map((trigger, index) => ({ type: trigger.type, path: `/triggers/${index}` })),
  ];
  for (const { type, path } of types) {
    if (!owned(type)) errors.push(`${path}/type ${type} does not start with one of the prefixes ${manifest.prefixes.join(', ')}`);
    if (seen.has(type)) errors.push(`${path}/type ${type} is declared twice`);
    seen.add(type);
  }
  manifest.capabilities.forEach((capability, index) => {
    const names = new Set<string>();
    capability.params.forEach((param, paramIndex) => {
      const path = `/capabilities/${index}/params/${paramIndex}`;
      if (names.has(param.name)) errors.push(`${path}/name ${param.name} is declared twice`);
      names.add(param.name);
      if (param.type === 'choice' && !param.options?.length) errors.push(`${path} a choice param needs options`);
      if (param.type === 'ref' && !param.ref) errors.push(`${path} a ref param needs ref`);
    });
  });
  return errors.length > 0 ? { valid: false, errors } : { valid: true, manifest };
}

// ---------------------------------------------------------------- digest

/** JSON with object keys sorted recursively; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** SHA-256 (hex) of the manifest's canonical JSON: equal for equal content, whatever the key order. */
export function manifestDigest(manifest: DomainManifest): string {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}
