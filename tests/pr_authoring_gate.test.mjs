import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlEventWriter } from '../.harness/src/eval/journal.mjs';
import { resolveAgentSandbox } from '../.harness/src/workflow/skill-execution.mjs';
import { assertPrStageReadiness } from '../.harness/src/workflow/stage-input.mjs';

test('PR authoring is restricted to the two declared dedicated stages', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await assert.rejects(resolveAgentSandbox({ root, input: { skill: 'gh-open-pr' } }), /available only at its gated/);
  assert.deepEqual(
    await resolveAgentSandbox({ root, input: { skill: 'gh-open-pr' }, workflow: 'to-ticket', stage: 'plan-pr' }),
    { profile: 'pr_author', sandbox: 'workspace-write' },
  );
  assert.deepEqual(
    await resolveAgentSandbox({ root, input: { skill: 'gh-open-pr' }, workflow: 'implement-wrapper', stage: 'integration-pr' }),
    { profile: 'pr_author', sandbox: 'workspace-write' },
  );
});

test('PR stages require publication and current passing non-final implementation gate evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pr-authoring-gates-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Harness Test']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'harness@example.test']);
    await mkdir(join(root, '.codex'), { recursive: true });
    await (await import('node:fs/promises')).mkdir(join(root, '.harness'), { recursive: true });
    await writeFile(join(root, '.harness/harness.yaml'), 'tracker:\n  mode: github\n');
    await writeFile(join(root, 'tracked'), 'initial\n');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'baseline']);
    const state = { stages: {} };

    await assert.rejects(assertPrStageReadiness({ root, state, stageId: 'plan-pr' }), /tracker publication/);
    state.stages['tracker-publish'] = { status: 'completed', code: 'OK' };
    await assert.doesNotReject(assertPrStageReadiness({ root, state, stageId: 'plan-pr' }));

    state.stages['implement-wrapper'] = { status: 'completed', code: 'OK' };
    state.stages['sync-contracts'] = { status: 'completed', code: 'OK' };
    await assert.rejects(assertPrStageReadiness({ root, state, stageId: 'integration-pr' }), /completion gates/);

    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const path = join(root, '.io/runtime/workflow-completion', `implement-wrapper-${head}.jsonl`);
    const writer = await new JsonlEventWriter(path, { streamId: `implement-wrapper:${head}` }).init();
    await writer.append('workflow_completion', { workflow_id: 'implement-wrapper', completion_kind: 'feature_implemented', state: 'completed', final_workflow: true, head });
    await writer.close();
    await assert.rejects(assertPrStageReadiness({ root, state, stageId: 'integration-pr' }), /completion gates/);

    const nonFinal = await new JsonlEventWriter(path, { streamId: `implement-wrapper:${head}` }).init();
    await nonFinal.append('workflow_completion', { workflow_id: 'implement-wrapper', completion_kind: 'feature_implemented', state: 'completed', final_workflow: false, head });
    await nonFinal.close();
    await assert.doesNotReject(assertPrStageReadiness({ root, state, stageId: 'integration-pr' }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
