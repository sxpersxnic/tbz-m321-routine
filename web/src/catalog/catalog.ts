import type { Capability, CatalogDomain, CollectionSpec, TriggerSpec } from '../types.ts';

/** A capability together with the domain that offers it. */
export type CatalogCapability = Capability & { domain: CatalogDomain };
export type CatalogTrigger = TriggerSpec & { domain: CatalogDomain };

/** Lookups over the catalog (docs/v2/07-web.md §4) – pure, so they are unit-tested without a server. */
export interface Catalog {
  domains: CatalogDomain[];
  capability(type: string): CatalogCapability | undefined;
  trigger(type: string): CatalogTrigger | undefined;
  collection(domain: string, name: string): CollectionSpec | undefined;
  /** Whether the user has this domain on (all on until the profile exists, M5). */
  enabled(domain: string): boolean;
  /** Every capability of the enabled domains, in domain order. */
  capabilities(): CatalogCapability[];
}

export function buildCatalog(domains: CatalogDomain[]): Catalog {
  const sorted = [...domains].sort((a, b) => a.order - b.order || a.domain.localeCompare(b.domain));
  const capabilities = new Map<string, CatalogCapability>();
  const triggers = new Map<string, CatalogTrigger>();
  for (const domain of sorted) {
    for (const capability of domain.capabilities) capabilities.set(capability.type, { ...capability, domain });
    for (const trigger of domain.triggers ?? []) triggers.set(trigger.type, { ...trigger, domain });
  }
  const byName = new Map(sorted.map((domain) => [domain.domain, domain]));
  return {
    domains: sorted,
    capability: (type) => capabilities.get(type),
    trigger: (type) => triggers.get(type),
    collection: (domain, name) => byName.get(domain)?.collections?.[name],
    enabled: (domain) => byName.get(domain)?.enabled ?? false,
    capabilities: () => [...capabilities.values()].filter((capability) => capability.domain.enabled),
  };
}

/** What "Try this step" may run (04 §3.4, the server decides the same): values, side-effect-free steps, actions with a preview. */
export function runsInTest(capability: Capability | undefined): boolean {
  if (!capability) return false;
  return capability.kind === 'value' || !capability.sideEffects || (capability.kind === 'action' && capability.preview === true);
}
