import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';

const sourceRoot = resolve('.');
const PROMPT_FILE = /\.(md|toml|yaml)$/;
// Files that setup or the project creates after installation.
const GENERATED = new Set(['.harness/harness.yaml', '.codex/repository-conventions.md']);
const BANNED = [
  [/기본 `model_tier`는/, 'a skill declares its model tier in its own document and the runner resolves it'],
  [/내부 절차를 호출할 때 공개 스킬 검색 대신/, 'worker-base.md states the internal GUIDE rule once'],
  [/`docs\/agents\/EXEC\.md`의 세션 파일 출력 경계를 따른다/, 'use skill-execution/references/runtime-artifact-paths.md'],
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
    ...(await promptFiles(sourceRoot, ['.codex/agents', '.codex/skills', '.codex/internal-skills', '.codex/workflows'])),
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
    const files = await promptFiles(root, ['.codex/agents', '.codex/internal-skills', '.agents/skills', '.claude/skills', '.claude/agents']);
    assert.ok(files.length > 50);
    const broken = [];
    for (const path of files) {
      const text = await readFile(join(root, path), 'utf8');
      for (const [, link] of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
        if (/^(https?|mailto):/.test(link) || link.includes('<')) continue;
        if (!existsSync(normalize(join(root, dirname(path), link)))) broken.push(`${path} -> ${link}`);
      }
      for (const [, target] of text.matchAll(/`(\.(?:codex|agents|claude)\/[^`\s*<>]+\.(?:md|json|mjs|toml|yaml))`/g)) {
        if (!GENERATED.has(target) && !existsSync(join(root, target))) broken.push(`${path} => ${target}`);
      }
    }
    assert.deepEqual(broken, [], `broken references in ${relative(sourceRoot, root)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Agent profiles are pasted next to the stage GUIDE, so rules live in the GUIDE only.
// These two roles have no single owning GUIDE and keep their own short role rules.
const PROFILES_WITHOUT_OWNING_GUIDE = new Set(['execution_runner', 'spec_document_writer']);

test('agent profiles only name their role and point at the GUIDE that owns the rules', async () => {
  const dir = '.codex/agents';
  for (const file of (await readdir(join(sourceRoot, dir))).filter((name) => name.endsWith('.toml'))) {
    const text = await readFile(join(sourceRoot, dir, file), 'utf8');
    const instructions = /developer_instructions = """\n([\s\S]*?)\n"""/.exec(text)?.[1] || '';
    const guides = [...instructions.matchAll(/`(\.codex\/internal-skills\/[^`]+\/GUIDE\.md)`/g)].map(([, path]) => path);
    assert.ok(guides.length > 0, `${file} must point at its owning GUIDE`);
    for (const path of guides) assert.ok(existsSync(join(sourceRoot, path)), `${file}: ${path} is missing`);
    const limit = PROFILES_WITHOUT_OWNING_GUIDE.has(file.replace(/\.toml$/, '')) ? 2000 : 1000;
    assert.ok(Buffer.byteLength(instructions) <= limit, `${file}: move role rules into the GUIDE (${Buffer.byteLength(instructions)} > ${limit} bytes)`);
  }
});

test('the orchestrator dispatches stages to native subagents and returns format errors', async () => {
  const skill = await readFile(join(sourceRoot, '.codex/skills/orchestrator/SKILL.md'), 'utf8');
  assert.match(skill, /native 서브에이전트로 호출한다/);
  assert.match(skill, /형식 오류는 그 에이전트에게 키·값과 함께/);
  assert.doesNotMatch(skill, /harness-agent-run\.mjs/);
  assert.doesNotMatch(skill, /백그라운드 실행 뒤 반복 상태 조회 없이 턴을 끝내고|listener 경로/);
  assert.match(skill, /실제 완료를 기다리고 결과를 검증한 뒤/);
});

test('the code-review caller procedure assembles review evidence with the CLI instead of by hand', async () => {
  const repair = await readFile(join(sourceRoot, '.codex/internal-skills/code-review/references/repair.md'), 'utf8');
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
    const dispatch = await readFile(join(root, '.codex/internal-skills/skill-execution/references/dispatch.md'), 'utf8');
    assert.match(dispatch, /메인 세션\)는 이 값을 서브에이전트에 전달만 한다/);
    assert.match(dispatch, /`schema_path`의 파일과 stage 산출물\(Spec·plan·코드\) 본문은 읽지 않는다|`guide`·`input_path`·`schema_path`의 파일과 stage 산출물\(Spec·plan·코드\) 본문은 읽지 않는다/);
    for (const skill of ['.agents/skills/orchestrator/SKILL.md', '.claude/skills/orchestrator/SKILL.md']) {
      const text = await readFile(join(root, skill), 'utf8').catch(() => null);
      if (text !== null) assert.match(text, /GUIDE·schema·산출물 본문을 읽지 않고/);
    }
    execFileSync('git', ['check-ignore', '-q', '.codex/internal-skills/skill-execution/references/dispatch.md'], { cwd: root });
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
    assert.match(await readFile(join(root, '.codex/internal-skills/code-review/GUIDE.md'), 'utf8'), /셸이 없어 `spec-items`를 실행할 수 없다/);
    assert.match(await readFile(join(root, '.claude/skills/orchestrator/references/implementation.md'), 'utf8'), /spec-items --plan <plan-id>`를 직접 실행해 그 출력/);
    execFileSync('git', ['check-ignore', '-q', '.codex/internal-skills/code-review/GUIDE.md'], { cwd: root });
  } finally { await rm(root, { recursive: true, force: true }); }
});
