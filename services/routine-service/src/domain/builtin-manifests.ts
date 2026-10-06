import type { CapabilitySpec, DomainManifest, ParamSpec } from '@routine/service-kit';

/**
 * The domains routine-service owns itself (services/routine-service.md §5): `scripting` – steps the
 * engine evaluates in its own transaction – and `routines` – running other routines, and the run
 * events other routines can react to. They register through the same code path as every other
 * domain, in-process at startup.
 */

const CONDITION_OPTIONS: ParamSpec['options'] = [
  { value: 'equals', label: 'is' },
  { value: 'notEquals', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'greaterThan', label: 'is greater than' },
  { value: 'lessThan', label: 'is less than' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'isNotEmpty', label: 'is not empty' },
];

const DIRECTION_OPTIONS: ParamSpec['options'] = [
  { value: 'asc', label: 'A → Z, small → big' },
  { value: 'desc', label: 'Z → A, big → small' },
];

const LIST: ParamSpec = { name: 'list', label: 'List', type: 'list', required: true, hint: 'Usually {{…}} from an earlier step' };
const FIELD: ParamSpec = { name: 'field', label: 'Field', type: 'text', placeholder: 'title', hint: 'Of each item; empty = the item itself', templating: false };

/** Scripting for words and lists (06-engine §9) – evaluated by the engine like the others. */
const TEXT_AND_LISTS: CapabilitySpec[] = [
  {
    type: 'text.format',
    kind: 'value',
    label: 'Text',
    sentence: 'Text {template}',
    description: 'Writes a text from values of earlier steps.',
    icon: 'doc',
    params: [{ name: 'template', label: 'Text', type: 'longText', required: true, placeholder: 'Hi {{vars.name}}, {{actions.weather.summary}}' }],
    output: [{ name: 'text', label: 'Text', type: 'text', example: 'Hi Sam, sunny' }],
    sideEffects: false,
    since: 3,
  },
  {
    type: 'text.replace',
    kind: 'value',
    label: 'Replace text',
    sentence: 'Replace {find} with {replaceWith} in {text}',
    description: 'Swaps words in a text.',
    icon: 'doc',
    params: [
      { name: 'text', label: 'Text', type: 'longText', required: true },
      { name: 'find', label: 'Find', type: 'text', required: true },
      { name: 'replaceWith', label: 'Replace with', type: 'text' },
      { name: 'all', label: 'Every time', type: 'boolean', default: true, advanced: true },
    ],
    output: [{ name: 'text', label: 'Text', type: 'text' }],
    sideEffects: false,
    since: 3,
  },
  {
    type: 'text.split',
    kind: 'value',
    label: 'Split text',
    sentence: 'Split {text} at {separator}',
    description: 'Turns a text into a list – for "Repeat for each".',
    icon: 'doc',
    params: [
      { name: 'text', label: 'Text', type: 'longText', required: true, placeholder: 'milk, bread, eggs' },
      { name: 'separator', label: 'At', type: 'text', default: ',', hint: 'Pieces are trimmed, empty ones left out' },
    ],
    output: [{ name: 'items', label: 'Pieces', type: 'list', example: ['milk', 'bread', 'eggs'] }],
    sideEffects: false,
    since: 3,
  },
  {
    type: 'list.get',
    kind: 'value',
    label: 'Get item',
    sentence: 'Get the {position} item of {list}',
    description: 'Picks one item of a list.',
    icon: 'stack',
    params: [LIST, { name: 'position', label: 'Which', type: 'value', default: 'first', hint: 'first, last, or a number from 1' }],
    output: [{ name: 'item', label: 'Item', type: 'value' }],
    sideEffects: false,
    since: 3,
  },
  {
    type: 'list.count',
    kind: 'value',
    label: 'Count items',
    sentence: 'Count the items of {list}',
    description: 'How many items a list has.',
    icon: 'stack',
    params: [LIST],
    output: [{ name: 'count', label: 'Count', type: 'integer', example: 3 }],
    sideEffects: false,
    since: 3,
  },
  {
    type: 'list.filter',
    kind: 'value',
    label: 'Filter list',
    sentence: 'Keep items of {list} whose {field} {operator} {value}',
    description: 'Keeps the items that match, like an If for each.',
    icon: 'stack',
    params: [LIST, FIELD, { name: 'operator', label: 'Comparison', type: 'choice', required: true, options: CONDITION_OPTIONS, default: 'equals', templating: false }, { name: 'value', label: 'Compared with', type: 'value' }],
    output: [
      { name: 'items', label: 'Items', type: 'list' },
      { name: 'count', label: 'Count', type: 'integer', example: 2 },
    ],
    sideEffects: false,
    since: 3,
  },
  {
    type: 'list.sort',
    kind: 'value',
    label: 'Sort list',
    sentence: 'Sort {list} by {field}, {direction}',
    description: 'Puts the items in order.',
    icon: 'stack',
    params: [LIST, FIELD, { name: 'direction', label: 'Order', type: 'choice', options: DIRECTION_OPTIONS, default: 'asc', templating: false }],
    output: [{ name: 'items', label: 'Items', type: 'list' }],
    sideEffects: false,
    since: 3,
  },
  {
    type: 'json.parse',
    kind: 'value',
    label: 'Read JSON',
    sentence: 'Read JSON from {text}',
    description: 'Turns JSON text (e.g. from a webhook) into values later steps can use.',
    icon: 'doc',
    params: [{ name: 'text', label: 'JSON', type: 'longText', required: true, placeholder: '{"temperature": 21}' }],
    output: [{ name: 'value', label: 'Value', type: 'value' }],
    sideEffects: false,
    since: 3,
  },
];

