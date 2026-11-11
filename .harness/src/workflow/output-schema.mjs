import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadProvider } from './providers/index.mjs';
import { listDeclaredSkills } from './skill-declaration.mjs';

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
  delete result.commit_sha;
  if (IMPLEMENTATION_FLOWS.has(flow)) {
    schema.properties.result.required.push('unplanned_additions', 'commit_request');
    // Implementation only builds the approved Spec: it never asks the user. A missing decision goes back to spec-me.
    for (const target of [schema.properties, result]) if (target.code?.enum) target.code = { ...target.code, enum: target.code.enum.filter((code) => code !== 'USER_DECISION_REQUIRED') };
    if (result.questions) result.questions = { ...result.questions, maxItems: 0 };
  }
  else { delete result.unplanned_additions; delete result.commit_request; }
  // Structured output requires every property; earlier results without these fields stay valid in the stored schema.
  const question = result.questions?.items;
  if (question?.properties?.decision_kind && !question.required.includes('decision_kind')) question.required = [...question.required, 'decision_kind'];
  const option = question?.properties?.options?.items;
  if (option?.properties?.evidence && !option.required.includes('evidence')) option.required = [...option.required, 'evidence'];
  if (result.review_request) {
    // A review can run any sub-agent skill, that is, any skill whose document declares a setup tier.
    const skills = (await listDeclaredSkills(root)).filter((item) => !item.main_session && !(input.skill === 'spec-me' && item.skill === 'spec-review')).map((item) => item.skill);
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
