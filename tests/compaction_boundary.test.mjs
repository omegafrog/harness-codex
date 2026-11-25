import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AUTO_COMPACT_WINDOW, compactionDecision, compactionLimits, pendingCompactionNotice, recordUnitBoundary } from '../.harness/src/workflow/compaction-boundary.mjs';
import { transformSourceContent } from '../.harness/src/installer/transforms.mjs';
import { syncClaudeOrchestratorHook } from '../.claude/harness/installer/claude-orchestrator-hook.mjs';
import { FRESH_AGENT_TYPES } from '../.harness/scripts/harness-fresh-agent.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'harness-compaction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.io'), { recursive: true });
  await writeFile(join(root, '.io/worktree.json'), '{}');
  await mkdir(join(root, 'session/subagents'), { recursive: true });
  const event = { hook_event_name: 'PreCompact', trigger: 'auto', cwd: root, transcript_path: join(root, 'session.jsonl'), agent_id: 'a1', agent_type: 'workflow_stage' };
  const size = (tokens, model = 'claude-sonnet-5-5') => writeFile(join(root, 'session/subagents/agent-a1.jsonl'), `${JSON.stringify({ type: 'assistant', message: { model, usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2 } } })}\n{"type":"user"}\n`);
  const decide = (extra = {}) => compactionDecision({ ...event, ...extra }, FRESH_AGENT_TYPES);
  return { root, event, size, decide };
}

test('a Harness sub-agent is compacted between units of work, not inside one', async (t) => {
  const { root, event, size, decide } = await fixture(t);
  await size(80000);
  assert.ok(decide().block, 'below the soft limit');
  assert.equal(pendingCompactionNotice(event), null, 'and nothing is asked of the worker');
  assert.equal(recordUnitBoundary(root, 'a1'), false);
  await size(120000);
  assert.ok(decide().block, 'inside a unit');
  assert.match(pendingCompactionNotice(event), /unit-done --agent-id a1/);
  assert.equal(pendingCompactionNotice(event), null, 'the worker is told once');
  assert.ok(decide().block, 'it stays postponed until the worker reaches a boundary');
  assert.equal(recordUnitBoundary(root, 'a1'), true);
  assert.match(decide().instructions, /remaining units/);
  assert.ok(decide().block, 'one boundary allows one compaction');
  await size(181000);
  assert.ok(decide().instructions, 'a unit that never ends is bounded');
});

test('Haiku stops before its long-context price step; other callers are left alone', async (t) => {
  const { size, decide, root } = await fixture(t);
  assert.ok(compactionLimits('claude-haiku-5-5').hard < 100000);
  await size(93000, 'claude-haiku-5-5');
  assert.ok(decide().instructions);
  assert.equal(decide({ agent_type: 'general-purpose' }), null);
  assert.equal(decide({ trigger: 'manual' }), null);
  assert.equal(decide({ cwd: join(root, 'session') }), null, 'outside a workflow worktree');
  assert.equal(decide({ agent_id: 'unknown' }), null, 'an unreadable transcript never blocks');
  assert.match(decide({ agent_id: undefined, agent_type: undefined }).instructions, /harness-context\.mjs --entry/, 'the orchestrator is never blocked');
});

test('the hook command blocks with JSON and passes instructions as text', async (t) => {
  const { root, event, size } = await fixture(t);
  await size(120000);
  const run = () => spawnSync(process.execPath, [resolve('.harness/scripts/harness-compaction.mjs'), 'hook'], { cwd: root, input: JSON.stringify(event), encoding: 'utf8' });
  assert.equal(JSON.parse(run().stdout).decision, 'block');
  recordUnitBoundary(root, 'a1');
  const allowed = run();
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /^This is a Harness agent/);
});

test('Claude profiles start without listings they cannot use and declare the window', async () => {
  const profile = async (name) => transformSourceContent(await readFile(`.codex/agents/${name}.toml`), 'claude-agent-v1');
  assert.match(await profile('workflow_stage'), /^tools: Bash, Read, Edit, Write, Agent$/m);
  assert.match(await profile('tactical_designer'), /^tools: .*WebSearch, WebFetch$/m);
  assert.match(await profile('e2e_test_runner'), /^disallowedTools: Skill$/m, 'a profile that may need MCP tools keeps them');
  assert.match(await profile('code_researcher'), /^tools: Read, Grep, Glob, WebSearch, WebFetch$/m);
  for (const name of FRESH_AGENT_TYPES) assert.match(await profile(name), new RegExp(`^autoCompactWindow: ${AUTO_COMPACT_WINDOW}$`, 'm'), name);
});

test('only a workflow worktree gets an orchestrator window, and a user value is kept', async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, '.claude'));
  const settings = async () => JSON.parse(await readFile(join(root, '.claude/settings.local.json'), 'utf8'));
  await syncClaudeOrchestratorHook(root, { noBackup: true });
  assert.equal((await settings()).autoCompactWindow, 150000);
  assert.equal((await settings()).hooks.PreCompact[0].matcher, 'auto');
  await writeFile(join(root, '.claude/settings.local.json'), JSON.stringify({ ...await settings(), autoCompactWindow: 400000 }));
  await syncClaudeOrchestratorHook(root, { noBackup: true });
  assert.equal((await settings()).autoCompactWindow, 400000);
  await rm(join(root, '.io'), { recursive: true });
  await rm(join(root, '.claude/settings.local.json'));
  await syncClaudeOrchestratorHook(root, { noBackup: true });
  assert.equal((await settings()).autoCompactWindow, undefined);
});
