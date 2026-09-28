import { createHash } from 'node:crypto';
import type { CapabilitySpec, DomainManifest, ParamSpec, TriggerSpec } from '@routine/service-kit';
import { BUILTIN_MANIFESTS } from './builtin-manifests.ts';

/**
 * What routines can use (docs/v2/04-domain-platform.md §4.5): the current manifest of every
 * registered domain. Built from the registry; pure, so validation stays a plain function.
 */

export interface CatalogCapability extends CapabilitySpec {
  domain: string;
  /** `engine`: evaluated by routine-service itself (scripting, routines); `worker`: sent to its domain. */
  runsIn: 'engine' | 'worker';
}

export interface CatalogTrigger extends TriggerSpec {
  domain: string;
}

/** Domains whose capabilities routine-service runs itself. */
const ENGINE_DOMAINS = new Set(['scripting', 'routines']);

/**
 * The v1 worker steps, for as long as their domain hasn't registered a manifest (tasks,
 * notifications and connections do from M2-04 on; after that, only prefixes nobody owns fall back
 * here). Only what v1 validated: the type and its required params.
 */
const V1_FALLBACK: Array<{ type: string; description: string; required: string[] }> = [
  { type: 'weather.get', description: 'Get the current weather from an external service', required: ['city'] },
  { type: 'http.request', description: 'Send an HTTP request to an external service or webhook', required: ['url'] },
  { type: 'summary.generate', description: 'Build a summary from the results of earlier actions', required: ['title'] },
  { type: 'task.create', description: 'Create a task in the task system (optional listId, default list otherwise)', required: ['title'] },
  { type: 'notification.send', description: 'Send a notification to the user', required: ['title'] },
  { type: 'email.send', description: 'Send an e-mail (through the mail provider)', required: ['to', 'subject'] },
];

const V1_DOMAIN: Record<string, string> = { weather: 'connections', http: 'connections', summary: 'connections', email: 'connections', task: 'tasks', notification: 'notifications' };

function fallbackCapability(entry: (typeof V1_FALLBACK)[number]): CatalogCapability {
  const prefix = entry.type.slice(0, entry.type.indexOf('.'));
  return {
    type: entry.type,
    domain: V1_DOMAIN[prefix] ?? prefix,
    runsIn: 'worker',
    kind: 'action',
    label: entry.type,
    sentence: entry.type,
    description: entry.description,
    params: entry.required.map((name): ParamSpec => ({ name, label: name, type: 'value', required: true })),
    output: [],
    sideEffects: true,
    since: 1,
  };
}

const prefixOf = (type: string) => type.slice(0, type.indexOf('.'));

export class Catalog {
  readonly manifests: DomainManifest[];
  readonly digest: string;
  readonly #capabilities = new Map<string, CatalogCapability>();
  readonly #triggers = new Map<string, CatalogTrigger>();

  /** `digests`: domain → manifest digest, for the ETag (computed from the manifests when missing). */
  constructor(manifests: DomainManifest[], digests: Record<string, string> = {}) {
    this.manifests = [...manifests].sort((a, b) => a.order - b.order || a.domain.localeCompare(b.domain));
    const owned = new Set(this.manifests.flatMap((manifest) => manifest.prefixes));
    for (const manifest of this.manifests) {
      const runsIn = ENGINE_DOMAINS.has(manifest.domain) ? 'engine' : 'worker';
      for (const capability of manifest.capabilities) this.#capabilities.set(capability.type, { ...capability, domain: manifest.domain, runsIn });
      for (const trigger of manifest.triggers ?? []) this.#triggers.set(trigger.type, { ...trigger, domain: manifest.domain });
    }
    for (const entry of V1_FALLBACK) {
      if (!owned.has(prefixOf(entry.type))) this.#capabilities.set(entry.type, fallbackCapability(entry));
    }
    const versions = this.manifests
      .map((manifest) => `${manifest.domain}@${manifest.manifestVersion}:${digests[manifest.domain] ?? createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`)
      .sort();
    this.digest = createHash('sha256').update(versions.join('\n')).digest('hex').slice(0, 32);
  }

  capability(type: string): CatalogCapability | undefined {
    return this.#capabilities.get(type);
  }

  trigger(type: string): CatalogTrigger | undefined {
    return this.#triggers.get(type);
  }

  capabilities(): CatalogCapability[] {
    return [...this.#capabilities.values()];
  }

  /** GET /api/v1/action-types (v1): the catalog in the old shape, for clients that still use it. */
  actionTypes() {
    return this.capabilities().map((capability) => ({
      type: capability.type,
      description: capability.description,
      runsIn: capability.runsIn,
      requiredParams: capability.params.filter((param) => param.required).map((param) => param.name),
      example: Object.fromEntries(
        capability.params
          .filter((param) => param.required || param.default !== undefined)
          .map((param) => [param.name, param.default ?? param.placeholder ?? '']),
      ),
    }));
  }
}

/** Only routine-service's own domains (plus the v1 fallback) – for tests and before the registry is read. */
export const BUILTIN_CATALOG = new Catalog(BUILTIN_MANIFESTS);
