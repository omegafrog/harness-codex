import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';

const sourceRoot = resolve('.');
const PROMPT_FILE = /\.(md|toml|yaml)$/;
// Files that setup or the project creates after installation.
const GENERATED = new Set(['.codex/harness.yaml', '.codex/repository-conventions.md']);
const BANNED = [
  [/기본 `model_tier`는/, 'model tier is resolved by bindings.json and workflow stages'],
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
