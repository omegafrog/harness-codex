import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { LEGACY_HARNESS_LOCK_PATH } from '../.harness/src/installer/config-location.mjs';
import { STAGE_CONTRACT, STAGE_CONTRACT_MARKER, STAGE_GATE_RETRY_CONTRACT } from '../.harness/src/installer/stage-contract.mjs';
import { outsideFences } from '../.harness/src/workflow/domain-model-gate.mjs';

const sourceRoot = resolve('.');
const PROMPT_FILE = /\.(md|toml|yaml)$/;
const CODEX_STAGE_SKILLS = '\n[skills]\ninclude_instructions = false\n';
const PONYTAIL_REFERENCE = '.harness/internal-skills/implement/references/ponytail.md';
// Setup creates project settings, and the legacy lock only exists before an upgrade.
const OPTIONAL_INSTALL_REFERENCES = new Set(['.harness/harness.yaml', '.harness/repository-conventions.md', LEGACY_HARNESS_LOCK_PATH]);
const BANNED = [
  [/기본 `model_tier`는/, 'a skill declares its model tier in its own document and the runner resolves it'],
  [/내부 절차를 호출할 때 공개 스킬 검색 대신/, 'the stage agent profiles state the internal GUIDE rule once'],
  [/`\.harness\/agents\/EXEC\.md`의 세션 파일 출력 경계를 따른다/, 'write the runtime artifact rule itself'],
  // These name runtime steps that no runner executes; GUIDEs must call the real CLIs instead.
  [/workspace gate가 수행|`before_dispatch` workspace gate|runtime plan-review gate|runtime의 `plan_review` gate|기존 scheduler의 `ready_plans`|runIndependentReviewers/, 'before_dispatch gates and the wrapper scheduler are not run; use harness-workspace-preflight.mjs and harness-plan-review.mjs check'],
];

async function walk(root, dir) {
  const entries = await readdir(join(root, dir), { withFileTypes: true }).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)));
  const nested = await Promise.all(entries.map((entry) => (entry.isDirectory() ? walk(root, join(dir, entry.name)) : [join(dir, entry.name)])));
  return nested.flat();
}

async function promptFiles(root, dirs) {
  const files = (await Promise.all(dirs.map((dir) => walk(root, dir)))).flat();
  return files.filter((path) => PROMPT_FILE.test(path) && !path.includes('/assets/'));
}

