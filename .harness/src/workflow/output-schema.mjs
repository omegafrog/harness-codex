import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadProvider } from './providers/index.mjs';
import { listDeclaredSkills } from './skill-declaration.mjs';

// 구현 stage만 Spec 밖 동작을 구조화해 신고한다. 과거 결과 호환을 위해 저장 스키마에서는 선택으로 둔다.
const IMPLEMENTATION_FLOWS = new Set(['implement', 'implement-wrapper']);

export async function writeOutputSchema({ root, input, prefix, path, provider = 'codex' }) {
  const directory = join(root, '.codex/internal-skills/skill-execution/schemas');
  const schema = JSON.parse(await readFile(join(directory, 'return.schema.json'), 'utf8'));
  delete schema.properties.execution_id;
  schema.required = schema.required.filter((key) => key !== 'execution_id');
  schema.properties.skill = { const: input.skill };
  delete schema.properties.result_ref;
  schema.required = schema.required.filter((key) => key !== 'result_ref');
  const flow = input.skill;
  const resultSchema = flow === 'workflow-compose' ? 'workflow-compose-result.schema.json' : `flows/${['spec-review', 'plan-review'].includes(flow) ? flow : 'common'}.schema.json`;
  schema.properties.result = JSON.parse(await readFile(join(directory, resultSchema), 'utf8'));
  const result = schema.properties.result.properties;
  delete result.execution_id;
  schema.properties.result.required = schema.properties.result.required.filter((key) => key !== 'execution_id');
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
  try { await writeFile(path, JSON.stringify(providerSchema, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Output schema must be a regular unshared file');
    if (!isDeepStrictEqual(JSON.parse(await readFile(path, 'utf8')), providerSchema)) throw new Error('Existing output schema does not match the execution');
  }
}

// Validate only JSON shape; execution identity, artifacts and lifecycle remain separate checks.
export function validateOutputFormat(value, schema) {
  const check = (item, shape, path) => {
    const errors = [];
    const add = (rule, expected, actual = item) => errors.push({ path, rule, expected, value: actual === undefined ? null : actual, ...(actual === undefined ? { missing: true } : {}) });
    const allowed = new Set(['$schema', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minLength', 'pattern', 'oneOf', 'anyOf', 'minItems', 'maxItems', 'uniqueItems', 'description', 'title']);
    for (const key of Object.keys(shape)) if (!allowed.has(key)) throw new Error(`Unsupported schema constraint: ${key}`);
    for (const key of ['anyOf', 'oneOf']) if (shape[key]) {
      const branches = shape[key].map((branch) => check(item, branch, path));
      const matches = branches.filter((branch) => branch.length === 0).length;
      if (key === 'anyOf' ? matches === 0 : matches !== 1) {
        const currentType = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
        const typed = shape[key].map((branch, index) => ({ branch, errors: branches[index] })).filter(({ branch }) => !branch.type || [branch.type].flat().includes(currentType));
        const best = (typed.length ? typed.map(({ errors }) => errors) : branches).slice().sort((a, b) => a.length - b.length)[0];
        if (best?.length) errors.push(...best); else add(key, key === 'oneOf' ? 'exactly one matching shape' : 'a matching shape');
      }
    }
    if ('const' in shape && item !== shape.const) add('const', shape.const);
    if (shape.enum && !shape.enum.includes(item)) add('enum', shape.enum);
    const type = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
    if (shape.type && ![shape.type].flat().includes(type)) { add('type', shape.type); return errors; }
    if (type === 'string') {
      if (shape.minLength && item.length < shape.minLength) add('minLength', shape.minLength);
      if (shape.pattern && !new RegExp(shape.pattern).test(item)) add('pattern', shape.pattern);
    }
    if (type === 'object') {
      for (const key of shape.required || []) if (!Object.hasOwn(item, key)) errors.push({ path: `${path}.${key}`, rule: 'required', expected: true, value: null, missing: true });
      for (const [key, value] of Object.entries(item)) {
        if (shape.properties?.[key]) errors.push(...check(value, shape.properties[key], `${path}.${key}`));
        else if (shape.additionalProperties === false) errors.push({ path: `${path}.${key}`, rule: 'additionalProperties', expected: false, value });
      }
    }
    if (type === 'array') {
      if (shape.minItems !== undefined && item.length < shape.minItems) add('minItems', shape.minItems);
      if (shape.maxItems !== undefined && item.length > shape.maxItems) add('maxItems', shape.maxItems);
      if (shape.uniqueItems && new Set(item.map((entry) => JSON.stringify(entry))).size !== item.length) add('uniqueItems', true);
      if (shape.items) item.forEach((entry, index) => errors.push(...check(entry, shape.items, `${path}[${index}]`)));
    }
    return errors;
  };
  const errors = check(value, schema, '$');
  return { valid: errors.length === 0, errors };
}
