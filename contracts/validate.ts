/**
 * Contract-test helper: validates a message against the JSON Schemas in
 * contracts/schemas. Used only by tests – services never import contract code.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;
const schemaDir = join(import.meta.dirname, 'schemas');
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

for (const file of readdirSync(schemaDir).filter((name) => name.endsWith('.schema.json'))) {
  ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, file), 'utf8')));
}

export function contractErrors(schemaFile: string, message: unknown): string[] {
  const validate = ajv.getSchema(`https://routine.example/contracts/schemas/${schemaFile}`);
  if (!validate) throw new Error(`unknown contract schema ${schemaFile}`);
  if (validate(message)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`);
}
