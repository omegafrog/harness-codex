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
  const { preparePublicationDrafts, publicationTitle, updatePublication, inspectPublication } = await import(runtime('tracker/publication.mjs'));
  const { writeExecutionInput } = await import(runtime('workflow/execution-input.mjs'));
  const { readExecutionInput } = await import(runtime('workflow/stage-runtime.mjs'));
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
  for (const path of [plans, specs, drafts, join(root, '.harness/agents')]) await mkdir(path, { recursive: true });
  await writeFile(join(root, '.harness/agents/EXEC.md'), '');
  const legacy = `# Slice\n- workspace_root: \`${primary}\`\n- workspace_branch: \`main\`\nDo business work.\n`;
  await writeFile(join(plans, 'slice.md'), legacy);
  await writeFile(join(plans, 'plans.md'), '# Plans\n');
  assert.equal(await publicationTitle(root, 'example', '@parent'), '[Harness Plan Set] Plans');
  assert.equal(await publicationTitle(root, 'example', 'slice'), '[Harness Plan] Slice');
  await writeFile(join(plans, 'slice.md'), 'No title heading\n');
  await assert.rejects(publicationTitle(root, 'example', 'slice'), /title heading is missing/);
  await writeFile(join(plans, 'slice.md'), legacy);
  for (const name of ['product', 'architecture']) await writeFile(join(specs, `${name}-spec.md`), `# ${name}\n`);
  for (const name of ['parent', 'slice']) await writeFile(join(drafts, `${name}.md`), `${name === 'parent' ? 'example' : 'slice'}\n\`${primary}\`, branch \`main\`\n<details><summary>실행 정보</summary>\n- workspace_root: \`${primary}\`\n- workspace_branch: \`main\`\n</details>\n`);
  await writeFile(ref, JSON.stringify({ ...record, common: join(directory, 'missing-common') }));
  await assert.rejects(snapshotPlanSet({ root, planSetId: 'example' }), { code: 'ENOENT' });
  await writeFile(ref, JSON.stringify(record));
  const snapshot = await snapshotPlanSet({ root, planSetId: 'example' });
  const admission = await updateReviewAttempt({ root, scope: 'plan-example', action: 'begin', inputs: snapshot.inputs });
  await updateReviewAttempt({ root, scope: 'plan-example', action: 'record', attemptId: admission.attempt_id, inputs: snapshot.inputs, review: { reviewer_id: 'reviewer', author_ids: ['writer'], fork_turns: 'none', verdict: 'pass', findings: [] } });
  // Publication drafts exist only for the GitHub tracker, so the mode is configured before they are prepared.
  await (await import('node:fs/promises')).mkdir(join(root, '.harness'), { recursive: true });
  await writeFile(join(root, '.harness/harness.yaml'), JSON.stringify({ tracker: { mode: 'github', github: { repository: 'owner/repo', project_owner: 'owner', project_number: 8, status_field: 'Workflow Status' } } }));
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

  const issues = [];
  const run = async (args) => {
    if (args[0] === 'api' && args[1] === '--paginate') return JSON.stringify([issues]);
    assert.deepEqual(args.slice(0, 4), ['issue', 'create', '--repo', 'owner/repo']);
    const number = issues.length + 1;
    const html_url = `https://github.com/owner/repo/issues/${number}`;
    issues.push({ number, html_url, title: args[args.indexOf('--title') + 1], body: await readFile(args[args.indexOf('--body-file') + 1], 'utf8') });
    return html_url;
  };
  const expectedTitles = ['[Harness Plan Set] Plans', '[Harness Plan] Slice'];
  for (const [index, item] of prepared.entries()) {
    const args = { root, planSetId: 'example', planId: item.plan_id, action: 'publish', run };
    assert.equal((await updatePublication(args)).status, 'published');
    assert.equal(issues[index].title, expectedTitles[index]);
    assert.equal((await updatePublication(args)).status, 'already_published');
  }
  assert.equal(issues.length, 2);
  issues.push({ ...issues[0], number: 3, html_url: 'https://github.com/owner/repo/issues/3' });
  await assert.rejects(inspectPublication({ root, planSetId: 'example', run }), /Duplicate Issues/);

  await writeFile(join(root, 'app.js'), 'application owned');
  await updateProject({ sourceRoot, targetRoot: root });
  assert.equal(await readFile(join(root, 'app.js'), 'utf8'), 'application owned');
  assert.equal(await readFile(join(root, '.harness/agents/EXEC.md'), 'utf8'), '');
  await assert.rejects(readFile(join(root, 'AGENTS.md')), { code: 'ENOENT' });
  const status = execFileSync('git', ['-C', root, 'status', '--short', '--untracked-files=all'], { encoding: 'utf8' });
  assert.ok(status.includes('app.js') && status.includes('.harness/agents/EXEC.md') && status.includes('docs/plans/example/slice.md'));
  assert.ok(!status.includes('.harness/src/') && !status.includes('.codex/agents/'));
  execFileSync('git', ['-C', root, 'check-ignore', '-v', '.harness/src/workflow/worktrees.mjs', '.harness/src/tracker/publication.mjs', '.io/runtime/to-ticket/publication-bodies/parent.md']);
  assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
});
