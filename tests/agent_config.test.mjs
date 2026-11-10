import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateAgentsText, providerAgents, legacyAgentKeys } from '../.harness/src/workflow/agent-config.mjs';
import { parseYaml } from '../.harness/src/eval/yaml.mjs';

const FLAT = `tracker:
  mode: github

agents:
  provider: claude-code
  high_performance_model: opus
  high_performance_reasoning_effort: high
  low_performance_model: haiku
  low_performance_reasoning_effort: low
  default_model: haiku

beads:
  enabled: false
`;

// Model settings are per provider, so older flat keys move under the active provider and nothing else changes.
test('flat model keys move under the active provider and the rest of the file is kept', () => {
  const { text, moved, provider } = migrateAgentsText(FLAT);
  assert.equal(provider, 'claude-code');
  assert.equal(moved.length, 5);
  const config = parseYaml(text);
  assert.equal(config.agents.provider, 'claude-code');
  assert.deepEqual(providerAgents(config), { high_performance_model: 'opus', high_performance_reasoning_effort: 'high', low_performance_model: 'haiku', low_performance_reasoning_effort: 'low', default_model: 'haiku' });
  assert.deepEqual(legacyAgentKeys(config), []);
  assert.equal(config.tracker.mode, 'github');
  assert.equal(config.beads.enabled, false);
  // Nothing is left to migrate, and a provider without a section has no settings of its own.
  assert.deepEqual(migrateAgentsText(text).moved, []);
  assert.deepEqual(providerAgents(config, 'codex'), {});
});

test('a provider section that already exists next to flat keys is not merged silently', () => {
  assert.throws(() => migrateAgentsText('agents:\n  provider: codex\n  low_performance_model: gpt-6-luna\n  codex:\n    execution_model: gpt-6-luna\n'), /already exists next to flat model keys/);
});

// Installed consumer: the update moves a project's flat model keys, harness.yaml stays a local Harness-generated file
// outside commits (git/info/exclude) while application files remain visible, and Doctor stops reporting flat keys.
test('update migrates flat model keys in an installed project and keeps harness.yaml out of commits', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { mkdir, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const { updateProject } = await import('../.harness/src/installer/update.mjs');
  const { protectLocalInstallArtifacts } = await import('../.harness/src/installer/local-exclude.mjs');
  const sourceRoot = process.cwd();
  const session = resolve(sourceRoot, '.io/runtime/agent-config-tests');
  await mkdir(session, { recursive: true });
  const root = await mkdtemp(`${session}/consumer-`);
  try {
    execFileSync('git', ['init', '-q', root]);
    await mkdir(resolve(root, '.codex'), { recursive: true });
    await writeFile(resolve(root, '.codex/harness.yaml'), FLAT);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true, noBackup: true });
    await protectLocalInstallArtifacts(root, sourceRoot);
    const config = parseYaml(await readFile(resolve(root, '.codex/harness.yaml'), 'utf8'));
    assert.deepEqual(legacyAgentKeys(config), []);
    assert.equal(providerAgents(config).low_performance_model, 'haiku');
    assert.equal(spawnSync('git', ['-C', root, 'check-ignore', '-q', '.codex/harness.yaml']).status, 0, 'harness.yaml stays out of commits');
    await writeFile(resolve(root, 'app.txt'), 'application file');
    assert.match(execFileSync('git', ['-C', root, 'status', '--short', '--untracked-files=all'], { encoding: 'utf8' }), /app\.txt/);
    const doctor = spawnSync('node', [resolve(root, '.codex/scripts/harness-doctor.mjs'), '--project', root, '--json'], { encoding: 'utf8' });
    assert.ok(!JSON.parse(doctor.stdout).diagnostics.some((item) => item.code === 'agents_config_flat'));
    // A flat file written after the update is reported.
    await writeFile(resolve(root, '.codex/harness.yaml'), FLAT);
    const flat = spawnSync('node', [resolve(root, '.codex/scripts/harness-doctor.mjs'), '--project', root, '--json'], { encoding: 'utf8' });
    assert.ok(JSON.parse(flat.stdout).diagnostics.some((item) => item.code === 'agents_config_flat'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
