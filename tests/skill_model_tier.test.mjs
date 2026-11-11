import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AGENT_TIERS, tierSettingKeys } from '../.harness/src/workflow/agent-config.mjs';
import { resolveSkillBinding } from '../.harness/src/workflow/skill-execution.mjs';
import { listDeclaredSkills, parseSkillDeclaration, readSkillDeclaration, stripSkillDeclaration } from '../.harness/src/workflow/skill-declaration.mjs';
import { loadNamedWorkflow, loadWorkflowText } from '../.harness/src/workflow/loader.mjs';
import { writeOutputSchema } from '../.harness/src/workflow/output-schema.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';

const sourceRoot = resolve('.');
const BINDINGS = '.codex/internal-skills/skill-execution/bindings.json';
const SETUP = `agents:
  provider: codex
  codex:
    high_performance_model: codex-high
    high_performance_reasoning_effort: high
    implementation_model: codex-implementation
    implementation_reasoning_effort: medium
    execution_model: codex-execution
    execution_reasoning_effort: low
    low_performance_model: codex-light
    low_performance_reasoning_effort: minimal
  claude-code:
    high_performance_model: opus
    high_performance_reasoning_effort: high
    implementation_model: sonnet
    implementation_reasoning_effort: medium
    execution_model: sonnet
    execution_reasoning_effort: low
    low_performance_model: haiku
    low_performance_reasoning_effort: low
tracker:
  mode: local-markdown
  local_markdown:
    directory: docs/plans
`;
// Every skill the retired skill-execution/bindings.json registered; each now declares its tier in its own document.
const FORMER_REGISTRY = [
  'architecture-review', 'architecture-spec', 'attention-span', 'beads', 'code-research', 'code-review', 'codebase-design', 'correct', 'ddd-design',
  'diagnosing-bugs', 'domain-modeling', 'e2e-test', 'eli5', 'evaluate-harness', 'event-storming', 'frontend-design', 'frontend-figma', 'frontend-implement',
  'frontend-visual-review', 'gh-open-pr', 'grill-with-docs', 'grilling', 'harness-maintenance', 'harness-recover', 'implement', 'implement-wrapper',
  'knowledge-harvest', 'maintain-verification', 'plan-review', 'plantuml-diagrams', 'product-spec', 'session-worktree', 'setup', 'spec-me', 'spec-review',
  'sync-contracts', 'to-ticket', 'tracker-publish', 'victorialogs-local-setup', 'workflow-compose', 'worktree-create',
];

// Skills added after the registry was retired; each declares its tier in its own document from the start.
const DECLARED_SINCE_REGISTRY = ['contract-review'];

const sha256 = (content) => createHash('sha256').update(content).digest('hex');
const guide = (tier, body = '# skill\n') => `---\nmodel_tier: ${tier}\n---\n${body}`;

async function fixture(skills, setup = SETUP) {
  const root = await mkdtemp(join(tmpdir(), 'skill-tier-'));
  await mkdir(join(root, '.codex'), { recursive: true });
  await writeFile(join(root, '.codex/harness.yaml'), setup);
  for (const [name, text] of Object.entries(skills)) {
    await mkdir(join(root, '.codex/internal-skills', name), { recursive: true });
    await writeFile(join(root, '.codex/internal-skills', name, 'GUIDE.md'), text);
  }
  return root;
}

