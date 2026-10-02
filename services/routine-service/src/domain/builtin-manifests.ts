import type { DomainManifest, ParamSpec } from '@routine/service-kit';

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
  manifestVersion: 2,
  service: 'routine-service',
  name: 'Scripting',
  description: 'Variables, conditions and calculations between your steps.',
  icon: 'calc',
  tint: 'grey',
  order: 90,
  optional: false,
  prefixes: ['variable', 'condition', 'math', 'flow'],
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
