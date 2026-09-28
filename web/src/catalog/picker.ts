import { actionLabel } from '../action-forms.ts';
import { SCRIPTING_DOMAINS } from '../forms/generate.ts';
import type { Catalog, CatalogCapability } from './catalog.ts';

/**
 * The step picker (02 §6, 07 §5.4): *Suggested* – steps the previous step's outputs can fill, at most
 * three –, *You* (human steps), one group per enabled domain in domain order, *Scripting* last.
 * Search matches label, description and domain name; while searching there are no suggestions.
 */
export interface PickerItem {
  type: string;
  label: string;
  description: string;
  /** Why it is suggested: `after "Create task"`. */
  hint?: string;
}

export interface PickerGroup {
  id: string;
  label: string;
  items: PickerItem[];
}

const MAX_SUGGESTED = 3;

const itemOf = (capability: CatalogCapability): PickerItem => ({ type: capability.type, label: actionLabel(capability.type), description: capability.description });

/** Capabilities with a required param the previous step outputs (by name) – own domain first, then by how much fits. */
function suggestions(capabilities: CatalogCapability[], previous: CatalogCapability): CatalogCapability[] {
  const outputs = new Set(previous.output.map((field) => field.name));
  const fits = (capability: CatalogCapability) => capability.params.filter((param) => param.templating !== false && outputs.has(param.name));
  return capabilities
    .filter((capability) => capability.type !== previous.type && capability.kind !== 'human')
    .map((capability, index) => ({ capability, index, all: fits(capability) }))
    .map((entry) => ({ ...entry, required: entry.all.filter((param) => param.required).length }))
    .filter((entry) => entry.required > 0)
    .sort((a, b) =>
      b.required - a.required ||
      Number(b.capability.domain.domain === previous.domain.domain) - Number(a.capability.domain.domain === previous.domain.domain) ||
      b.all.length - a.all.length ||
      a.index - b.index,
    )
    .slice(0, MAX_SUGGESTED)
    .map((entry) => entry.capability);
}

export function pickerGroups(catalog: Catalog, { query = '', previousType }: { query?: string; previousType?: string } = {}): PickerGroup[] {
  const needle = query.trim().toLowerCase();
  const all = catalog.capabilities();
  const matching = needle
    ? all.filter((capability) => [actionLabel(capability.type), capability.label, capability.description, capability.domain.name].some((text) => text.toLowerCase().includes(needle)))
    : all;

  const groups: PickerGroup[] = [];
  const previous = previousType ? catalog.capability(previousType) : undefined;
  if (!needle && previous) {
    const label = actionLabel(previous.type);
    groups.push({ id: 'suggested', label: 'Suggested', items: suggestions(all, previous).map((capability) => ({ ...itemOf(capability), hint: `after "${label}"` })) });
  }
  groups.push({ id: 'you', label: 'You', items: matching.filter((capability) => capability.kind === 'human').map(itemOf) });
  for (const domain of catalog.domains) {
    if (SCRIPTING_DOMAINS.has(domain.domain) || !domain.enabled) continue;
    groups.push({ id: domain.domain, label: domain.name, items: matching.filter((capability) => capability.domain === domain && capability.kind !== 'human').map(itemOf) });
  }
  groups.push({ id: 'scripting', label: 'Scripting', items: matching.filter((capability) => SCRIPTING_DOMAINS.has(capability.domain.domain) && capability.kind !== 'human').map(itemOf) });
  return groups.filter((group) => group.items.length > 0);
}