async function install() {
  const root = await mkdtemp(join(tmpdir(), 'skill-tier-consumer-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  await protectLocalInstallArtifacts(root, sourceRoot);
  const installed = await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  await writeFile(join(root, '.codex/harness.yaml'), SETUP);
  return { root, git, installed };
}

// Shapes a consumer installed before the change: no declarations in the skill documents, plus the old registry file.
async function makeLegacyConsumer(root, { bindings = '{"schema_version":1,"skills":{"spec-me":"high_performance","plantuml-diagrams":"low"},"main_session_skills":["orchestrator"]}\n', locked = true } = {}) {
  const lockPath = join(root, '.codex/harness-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  for (const path of Object.keys(lock.files)) {
    if (!/(^\.codex\/internal-skills\/[^/]+\/GUIDE\.md|^\.(agents|claude)\/skills\/[^/]+\/SKILL\.md)$/.test(path)) continue;
    const stripped = stripSkillDeclaration(await readFile(join(root, path), 'utf8'));
    await writeFile(join(root, path), stripped);
    lock.files[path].installed_sha256 = lock.files[path].upstream_sha256 = sha256(stripped);
  }
  await writeFile(join(root, BINDINGS), bindings);
  if (locked) lock.files[BINDINGS] = { installed_sha256: sha256(bindings), upstream_sha256: sha256(bindings), source_path: BINDINGS };
  await writeFile(lockPath, JSON.stringify(lock, null, 2));
  return bindings;
}

test('every skill the retired registry listed declares its tier in its own document, and the orchestrator is main-session only', async () => {
  for (const skill of FORMER_REGISTRY) {
    const declaration = await readSkillDeclaration({ root: sourceRoot, skill });
    assert.ok(AGENT_TIERS.includes(declaration.model_tier), `${skill} declares ${declaration.model_tier}`);
  }
  assert.equal((await readSkillDeclaration({ root: sourceRoot, skill: 'orchestrator' })).main_session, true);
  // The tiers carried over from the registry, with its `low` renamed to the setup tier `low_performance`.
  const expected = { 'plantuml-diagrams': 'low_performance', 'architecture-spec': 'low_performance', 'spec-me': 'high_performance', implement: 'implementation', 'e2e-test': 'execution', setup: 'execution', eli5: 'low_performance', 'sync-contracts': 'implementation' };
  for (const [skill, tier] of Object.entries(expected)) assert.equal((await readSkillDeclaration({ root: sourceRoot, skill })).model_tier, tier, skill);
  const declared = (await listDeclaredSkills(sourceRoot)).filter((item) => !item.main_session).map((item) => item.skill);
  assert.deepEqual(declared, [...FORMER_REGISTRY, ...DECLARED_SINCE_REGISTRY].sort(), 'a skill document declares a tier that neither the retired registry nor the later additions list, or the reverse');
  assert.equal((await readSkillDeclaration({ root: sourceRoot, skill: 'contract-review' })).model_tier, 'high_performance');
  assert.equal((await readdir(join(sourceRoot, '.codex/internal-skills/skill-execution'))).includes('bindings.json'), false);
});

test("a skill's tier comes from its own declaration and maps to agents.<provider>.<tier>_model", async () => {
  const root = await fixture({ high: guide('high_performance'), impl: guide('implementation'), exec: guide('execution'), light: guide('low_performance') });
  try {
    const expected = { high: ['high_performance', 'codex-high', 'high'], impl: ['implementation', 'codex-implementation', 'medium'], exec: ['execution', 'codex-execution', 'low'], light: ['low_performance', 'codex-light', 'minimal'] };
    for (const [skill, [tier, model, effort]] of Object.entries(expected)) {
      assert.deepEqual(await resolveSkillBinding({ root, skill }), { skill, provider: 'codex', model_tier: tier, model, reasoning_effort: effort });
    }
    assert.deepEqual(tierSettingKeys('low_performance'), { model: 'low_performance_model', reasoning_effort: 'low_performance_reasoning_effort' });
    assert.throws(() => tierSettingKeys('low'), /Unknown model tier: low/);
    // The active provider's section is the one that is read.
    await writeFile(join(root, '.codex/harness.yaml'), SETUP.replace('provider: codex', 'provider: claude-code'));
    assert.deepEqual(await resolveSkillBinding({ root, skill: 'light' }), { skill: 'light', provider: 'claude-code', model_tier: 'low_performance', model: 'haiku', reasoning_effort: 'low' });
    // Editing the declaration changes the tier and nothing else does.
    await writeFile(join(root, '.codex/internal-skills/light/GUIDE.md'), guide('high_performance'));
    assert.equal((await resolveSkillBinding({ root, skill: 'light' })).model, 'opus');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a skill whose document declares no usable tier fails resolution with a clear error', async () => {
  const root = await fixture({
    plain: '# plain\n',
    framed: '---\nname: framed\n---\n# framed\n',
    legacy: guide('low'),
    both: '---\nmodel_tier: execution\nmain_session: true\n---\n',
    twice: '---\nmodel_tier: execution\nmodel_tier: execution\n---\n',
    session: '---\nmain_session: true\n---\n',
    ok: guide('execution'),
  });
  try {
    for (const skill of ['plain', 'framed']) await assert.rejects(resolveSkillBinding({ root, skill }), new RegExp(`Skill ${skill} declares no model_tier in \\.codex/internal-skills/${skill}/GUIDE\\.md; add`));
    await assert.rejects(resolveSkillBinding({ root, skill: 'legacy' }), /Invalid model declaration for skill legacy .*model_tier must be one of high_performance, implementation, execution, low_performance, not "low"/);
    await assert.rejects(resolveSkillBinding({ root, skill: 'both' }), /cannot both be declared/);
    await assert.rejects(resolveSkillBinding({ root, skill: 'twice' }), /model_tier is declared twice/);
    await assert.rejects(resolveSkillBinding({ root, skill: 'session' }), /session runs in the main session and cannot be bound as a subagent/);
    await assert.rejects(resolveSkillBinding({ root, skill: 'nothing' }), /Unregistered skill: nothing/);
    await assert.rejects(resolveSkillBinding({ root, skill: '../escape' }), /Unregistered skill: \.\.\/escape/);
    // The tier is known but setup never wrote its values: that is an error, not a default.
    await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  codex:\n    high_performance_model: codex-high\n');
    await assert.rejects(resolveSkillBinding({ root, skill: 'ok' }), /Missing or invalid model binding: agents\.codex\.execution_model/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the declaration sits beside the existing frontmatter of a public skill and never reaches the stage prompt', () => {
  const skill = '---\nname: eli5\ndescription: Explain: simply\nmodel_tier: low_performance\n---\n\n# eli5\n';
  assert.deepEqual(parseSkillDeclaration(skill), { model_tier: 'low_performance' });
  assert.equal(stripSkillDeclaration(skill), '---\nname: eli5\ndescription: Explain: simply\n---\n\n# eli5\n');
  assert.deepEqual(parseSkillDeclaration('---\nname: orchestrator\nmain_session: true\n---\n'), { main_session: true });
  assert.throws(() => parseSkillDeclaration('---\nmain_session: false\n---\n'), /main_session must be true/);
  // An internal GUIDE has nothing but the declaration, so the delivered text is exactly the document without it.
  const original = '<!-- 내부 workflow 전용. -->\n\n# guide\n';
  assert.equal(stripSkillDeclaration(guide('execution', original)), original);
  assert.equal(stripSkillDeclaration(guide('execution', '\n# guide\n')), '\n# guide\n');
  assert.equal(stripSkillDeclaration(original), original);
  assert.equal(parseSkillDeclaration(original), null);
  assert.equal(parseSkillDeclaration('# guide\n---\nmodel_tier: execution\n---\n'), null);
});

test('a workflow stage may override the tier only with one of setup\'s four names', async () => {
  const stage = (tier) => `schema_version: 1\nid: tiers\nroles: [r]\nskills: [light]\nhooks: {}\nstages:\n  - id: only\n    role: r\n    skill: light\n${tier ? `    model_tier: ${tier}\n` : ''}`;
  for (const tier of AGENT_TIERS) assert.equal(loadWorkflowText(stage(tier), {}).stages[0].model_tier, tier);
  assert.throws(() => loadWorkflowText(stage('low'), {}), /stages\[0\]\.model_tier must be one of: high_performance, implementation, execution, low_performance/);
  const root = await fixture({ light: guide('low_performance') });
  try {
    await mkdir(join(root, '.codex/agents'), { recursive: true });
    await mkdir(join(root, '.codex/workflows'), { recursive: true });
    await writeFile(join(root, '.codex/agents/r.toml'), 'name = "r"\n');
    await writeFile(join(root, '.codex/workflows/tiers.yaml'), stage('execution'));
    assert.equal((await loadNamedWorkflow('tiers', { root })).stages[0].model_tier, 'execution');
    const binding = await resolveSkillBinding({ root, skill: 'light', workflow: 'tiers', stage: 'only' });
    assert.deepEqual([binding.model_tier, binding.model, binding.reasoning_effort], ['execution', 'codex-execution', 'low']);
    await writeFile(join(root, '.codex/workflows/tiers.yaml'), stage(null));
    assert.equal((await resolveSkillBinding({ root, skill: 'light', workflow: 'tiers', stage: 'only' })).model_tier, 'low_performance');
  } finally { await rm(root, { recursive: true, force: true }); }
  for (const name of await readdir(join(sourceRoot, '.codex/workflows'))) {
    assert.doesNotMatch(await readFile(join(sourceRoot, '.codex/workflows', name), 'utf8'), /model_tier: low$/m, `${name} still uses the retired tier name`);
  }
});

test('a review request can name any skill that declares a tier and the generated schema lists exactly those', async () => {
  const root = await fixture({ reviewer: guide('implementation'), other: guide('execution'), undeclared: '# no declaration\n' });
  try {
    await mkdir(join(root, '.codex/agents'), { recursive: true });
    await writeFile(join(root, '.codex/agents/plan_reviewer.toml'), 'name = "plan_reviewer"\n');
    // writeOutputSchema reads the return schemas under the root, so give the fixture a copy of the two it needs.
    const schemas = join(sourceRoot, '.codex/internal-skills/skill-execution/schemas');
    await mkdir(join(root, '.codex/internal-skills/skill-execution/schemas/flows'), { recursive: true });
    for (const name of ['return.schema.json', 'flows/common.schema.json']) await writeFile(join(root, '.codex/internal-skills/skill-execution/schemas', name), await readFile(join(schemas, name)));
    await mkdir(join(root, '.codex/skills/main'), { recursive: true });
    await writeFile(join(root, '.codex/skills/main/SKILL.md'), '---\nname: main\nmain_session: true\n---\n');
    const path = join(root, 'schema.json');
    await writeOutputSchema({ root, input: { execution_id: 'e1', skill: 'to-ticket', context: {} }, prefix: 'e1', path });
    const schema = JSON.parse(await readFile(path, 'utf8'));
    const request = schema.properties.result.properties.review_request.anyOf.find((shape) => shape.type === 'object');
    assert.deepEqual(request.properties.skill.enum, ['other', 'reviewer']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('nothing but the retired input property mentions a stage-input sub-agent binding', async () => {
  const offenders = [];
  const walk = async (directory) => {
    for (const entry of await readdir(join(sourceRoot, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (/\.(mjs|md|toml|json|yaml)$/.test(entry.name) && (await readFile(join(sourceRoot, path), 'utf8')).includes('subagent_binding')) offenders.push(path);
    }
  };
  for (const directory of ['.harness', '.codex', '.claude', 'bin']) await walk(directory);
  assert.deepEqual(offenders.filter((path) => path !== '.codex/harness-lock.json'), ['.codex/internal-skills/skill-execution/schemas/input.schema.json']);
  const schema = JSON.parse(await readFile(join(sourceRoot, '.codex/internal-skills/skill-execution/schemas/input.schema.json'), 'utf8'));
  const retired = schema.properties.context.properties.subagent_binding;
  assert.match(retired.description, /Retired: no runner writes this any more/);
  assert.ok(!(schema.properties.context.required || []).includes('subagent_binding'), 'old inputs that carry it stay valid, new ones need not');
  // Both sub-agent launch rules ask the binding command instead.
  for (const path of ['.codex/internal-skills/plantuml-diagrams/GUIDE.md', '.codex/agents/spec_document_writer.toml']) {
    const text = await readFile(join(sourceRoot, path), 'utf8');
    assert.match(text, /harness-skill-execution\.mjs binding --root <workspace_root> --skill /, path);
    assert.match(text, /(실패하면 멈추고 부모 모델을 상속하지 않는다|never inherit the parent model)/, path);
  }
});

test('installed consumer: the binding command returns setup\'s values for a sub-agent skill and refuses the main-session skill', async () => {
  const { root } = await install();
  try {
    const binding = (skill) => spawnSync(process.execPath, [join(root, '.codex/scripts/harness-skill-execution.mjs'), 'binding', '--root', root, '--skill', skill], { cwd: root, encoding: 'utf8' });
    for (const skill of ['plantuml-diagrams', 'architecture-spec', 'product-spec']) {
      const result = binding(skill);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { skill, provider: 'codex', model_tier: 'low_performance', model: 'codex-light', reasoning_effort: 'minimal' });
    }
    assert.equal(JSON.parse(binding('implement').stdout).model, 'codex-implementation');
    const main = binding('orchestrator');
    assert.notEqual(main.status, 0);
    assert.match(main.stderr, /orchestrator runs in the main session and cannot be bound as a subagent/);
    // A skill whose declaration is gone stops the caller instead of falling back to a default model.
    await writeFile(join(root, '.codex/internal-skills/plantuml-diagrams/GUIDE.md'), '# no declaration\n');
    const missing = binding('plantuml-diagrams');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Skill plantuml-diagrams declares no model_tier/);
    assert.equal(missing.stdout, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed consumer: a fresh install has no bindings.json, resolves from declarations, passes Doctor and keeps git status clean of Harness files', async () => {
  const { root, git, installed } = await install();
  try {
    await assert.rejects(readFile(join(root, BINDINGS)), { code: 'ENOENT' });
    assert.equal(Object.hasOwn(JSON.parse(await readFile(join(root, '.codex/harness-lock.json'), 'utf8')).files, BINDINGS), false);
    assert.equal(installed.added.includes(BINDINGS), false);
    assert.doesNotMatch(await readFile(join(root, '.git/info/exclude'), 'utf8'), /bindings\.json/);
    for (const provider of ['.agents', '.claude']) assert.deepEqual(parseSkillDeclaration(await readFile(join(root, provider, 'skills/eli5/SKILL.md'), 'utf8')), { model_tier: 'low_performance' });
    assert.equal((await readSkillDeclaration({ root, skill: 'orchestrator' })).main_session, true);
    assert.deepEqual((await resolveSkillBinding({ root, skill: 'spec-me' })).model_tier, 'high_performance');
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'project-owned execution notes\n');
    await writeFile(join(root, 'app.js'), 'export const application = true;\n');
    const doctor = await runDoctor({ root, sourceRoot });
    assert.deepEqual(doctor.diagnostics.filter((item) => item.severity === 'error' && /^(skill_model_tier|execution_)/.test(item.code)), []);
    assert.equal(doctor.diagnostics.some((item) => item.code === 'installer_retired_file' || item.code === 'installer_stale_lock_entry'), false);
    const status = git('status', '--short', '--untracked-files=all');
    assert.match(status, /app\.js/);
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.doesNotMatch(status, /\.codex\/|\.agents\/|\.claude\/|\.harness\/src\//);
    git('check-ignore', '-v', '.codex/internal-skills/plantuml-diagrams/GUIDE.md');
    git('check-ignore', '-v', '.agents/skills/eli5/SKILL.md');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed consumer: an update of a consumer that still has bindings.json removes it and restores the declarations', async () => {
  const { root, git } = await install();
  try {
    const stale = await makeLegacyConsumer(root);
    // The old consumer ignored the registry file by name; that ignore entry is harmless once the file is gone.
    await appendFile(join(root, '.git/info/exclude'), `/${BINDINGS}\n`);
    // The new runtime does not read the registry: documents without declarations fail instead of being looked up there.
    await assert.rejects(resolveSkillBinding({ root, skill: 'plantuml-diagrams' }), /Skill plantuml-diagrams declares no model_tier/);

    const updated = await updateProject({ sourceRoot, targetRoot: root });
    assert.ok(updated.retired.includes(BINDINGS));
    await assert.rejects(readFile(join(root, BINDINGS)), { code: 'ENOENT' });
    assert.equal(await readFile(join(updated.backup_directory, BINDINGS), 'utf8'), stale);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(join(root, '.codex/harness-lock.json'), 'utf8')).files, BINDINGS), false);
    assert.deepEqual((await resolveSkillBinding({ root, skill: 'plantuml-diagrams' })).model_tier, 'low_performance');
    assert.equal((await resolveSkillBinding({ root, skill: 'sync-contracts' })).model, 'codex-implementation');
    assert.deepEqual((await readSkillDeclaration({ root, skill: 'orchestrator' })).main_session, true);

    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'project-owned execution notes\n');
    await writeFile(join(root, 'app.js'), 'export const application = true;\n');
    const doctor = await runDoctor({ root, sourceRoot });
    assert.deepEqual(doctor.diagnostics.filter((item) => item.severity === 'error' && /^(skill_model_tier|execution_)/.test(item.code)), []);
    assert.equal(doctor.diagnostics.some((item) => item.code === 'installer_retired_file' && item.path.endsWith('bindings.json')), false);
    const status = git('status', '--short', '--untracked-files=all');
    assert.match(status, /app\.js/);
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.doesNotMatch(status, /\.codex\/|\.agents\/|\.claude\/|\.harness\/src\//);
    git('check-ignore', '-v', '.codex/internal-skills/plantuml-diagrams/GUIDE.md');
    // A second update has nothing left to retire.
    assert.equal((await updateProject({ sourceRoot, targetRoot: root })).retired.includes(BINDINGS), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed consumer: an update removes bindings.json even when it was edited or lost its lock entry, keeping a backup', async () => {
  for (const variant of ['edited', 'unlocked']) {
    const { root } = await install();
    try {
      const stale = await makeLegacyConsumer(root, { bindings: '{"skills":{"code-review":"execution"}}\n', locked: variant === 'edited' });
      if (variant === 'edited') {
        const lockPath = join(root, '.codex/harness-lock.json');
        const lock = JSON.parse(await readFile(lockPath, 'utf8'));
        lock.files[BINDINGS].installed_sha256 = lock.files[BINDINGS].upstream_sha256 = sha256('what the installer wrote');
        await writeFile(lockPath, JSON.stringify(lock, null, 2));
      }
      const updated = await updateProject({ sourceRoot, targetRoot: root });
      assert.ok(updated.retired.includes(BINDINGS), variant);
      await assert.rejects(readFile(join(root, BINDINGS)), { code: 'ENOENT' });
      assert.equal(await readFile(join(updated.backup_directory, BINDINGS), 'utf8'), stale, variant);
      assert.equal(updated.skipped.some((item) => item.path === BINDINGS), false, variant);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('Doctor reports a malformed declaration and a workflow stage skill that declares nothing', async () => {
  const { root } = await install();
  try {
    const ownDoc = (skill) => join(root, '.codex/internal-skills', skill, 'GUIDE.md');
    await writeFile(ownDoc('implement'), (await readFile(ownDoc('implement'), 'utf8')).replace('model_tier: implementation', 'model_tier: low'));
    await writeFile(ownDoc('spec-me'), stripSkillDeclaration(await readFile(ownDoc('spec-me'), 'utf8')));
    const doctor = await runDoctor({ root, sourceRoot });
    const found = (code) => doctor.diagnostics.filter((item) => item.code === code).map((item) => item.path);
    assert.deepEqual(found('skill_model_tier_invalid'), [ownDoc('implement')]);
    assert.deepEqual(found('skill_model_tier_missing'), [ownDoc('spec-me')]);
    assert.equal(doctor.passed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
