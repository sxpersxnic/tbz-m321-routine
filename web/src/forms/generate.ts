import type { ActionForm, FieldKind, ParamField, Tint } from '../action-forms.ts';
import type { Capability, CatalogDomain, ParamSpec } from '../types.ts';

/**
 * Step forms generated from the manifests (docs/v2/07-web.md §5.1): every catalog capability gets a
 * form, a look and a sentence without web code of its own. Hand-made forms stay only where they are
 * better (overrides in action-forms.ts).
 */

/** Domains whose steps steer the run instead of doing something – the palette's "Scripting". */
export const SCRIPTING_DOMAINS = new Set(['scripting', 'routines']);

/** The editor field for a manifest param type. */
function kindOf(param: ParamSpec): FieldKind {
  switch (param.type) {
    case 'longText':
      return 'textarea';
    case 'number':
    case 'integer':
    case 'money':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'choice':
      return 'select';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'ref':
      // the pickers the editor has; a generic collection picker arrives with the first domain that needs one
      if (param.ref?.collection === 'lists' && param.ref.domain === 'tasks') return 'tasklist';
      if (param.ref?.collection === 'routines') return 'routine';
      return 'text';
    case 'object':
      return 'json';
    case 'list':
    case 'value':
      return 'value';
    default:
      return 'text';
  }
}

export function fieldFor(param: ParamSpec): ParamField {
  const kind = kindOf(param);
  return {
    name: param.name,
    label: param.label,
    kind,
    ...(param.required && { required: true }),
    ...(param.options && { options: param.options.map((option) => option.value), optionLabels: Object.fromEntries(param.options.map((option) => [option.value, option.label])) }),
    ...(param.placeholder && { placeholder: param.placeholder }),
    ...(param.hint && { hint: param.hint }),
    ...(param.min !== undefined && { min: param.min }),
    ...(param.type === 'integer' && { integer: true }),
    ...(param.advanced && { advanced: true }),
  };
}

/** A capability's form, look and sentence – everything the editor, pills and flows need. */
export function formFromCapability(capability: Capability, domain: CatalogDomain): ActionForm {
  return {
    label: capability.label,
    blurb: capability.description,
    glyph: capability.icon ?? domain.icon,
    tint: (capability.tint ?? domain.tint) as Tint,
    fields: capability.params.map(fieldFor),
    outputs: Object.fromEntries(capability.output.map((field) => [field.name, field.label])),
    defaults: Object.fromEntries(capability.params.filter((param) => param.default !== undefined).map((param) => [param.name, param.default])),
    ...(SCRIPTING_DOMAINS.has(domain.domain) && { scripting: true }),
    sentence: capability.sentence,
  };
}

/** Every capability of the catalog as a form, keyed by type. */
export function formsFromCatalog(domains: CatalogDomain[]): Record<string, ActionForm> {
  const forms: Record<string, ActionForm> = {};
  for (const domain of domains) for (const capability of domain.capabilities) forms[capability.type] = formFromCapability(capability, domain);
  return forms;
}
