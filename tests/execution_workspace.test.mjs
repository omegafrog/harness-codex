import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';

test('installed runner owns execution paths despite legacy plans and forged input metadata', async () => {
  const sourceRoot = resolve('.');
  await mkdir('.io/runtime', { recursive: true });
  const directory = await mkdtemp(resolve('.io/runtime/execution-workspace-'));
  const primary = join(directory, 'primary');
  const root = join(directory, 'linked workspace');
  execFileSync('git', ['init', '-q', '-b', 'main', primary]);
  const git = (...args) => execFileSync('git', ['-C', primary, ...args], { encoding: 'utf8' });
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'baseline');
  git('worktree', 'add', '-qb', 'feature/test', root);
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  const runtime = (path) => pathToFileURL(join(root, '.harness/src', path)).href;
  const { resolveExecutionWorkspace } = await import(runtime('workflow/worktrees.mjs'));
  const { snapshotPlanSet } = await import(runtime('workflow/plan-review.mjs'));
  const { updateReviewAttempt } = await import(runtime('workflow/review-attempts.mjs'));
  const { preparePublicationDrafts, updatePublication, verifyDraftPublication } = await import(runtime('tracker/publication.mjs'));
  const { writeExecutionInput } = await import(runtime('workflow/execution-input.mjs'));
  const { readExecutionInput } = await import(runtime('workflow/skill-execution.mjs'));
  const { buildImplementPrompt } = await import(runtime('wrapper/scheduler.mjs'));
  const record = { schema_version: 1, worktree_id: 'c5c669a2-2967-4831-98db-63a24954e857', workspace: root, common: join(primary, '.git'), return_root: primary, session_directory: join(root, '.io'), branch: 'feature/test', state: 'active', plan_set_id: 'example' };
  const ref = join(root, '.io/worktree.json');
  await mkdir(join(root, '.io'), { recursive: true });
  await writeFile(ref, JSON.stringify(record));
  const expected = { workspace_root: root, workspace_branch: 'feature/test' };
  assert.deepEqual(await resolveExecutionWorkspace(root, 'example'), expected);
  await assert.rejects(resolveExecutionWorkspace(root, 'other'), /does not match/);
  await writeFile(ref, JSON.stringify({ ...record, branch: 'main' }));
  await assert.rejects(resolveExecutionWorkspace(root, 'example'), /does not match/);
  await writeFile(ref, JSON.stringify(record));
  await writeExecutionInput(root, { schema_version: 1, execution_id: 'implement-1', skill: 'implement', scope: 'test', context: { worktree_ref: ref, execution_workspace: { workspace_root: primary, workspace_branch: 'main' } } }, 'example');
  assert.deepEqual((await readExecutionInput({ root, execution_id: 'implement-1' })).context.execution_workspace, expected);

  const plans = join(root, 'docs/plans/example');
  const specs = join(root, 'docs/specs/example');
  const drafts = join(root, '.io/runtime/to-ticket/drafts');
  for (const path of [plans, specs, drafts, join(root, 'docs/agents')]) await mkdir(path, { recursive: true });
  await writeFile(join(root, 'docs/agents/EXEC.md'), '');
  const legacy = `# Slice\n- workspace_root: \`${primary}\`\n- workspace_branch: \`main\`\nDo business work.\n`;
  await writeFile(join(plans, 'slice.md'), legacy);
  await writeFile(join(plans, 'plans.md'), '# Plans\n');
  for (const name of ['product', 'architecture']) await writeFile(join(specs, `${name}-spec.md`), `# ${name}\n`);
  for (const name of ['parent', 'slice']) await writeFile(join(drafts, `${name}.md`), `${name === 'parent' ? 'example' : 'slice'}\n\`${primary}\`, branch \`main\`\n<details><summary>실행 정보</summary>\n- workspace_root: \`${primary}\`\n- workspace_branch: \`main\`\n</details>\n`);
  await writeFile(ref, JSON.stringify({ ...record, common: join(directory, 'missing-common') }));
  await assert.rejects(snapshotPlanSet({ root, planSetId: 'example' }), { code: 'ENOENT' });
  await writeFile(ref, JSON.stringify(record));
  const snapshot = await snapshotPlanSet({ root, planSetId: 'example' });
  const admission = await updateReviewAttempt({ root, scope: 'plan-example', action: 'begin', inputs: snapshot.inputs });
  await updateReviewAttempt({ root, scope: 'plan-example', action: 'record', attemptId: admission.attempt_id, inputs: snapshot.inputs, review: { reviewer_id: 'reviewer', author_ids: ['writer'], fork_turns: 'none', verdict: 'pass', findings: [] } });
  const prepared = await preparePublicationDrafts({ root, planSetId: 'example' });
  for (const item of prepared) {
    const body = await readFile(join(root, '.io', item.body_path), 'utf8');
    assert.ok(body.includes(`workspace_root: \`${root}\``));
    assert.ok(body.includes('workspace_branch: `feature/test`'));
    assert.ok(!body.includes(primary));
    assert.equal(createHash('sha256').update(body).digest('hex'), item.body_sha256);
  }
  assert.equal(await readFile(join(plans, 'slice.md'), 'utf8'), legacy);
  assert.deepEqual((await snapshotPlanSet({ root, planSetId: 'example' })).inputs, snapshot.inputs);
  assert.throws(() => buildImplementPrompt({ repository: root, workspaceRoot: primary, planSetId: 'example', planId: 'slice', planReviewRefs: { execution_workspace: expected } }), /conflicts with runner/);

  await writeFile(join(root, '.codex/harness.yaml'), JSON.stringify({ tracker: { mode: 'github', github: { project_owner: 'owner', project_number: 8, status_field: 'Workflow Status' } } }));
  const nodes = [];
  for (const [index, item] of prepared.entries()) {
    const begun = await updatePublication({ root, planSetId: 'example', planId: item.plan_id, action: 'begin' });
    assert.equal(begun.body_path, item.body_path);
    await updatePublication({ root, planSetId: 'example', planId: item.plan_id, action: 'record', itemId: `item-${index}` });
    nodes.push({ id: `item-${index}`, project: { id: 'project' }, content: { __typename: 'DraftIssue', title: item.plan_id, body: await readFile(join(root, '.io', item.body_path), 'utf8') }, fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'Planned', field: { id: 'status' } }] } });
  }
  const run = async (args) => JSON.stringify(args[0] === 'api' ? { data: { nodes } } : args[1] === 'view' ? { id: 'project' } : { totalCount: 1, fields: [{ id: 'status', name: 'Workflow Status', type: 'ProjectV2SingleSelectField' }] });
  await verifyDraftPublication({ root, planSetId: 'example', run });
  nodes[0].content.body = nodes[0].content.body.replace(root, primary);
  await assert.rejects(verifyDraftPublication({ root, planSetId: 'example', run }), /runner-generated/);

  await writeFile(join(root, 'app.js'), 'application owned');
  await updateProject({ sourceRoot, targetRoot: root });
  assert.equal(await readFile(join(root, 'app.js'), 'utf8'), 'application owned');
  assert.equal(await readFile(join(root, 'docs/agents/EXEC.md'), 'utf8'), '');
  await assert.rejects(readFile(join(root, 'AGENTS.md')), { code: 'ENOENT' });
  const status = execFileSync('git', ['-C', root, 'status', '--short', '--untracked-files=all'], { encoding: 'utf8' });
  assert.ok(status.includes('app.js') && status.includes('docs/agents/EXEC.md') && status.includes('docs/plans/example/slice.md'));
  assert.ok(!status.includes('.harness/src/') && !status.includes('.codex/agents/'));
  execFileSync('git', ['-C', root, 'check-ignore', '-v', '.harness/src/workflow/worktrees.mjs', '.harness/src/tracker/publication.mjs', '.io/runtime/to-ticket/publication-bodies/parent.md']);
  assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
});
