import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function writeOutputSchema({ root, input, prefix, path }) {
  const directory = join(root, '.codex/internal-skills/skill-execution/schemas');
  const schema = JSON.parse(await readFile(join(directory, 'return.schema.json'), 'utf8'));
  schema.properties.execution_id = { const: input.execution_id };
  schema.properties.skill = { const: input.skill };
  schema.properties.result_ref = { enum: [`${prefix}/result.json`, null] };
  const flow = input.skill === 'to-ticket' && ['plan_split', 'plan_revision', 'plan_finalize'].includes(input.context?.stage_id) ? `to-ticket-${input.context.stage_id}` : input.skill;
  const resultSchema = flow === 'workflow-compose' ? 'workflow-compose-result.schema.json' : `flows/${['spec-review', 'plan-review'].includes(flow) ? flow : 'common'}.schema.json`;
  schema.properties.result = JSON.parse(await readFile(join(directory, resultSchema), 'utf8'));
  if (!schema.properties.result.required.includes('question')) {
    delete schema.properties.result.properties.question;
    schema.properties.result.required = schema.properties.result.required.filter((key) => key !== 'question');
  }
  const codeDescription = 'completed: OK; action_required: REVIEW_REQUIRED, SPEC_REVISION_REQUIRED, PLAN_REVISION_REQUIRED, IMPLEMENTATION_REVISION_REQUIRED, USER_DECISION_REQUIRED; blocked: ENVIRONMENT_UNAVAILABLE, PERMISSION_REQUIRED, DEPENDENCY_INCOMPLETE, INPUT_MISSING, MODEL_BINDING_UNAVAILABLE; failed: EXECUTION_ERROR, INVALID_INPUT, ARTIFACT_WRITE_FAILED; cancelled: CANCELLED. Envelope and result status/code must match.';
  schema.properties.code.description = codeDescription;
  schema.properties.result.properties.code.description = codeDescription;
  const result = schema.properties.result.properties;
  if (result.review_request) {
    const bindings = JSON.parse(await readFile(join(root, '.codex/internal-skills/skill-execution/bindings.json'), 'utf8'));
    const skills = Object.keys(bindings.skills).filter((skill) => !bindings.main_session_skills?.includes(skill));
    const profiles = (await readdir(join(root, '.codex/agents'))).filter((name) => name.endsWith('.toml')).map((name) => name.slice(0, -5));
    const item = result.review_request.anyOf.find((shape) => shape.type === 'object');
    item.properties.skill = { type: 'string', enum: skills, description: '실행할 skill ID' };
    item.properties.agent_profile = { type: item.properties.role.type, enum: item.properties.role.type.includes('null') ? [...profiles, 'default', null] : [...profiles, 'default'], description: '.codex/agents의 agent 프로필 ID' };
    delete item.properties.role;
    item.required = item.required.map((key) => key === 'role' ? 'agent_profile' : key);
  }
  const profile = input.context?.agent_profile || input.context?.role;
  if (profile) {
    const text = await readFile(join(root, '.codex/agents', `${profile}.toml`), 'utf8');
    if (/^sandbox_mode\s*=\s*"read-only"\s*$/m.test(text)) {
      result.artifact_contents = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'kind', 'content'], properties: { name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' }, kind: { type: 'string', minLength: 1 }, content: { type: 'string' } } } };
      schema.properties.result.required.push('artifact_contents');
    }
  }
  delete schema.$schema;
  delete schema.properties.result.$schema;
  if (!schema.required.includes('result')) schema.required.push('result');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(schema, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