const MATH_OPTIONS: ParamSpec['options'] = [
  { value: '+', label: '+' },
  { value: '-', label: '−' },
  { value: '*', label: '×' },
  { value: '/', label: '÷' },
  { value: '%', label: 'modulo' },
  { value: 'min', label: 'min' },
  { value: 'max', label: 'max' },
  { value: 'round', label: 'round to digits' },
];

export const SCRIPTING_MANIFEST: DomainManifest = {
  contract: 1,
  domain: 'scripting',
  manifestVersion: 3,
  service: 'routine-service',
  name: 'Scripting',
  description: 'Variables, conditions, calculations, text and lists between your steps.',
  icon: 'calc',
  tint: 'grey',
  order: 90,
  optional: false,
  prefixes: ['variable', 'condition', 'math', 'flow', 'text', 'list', 'json'],
  capabilities: [
    {
      type: 'variable.set',
      kind: 'value',
      label: 'Set variable',
      sentence: 'Set {name} to {value}',
      description: 'Keeps a value under a name, for later steps.',
      icon: 'variable',
      params: [
        { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'city', templating: false },
        { name: 'value', label: 'Value', type: 'value', hint: 'Text, a number, or a list like ["a", "b"]' },
      ],
      output: [
        { name: 'name', label: 'Name', type: 'text' },
        { name: 'value', label: 'Value', type: 'value' },
      ],
      sideEffects: false,
      since: 1,
    },
    {
      type: 'condition.if',
      kind: 'value',
      label: 'If',
      sentence: 'If {left} {operator} {right}',
      description: 'Compares two values – later steps can run only if it holds.',
      icon: 'branch',
      params: [
        { name: 'left', label: 'Value', type: 'value' },
        { name: 'operator', label: 'Comparison', type: 'choice', required: true, options: CONDITION_OPTIONS, default: 'equals', templating: false },
        { name: 'right', label: 'Compared with', type: 'value' },
      ],
      output: [{ name: 'result', label: 'Result', type: 'boolean', example: true }],
      sideEffects: false,
      since: 1,
    },
    {
      type: 'math.calculate',
      kind: 'value',
      label: 'Calculate',
      sentence: 'Calculate {a} {operator} {b}',
      description: 'Adds, subtracts, multiplies, … two numbers.',
      params: [
        { name: 'a', label: 'Number', type: 'value', required: true },
        { name: 'operator', label: 'Operation', type: 'choice', required: true, options: MATH_OPTIONS, default: '+', templating: false },
        { name: 'b', label: 'Number', type: 'value' },
      ],
      output: [{ name: 'result', label: 'Result', type: 'number', example: 42 }],
      sideEffects: false,
      since: 1,
    },
    {
      type: 'flow.wait',
      kind: 'value',
      label: 'Wait',
      sentence: 'Wait for {for} until {until}',
      description: 'Pauses the routine for a while, or until a time of day.',
      icon: 'clock',
      params: [
        { name: 'for', label: 'For', type: 'duration', placeholder: 'PT1H', hint: 'At most 7 days' },
        { name: 'until', label: 'Until', type: 'time', placeholder: '17:00', hint: 'The next time it is this late' },
      ],
      output: [{ name: 'wokeAt', label: 'Woke at', type: 'text' }],
      sideEffects: false,
      since: 2,
    },
    ...TEXT_AND_LISTS,
  ],
};

export const ROUTINES_MANIFEST: DomainManifest = {
  contract: 1,
  domain: 'routines',
  manifestVersion: 1,
  service: 'routine-service',
  name: 'Routines',
  description: 'Run a routine from another one, and react to how runs end.',
  icon: 'routines',
  tint: 'grey',
  order: 80,
  optional: false,
  prefixes: ['routine', 'execution'],
  page: '/routines',
  collections: {
    routines: { label: 'Routines', list: '/api/v1/routines', idField: 'id', labelField: 'name' },
  },
  capabilities: [
    {
      type: 'routine.run',
      kind: 'action',
      label: 'Run routine',
      sentence: 'Run routine {routineId} with {input}',
      description: 'Runs another routine like a function and waits for it.',
      params: [
        { name: 'routineId', label: 'Routine', type: 'ref', required: true, ref: { domain: 'routines', collection: 'routines' }, templating: false },
        { name: 'input', label: 'Input', type: 'value', hint: 'The routine reads it as {{input}}; it returns its variable "result"' },
        // the chosen routine's name, kept next to its id for display
        { name: 'routineName', label: 'Routine name', type: 'text', advanced: true, templating: false },
      ],
      output: [
        { name: 'result', label: 'Result', type: 'value' },
        { name: 'executionId', label: 'Run', type: 'text' },
        { name: 'vars', label: 'Variables', type: 'object' },
      ],
      sideEffects: true,
      since: 1,
    },
  ],
  triggers: [
    {
      type: 'execution.completed',
      label: 'A routine finished',
      sentence: 'When {routineName} finishes',
      description: 'Starts when a run of a routine succeeded.',
      fields: [
        { name: 'routineId', label: 'Routine', type: 'ref' },
        { name: 'routineName', label: 'Routine name', type: 'text' },
      ],
      since: 1,
    },
    {
      type: 'execution.failed',
      label: 'A routine failed',
      sentence: 'When {routineName} fails',
      description: 'Starts when a run of a routine failed.',
      fields: [
        { name: 'routineId', label: 'Routine', type: 'ref' },
        { name: 'routineName', label: 'Routine name', type: 'text' },
        { name: 'errorCode', label: 'Why', type: 'text' },
      ],
      since: 1,
    },
  ],
};

export const BUILTIN_MANIFESTS = [SCRIPTING_MANIFEST, ROUTINES_MANIFEST];
