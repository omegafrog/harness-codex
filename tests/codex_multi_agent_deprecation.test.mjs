import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deprecatedMultiAgentFeature } from '../.codex/harness/providers/codex.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { SETUP } from './support/consumer-workflow.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

// Codex 0.171 prints "`[features].multi_agent` is deprecated" on every invocation while that key exists in any config layer.
// The shapes below are the layouts a real ~/.codex/config.toml uses.
test('only the deprecated [features].multi_agent key is recognized, not its successors or comments', () => {
  assert.equal(deprecatedMultiAgentFeature('model = "gpt-6"\n\n[features]\nmulti_agent = true\nhooks = true\n'), true);
  assert.equal(deprecatedMultiAgentFeature('[features]\nhooks = true\n  multi_agent=false # off\n'), true);
  assert.equal(deprecatedMultiAgentFeature('features.multi_agent = true\n[projects."/x"]\ntrust_level = "trusted"\n'), true);
  assert.equal(deprecatedMultiAgentFeature('[features]\nhooks = true\n\n[projects."/x"]\nmulti_agent = true\n'), false, 'another table is not [features]');
  assert.equal(deprecatedMultiAgentFeature('[features]\nmulti_agent_v2 = true\n# multi_agent = true\n'), false);
  assert.equal(deprecatedMultiAgentFeature('[features.multi_agent_v2]\nmax_concurrent_threads_per_session = 4\n[agents]\nenabled = true\n'), false);
  assert.equal(deprecatedMultiAgentFeature(''), false);
});

test('Doctor reports the deprecated key in the user and project Codex config, installed files never carry it, and Git stays clean', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-multi-agent-'));
  const home = await mkdtemp(join(tmpdir(), 'harness-multi-agent-home-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true, provider: 'codex' });
    await writeFile(join(root, '.harness/harness.yaml'), SETUP);
    const warnings = async () => (await runDoctor({ root, sourceRoot })).diagnostics.filter(({ code }) => code === 'codex_multi_agent_feature_deprecated');
    assert.deepEqual(await warnings(), [], 'a fresh install and a clean Codex home are not reported');

    // Harness writes no multi_agent setting anywhere it installs.
    const installed = [];
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (['.git', '.io', 'node_modules'].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && /\.(toml|json|ya?ml|mjs|md)$/.test(entry.name)) {
          const text = await readFile(path, 'utf8');
          if (/^\s*(?:features\.)?multi_agent\s*=|--enable[ =]multi_agent\b/m.test(text)) installed.push(path.slice(root.length + 1));
        }
      }
    };
    await walk(root);
    assert.deepEqual(installed, []);
    const baseline = execFileSync('git', ['-C', root, 'status', '--short', '--untracked-files=all'], { encoding: 'utf8' });

    await writeFile(join(home, 'config.toml'), 'model = "gpt-6"\n\n[features]\nmulti_agent = true\nhooks = true\n');
    let found = await warnings();
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, 'warning');
    assert.equal(found[0].path, join(home, 'config.toml'));
    assert.match(found[0].message, /\[agents\] enabled = false/);
    assert.match(found[0].message, /does not edit this user-owned file/);

    await mkdir(join(root, '.codex'), { recursive: true });
    await writeFile(join(root, '.codex/config.toml'), '[features]\nhooks = true\nmulti_agent = true\n');
    found = await warnings();
    assert.deepEqual(found.map(({ path }) => path).sort(), [join(home, 'config.toml'), join(root, '.codex/config.toml')].sort());

    // The user's own files are never rewritten by Doctor or by an update.
    const userConfig = await readFile(join(home, 'config.toml'), 'utf8');
    const projectConfig = await readFile(join(root, '.codex/config.toml'), 'utf8');
    await updateProject({ sourceRoot, targetRoot: root, provider: 'codex' });
    assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), userConfig);
    assert.equal(await readFile(join(root, '.codex/config.toml'), 'utf8'), projectConfig);
    await rm(join(root, '.codex/config.toml'));
    await writeFile(join(home, 'config.toml'), 'model = "gpt-6"\n\n[features]\nhooks = true\n');
    assert.deepEqual(await warnings(), [], 'the report ends when the key is removed');
    assert.equal(execFileSync('git', ['-C', root, 'status', '--short', '--untracked-files=all'], { encoding: 'utf8' }), baseline);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