function sentences(text) {
  return text
    .split(/\n|(?<=[.!?다])\s+(?=[A-Z가-힣`])/)
    .map((part) => part.replace(/^[\s>*\-#\d.|]+/, '').replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 140 && !part.includes('](') && !part.includes('`.codex/'));
}

test('skill guides and agent profiles do not reintroduce copied boilerplate', async () => {
  const files = [
    'AGENTS.md',
    ...(await promptFiles(sourceRoot, ['.codex/agents', '.codex/skills', '.harness/internal-skills', '.harness/workflows'])),
  ];
  const owners = new Map();
  for (const path of files) {
    const text = await readFile(join(sourceRoot, path), 'utf8');
    for (const [pattern, reason] of BANNED) assert.doesNotMatch(text, pattern, `${path}: ${reason}`);
    for (const sentence of new Set(sentences(text))) owners.set(sentence, [...(owners.get(sentence) || []), path]);
  }
  const copied = [...owners].filter(([, paths]) => paths.length >= 3);
  assert.deepEqual(copied, [], 'Move a rule repeated in three or more prompt files to one owning guide and link it');
});

test('installed skill guides and agent profiles reference files that exist', async () => {
  await mkdir('.io', { recursive: true });
  const root = await mkdtemp(resolve('.io/prompt-links-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    const files = await promptFiles(root, ['.codex/agents', '.codex/skills', '.harness/internal-skills', '.claude/skills', '.claude/agents']);
    assert.ok(files.length > 50);
    const broken = [];
    const ponytailReaders = [];
    for (const path of files) {
      const text = await readFile(join(root, path), 'utf8');
      const prose = path.endsWith('.md') ? outsideFences(text).join('\n') : text;
      for (const [, link] of prose.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
        if (/^(https?|mailto):/.test(link) || link.includes('<')) continue;
        if (normalize(join(dirname(path), link)) === PONYTAIL_REFERENCE) ponytailReaders.push(path);
        if (!existsSync(normalize(join(root, dirname(path), link)))) broken.push(`${path} -> ${link}`);
      }
      for (const [, target] of text.matchAll(/`(\.(?:codex|agents|claude)\/[^`\s*<>]+\.(?:md|json|mjs|toml|yaml))`/g)) {
        if (!OPTIONAL_INSTALL_REFERENCES.has(target) && !existsSync(join(root, target))) broken.push(`${path} => ${target}`);
      }
    }
    assert.deepEqual(broken, [], `broken references in ${relative(sourceRoot, root)}`);
    assert.deepEqual(ponytailReaders.sort(), ['frontend-implement', 'implement', 'tactical-code'].map((name) => `.harness/internal-skills/${name}/GUIDE.md`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Agent profiles are pasted next to the stage GUIDE, so rules live in the GUIDE only; the shared stage contract is a
// marker line the installer replaces (.harness/src/installer/stage-contract.mjs).
// These roles have no single owning GUIDE: workflow_stage runs whichever stage GUIDE the caller hands it.
const PROFILES_WITHOUT_OWNING_GUIDE = new Set(['execution_runner', 'spec_document_writer', 'workflow_stage']);

test('agent profiles only name their role and point at the GUIDE that owns the rules', async () => {
  const dir = '.codex/agents';
  for (const file of (await readdir(join(sourceRoot, dir))).filter((name) => name.endsWith('.toml'))) {
    const text = await readFile(join(sourceRoot, dir, file), 'utf8');
    assert.ok(text.endsWith(CODEX_STAGE_SKILLS), `${file}: omit the inherited Codex skill catalog`);
    // The installer replaces the marker line with the shared stage contract; it is not a rule this profile owns.
    const instructions = (/developer_instructions = """\n([\s\S]*?)\n"""/.exec(text)?.[1] || '').replace(`\n\n${STAGE_CONTRACT_MARKER}`, '');
    const guides = [...instructions.matchAll(/`(\.harness\/internal-skills\/[^`]+\/GUIDE\.md)`/g)].map(([, path]) => path);
    assert.ok(guides.length > 0 || PROFILES_WITHOUT_OWNING_GUIDE.has(file.replace(/\.toml$/, '')), `${file} must point at its owning GUIDE`);
    for (const path of guides) assert.ok(existsSync(join(sourceRoot, path)), `${file}: ${path} is missing`);
    const limit = PROFILES_WITHOUT_OWNING_GUIDE.has(file.replace(/\.toml$/, '')) ? 2000 : 1000;
    assert.ok(Buffer.byteLength(instructions) <= limit, `${file}: move role rules into the GUIDE (${Buffer.byteLength(instructions)} > ${limit} bytes)`);
  }
});

test('every stage agent profile carries the shared stage contract marker, and an install writes the contract in its place', async () => {
  const roles = new Set(['workflow_stage', 'execution_runner', 'e2e_test_runner']);
  for (const file of await readdir(join(sourceRoot, '.harness/workflows'))) {
    for (const [, role] of (await readFile(join(sourceRoot, '.harness/workflows', file), 'utf8')).matchAll(/role:\s*\[?\s*([a-z_]+)/g)) roles.add(role);
  }
  for (const role of roles) assert.match(await readFile(join(sourceRoot, '.codex/agents', `${role}.toml`), 'utf8'), new RegExp(STAGE_CONTRACT_MARKER.replace(/[{}]/g, '\\$&')), `${role} carries the marker`);
  await mkdir('.io', { recursive: true });
  const root = await mkdtemp(resolve('.io/stage-contract-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    for (const file of await readdir(join(sourceRoot, '.codex/agents'))) {
      if (!file.endsWith('.toml')) continue;
      const path = `.codex/agents/${file}`;
      assert.ok((await readFile(join(root, path), 'utf8')).endsWith(CODEX_STAGE_SKILLS), path);
    }
    for (const path of ['.codex/agents/workflow_stage.toml', '.claude/agents/workflow_stage.md', '.codex/agents/spec_reviewer.toml']) {
      const text = await readFile(join(root, path), 'utf8');
      assert.ok(text.includes(STAGE_CONTRACT), `${path} carries the contract`);
      assert.ok(text.includes(STAGE_GATE_RETRY_CONTRACT), `${path} tells stage agents to read gate rejection feedback`);
      assert.ok(!text.includes(STAGE_CONTRACT_MARKER), `${path} has no marker left`);
      execFileSync('git', ['check-ignore', '-q', path], { cwd: root });
    }
    assert.doesNotMatch(await readFile(join(root, '.claude/agents/workflow_stage.md'), 'utf8'), /include_instructions/);
    assert.equal(execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('consumer update omits the Codex skill catalog and preserves project-owned files', async (t) => {
  await mkdir('.io', { recursive: true });
  const fixture = await mkdtemp(resolve('.io/stage-skills-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, 'consumer');
  const legacy = join(fixture, 'legacy');
  const profile = '.codex/agents/workflow_stage.toml';
  const current = await readFile(join(sourceRoot, profile), 'utf8');
  await mkdir(join(legacy, dirname(profile)), { recursive: true });
  await writeFile(join(legacy, profile), current.replace(CODEX_STAGE_SKILLS, ''));
  execFileSync('git', ['init', '-q', root]);
  await protectLocalInstallArtifacts(root, legacy);
  await updateProject({ sourceRoot: legacy, targetRoot: root, initialize: true, provider: 'codex' });
  assert.doesNotMatch(await readFile(join(root, profile), 'utf8'), /include_instructions/);

  const files = {
    '.codex/config.toml': '[skills]\ninclude_instructions = true\n',
    '.codex/agents/project_agent.toml': 'name = "project_agent"\n',
    'AGENTS.md': '# Consumer project guidance\n',
    'app.js': 'export const app = true;\n',
  };
  for (const [path, contents] of Object.entries(files)) await writeFile(join(root, path), contents);
  const profileUpdate = ({ code, path }) => code === 'installer_upstream_updated' && path === join(root, profile);
  assert.ok((await runDoctor({ root, sourceRoot })).diagnostics.some(profileUpdate));
  const updated = execFileSync(process.execPath, [join(sourceRoot, 'bin/harness-install.mjs'), 'update', '--project', root, '--provider', 'codex'], { encoding: 'utf8' });
  assert.match(updated, /^Updated: .*\.codex\/agents\/workflow_stage\.toml/m);
  assert.ok((await readFile(join(root, profile), 'utf8')).endsWith(CODEX_STAGE_SKILLS));
  assert.equal(await readFile(join(root, PONYTAIL_REFERENCE), 'utf8'), await readFile(join(sourceRoot, PONYTAIL_REFERENCE), 'utf8'));
  assert.ok(!(await runDoctor({ root, sourceRoot })).diagnostics.some(profileUpdate));
  for (const [path, contents] of Object.entries(files)) assert.equal(await readFile(join(root, path), 'utf8'), contents);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  for (const path of [profile, PONYTAIL_REFERENCE]) assert.match(git('check-ignore', '-v', path), /\.git\/info\/exclude:/);
  assert.deepEqual(git('status', '--short', '-uall').trimEnd().split('\n'), Object.keys(files).sort().map((path) => `?? ${path}`));
  await rm(join(root, PONYTAIL_REFERENCE));
  assert.ok((await runDoctor({ root })).diagnostics.some(({ code, path }) => code === 'execution_asset_missing' && path === join(root, PONYTAIL_REFERENCE)));
});

test('the orchestrator dispatches stages to native subagents and returns format errors', async () => {
  const skill = await readFile(join(sourceRoot, '.codex/skills/orchestrator/SKILL.md'), 'utf8');
  assert.ok(Buffer.byteLength(skill) <= 6 * 1024, 'the explicitly invoked entry point fits the prompt budget');
  assert.match(skill, /fresh native 서브에이전트를 시작한다/);
  assert.match(skill, /`format_error`나 `gate_error`는 같은 작업자에게 돌려준다/);
  assert.doesNotMatch(skill, /harness-agent-run\.mjs/);
  assert.doesNotMatch(skill, /백그라운드 실행 뒤 반복 상태 조회 없이 턴을 끝내고|listener 경로/);
  assert.match(skill, /실제 에이전트 결과를 기다리고 `next\.finish`로 검증한다/);
});

test('the code-review caller procedure assembles review evidence with the CLI instead of by hand', async () => {
  const repair = await readFile(join(sourceRoot, '.harness/internal-skills/code-review/references/repair.md'), 'utf8');
  assert.match(repair, /harness-code-review\.mjs assemble --root <workspace_root> --plan <plan-id> --fixed-point/);
  assert.match(repair, /reviewer ID는 넘기지 않는다/);
  assert.match(repair, /reviewer 판정을 구현 stage에 직접 넘기거나 repair를 건너뛰지 않는다/);
  assert.match(repair, /review JSON을 직접 조립하지 말고/);
});

// The main orchestrator session must not read stage guides, output schemas or stage products: whatever it reads is
// re-read on every later turn. The rule has to reach installed projects, and the installed files stay out of commits.
test('installed orchestrator guidance keeps stage guides, schemas and products out of the main session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-read-boundary-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    const dispatch = await readFile(join(root, '.codex/skills/orchestrator/references/dispatch.md'), 'utf8');
    assert.match(dispatch, /메인 세션\)는 이 값을 서브에이전트에 전달만 한다/);
    assert.match(dispatch, /`schema_path`의 파일과 stage 산출물\(Spec·plan·코드\) 본문은 읽지 않는다|`guide`·`input_path`·`schema_path`의 파일과 stage 산출물\(Spec·plan·코드\) 본문은 읽지 않는다/);
    assert.match(dispatch, /파일 조회를 시작하기 전에 `launch`부터 실행한다/);
    assert.match(dispatch, /타임아웃이나 빈 알림이면 다시 기다린다\./);
    assert.match(dispatch, /`inspect`에도 확인 근거가 없을 때만 `collaboration\.list_agents` 한 번/);
    assert.match(dispatch, /새 `execution_id`마다 반환된 `agent_profile`의 새 native 작업자/);
    const stakeholder = await readFile(join(root, '.harness/internal-skills/stakeholder-analysis/GUIDE.md'), 'utf8');
    assert.match(stakeholder, /Use those exact paths to check, read or write either file/);
    for (const skill of ['.codex/skills/orchestrator/SKILL.md', '.claude/skills/orchestrator/SKILL.md']) {
      const text = await readFile(join(root, skill), 'utf8');
      assert.ok(Buffer.byteLength(text) <= 6 * 1024, skill);
      assert.match(text, /GUIDE·schema·산출물 본문을 읽지 않고/);
      for (const [, path, anchor] of text.matchAll(/\]\((references\/[^)#]+\.md)(?:#([^)]+))?\)/g)) {
        const reference = await readFile(join(root, dirname(skill), path), 'utf8');
        if (anchor) assert.ok([...reference.matchAll(/^#+ (.+)$/gm)].some(([, title]) => title.toLowerCase().replaceAll(' ', '-') === anchor), `${path}#${anchor}`);
      }
    }
    const requiredReference = join(root, '.claude/skills/orchestrator/references/implementation.md');
    await rm(requiredReference);
    assert.ok((await runDoctor({ root, sourceRoot })).diagnostics.some(({ code, path }) => code === 'execution_asset_missing' && path === requiredReference));
    execFileSync('git', ['check-ignore', '-q', '.codex/skills/orchestrator/references/dispatch.md'], { cwd: root });
    assert.equal(execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).length, 0);
    assert.match(execFileSync('git', ['check-ignore', '-v', '.harness/contracts.mjs'], { cwd: root, encoding: 'utf8' }), /\.git\/info\/exclude:\d+:\/\.harness\/contracts\.mjs\t\.harness\/contracts\.mjs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A Claude Code spec_reviewer has no shell, so it cannot run `spec-items` itself: the caller must hand it the item IDs.
test('installed guidance has the caller pass spec-items to the shell-less Claude spec reviewer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-spec-items-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    assert.doesNotMatch(await readFile(join(root, '.claude/agents/spec_reviewer.md'), 'utf8'), /tools:[^\n]*Bash/);
    assert.match(await readFile(join(root, '.harness/internal-skills/code-review/GUIDE.md'), 'utf8'), /셸이 없어 `spec-items`를 실행할 수 없다/);
    assert.match(await readFile(join(root, '.claude/skills/orchestrator/references/implementation.md'), 'utf8'), /spec-items --plan <plan-id>`를 직접 실행해 그 출력/);
    execFileSync('git', ['check-ignore', '-q', '.harness/internal-skills/code-review/GUIDE.md'], { cwd: root });
  } finally { await rm(root, { recursive: true, force: true }); }
});
