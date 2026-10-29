import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeOutputSchema({ root, input, prefix, path }) {
  const directory = join(root, '.codex/internal-skills/skill-execution/schemas');
  const schema = JSON.parse(await readFile(join(directory, 'return.schema.json'), 'utf8'));
  schema.properties.execution_id = { const: input.execution_id };
  schema.properties.skill = { const: input.skill };
  schema.properties.result_ref = { enum: [`${prefix}/result.json`, null] };
  const flow = input.skill === 'to-ticket' && ['plan_split', 'plan_revision', 'plan_finalize'].includes(input.context?.stage_id) ? `to-ticket-${input.context.stage_id}` : input.skill;
  const resultSchema = flow === 'workflow-compose' ? 'workflow-compose-result.schema.json' : `flows/${flow}.schema.json`;
  schema.properties.result = JSON.parse(await readFile(join(directory, resultSchema), 'utf8'));
  delete schema.$schema;
  delete schema.properties.result.$schema;
  if (!schema.required.includes('result')) schema.required.push('result');
  await writeFile(path, JSON.stringify(schema, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
