import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadProvider } from './providers/index.mjs';

// 구현 stage만 Spec 밖 동작을 구조화해 신고한다. 과거 결과 호환을 위해 저장 스키마에서는 선택으로 둔다.
const IMPLEMENTATION_FLOWS = new Set(['implement', 'implement-wrapper']);

export async function writeOutputSchema({ root, input, prefix, path, provider = 'codex' }) {
  const directory = join(root, '.codex/internal-skills/skill-execution/schemas');
  const schema = JSON.parse(await readFile(join(directory, 'return.schema.json'), 'utf8'));
  schema.properties.execution_id = { const: input.execution_id };
  schema.properties.skill = { const: input.skill };
  delete schema.properties.result_ref;
  schema.required = schema.required.filter((key) => key !== 'result_ref');
  const flow = input.skill;
  const resultSchema = flow === 'workflow-compose' ? 'workflow-compose-result.schema.json' : `flows/${['spec-review', 'plan-review'].includes(flow) ? flow : 'common'}.schema.json`;
  schema.properties.result = JSON.parse(await readFile(join(directory, resultSchema), 'utf8'));
  const result = schema.properties.result.properties;
  if (IMPLEMENTATION_FLOWS.has(flow)) schema.properties.result.required.push('unplanned_additions');
  else delete result.unplanned_additions;
  if (result.review_request) {
    const bindings = JSON.parse(await readFile(join(root, '.codex/internal-skills/skill-execution/bindings.json'), 'utf8'));
    const skills = Object.keys(bindings.skills).filter((skill) => !bindings.main_session_skills?.includes(skill) && !(input.skill === 'spec-me' && skill === 'spec-review'));
    const profiles = (await readdir(join(root, '.codex/agents'))).filter((name) => name.endsWith('.toml')).map((name) => name.slice(0, -5));
    const item = result.review_request.anyOf.find((shape) => shape.type === 'object');
    item.properties.skill = { type: 'string', enum: skills, description: '실행할 skill ID' };
    item.properties.context_path.description = 'Path to a session-relative JSON file containing the review context, not a workspace document or directory.';
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
  const adapter = await loadProvider(provider);
  const providerSchema = adapter.prepareOutputSchema ? adapter.prepareOutputSchema(schema) : schema;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(providerSchema, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
