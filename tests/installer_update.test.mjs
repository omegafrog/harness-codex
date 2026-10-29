import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildHarnessLock, updateProject, writeHarnessLock } from "../src/installer/update.mjs";
import { protectLocalInstallArtifacts } from "../src/installer/local-exclude.mjs";
import { writeArchitectureDecision, writeSystemTargets } from "../src/decision/artifacts.mjs";
import { computeApprovalHash } from "../src/decision/approval.mjs";
import { runDoctor } from "../src/doctor/index.mjs";
import { makeContractsFixture } from "./contracts-fixture.mjs";
import { sessionOutputPath } from "../src/workflow/session-output.mjs";
import { createWorkflowWorktree, finishWorkflowWorktree } from "../src/workflow/worktrees.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("installed decision hash uses the canonical object across updates and preserves application files", async () => {
  const root = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), "decision-install-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
    await protectLocalInstallArtifacts(root, REPOSITORY_ROOT);
    const decision = { schema_version: 1, id: "boundary", status: "proposed", category: "code", problem: "Choose a boundary.", constraints: ["Single process"], requirement_ids: ["REQ-1"], target_ids: ["target-1"], options: [{ id: "module", description: "Use a module." }, { id: "service", description: "Use a service." }], selected_option: "module", rejected_alternatives: [{ option_id: "service", reason: "No separate lifecycle." }], rationale: "One lifecycle.", tradeoffs: ["Shared deployment."], principle_ids: [], evidence_ids: ["evidence-1"], boundary: "Revisit if lifecycle changes.", review_id: "review-1" };
    await writeArchitectureDecision({ root, ticketId: "feature", decision });
    await writeFile(join(root, "application.txt"), "project content\n");
    const cli = () => spawnSync(process.execPath, [join(root, ".codex/scripts/harness-decision-gate.mjs"), "decision_subject_hash", "--ticket", "feature", "--decision", "boundary"], { cwd: root, encoding: "utf8" });
    for (let i = 0; i < 2; i += 1) {
      const result = cli();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).subject_hash, computeApprovalHash(decision));
      if (i === 0) await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
    }
    const lock = await buildHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
    for (const path of [".codex/scripts/harness-decision-gate.mjs", ".codex/harness-runtime/src/decision/approval.mjs", ".codex/harness-runtime/src/decision/artifacts.mjs"]) {
      assert.ok(lock.files[path], path);
      assert.equal(spawnSync("git", ["check-ignore", "-v", path], { cwd: root }).status, 0, path);
    }
    const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).stdout;
    assert.match(status, /application\.txt/);
    assert.match(status, /docs\/specs\/feature\/architecture-decisions\/boundary\.yaml/);
    assert.doesNotMatch(status, /harness-decision-gate|harness-runtime/);
    assert.equal(await readFile(join(root, "application.txt"), "utf8"), "project content\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installed worker runtime resumes recorded sessions and keeps Harness assets out of consumer Git status", async () => {
  const targetRoot = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), "session-runtime-install-"));
  const workerRoot = join(targetRoot, "worker");
  const sessionId = "01a1864e-f57b-72a3-bfaf-4d61a131ec76";
  try {
    assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: targetRoot }).status, 0);
    assert.equal(spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "base"], { cwd: targetRoot }).status, 0);
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    await protectLocalInstallArtifacts(targetRoot, REPOSITORY_ROOT);
    assert.equal(spawnSync("git", ["worktree", "add", "-q", "-b", "consumer-worker", workerRoot, "HEAD"], { cwd: targetRoot }).status, 0);
    const installedWorktrees = await import(pathToFileURL(join(targetRoot, ".codex/harness-runtime/src/workflow/worktrees.mjs")));
    await installedWorktrees.registerWorkflowWorktree({ workspace_root: workerRoot, return_root: targetRoot });
    await assert.rejects(installedWorktrees.recordWorkflowSession({ workspace_root: workerRoot, repository_root: targetRoot, key: "stage:spec", session_id: "invalid", execution_id: "spec-attempt-2" }), /Invalid workflow session entry/);
    await installedWorktrees.recordWorkflowSession({ workspace_root: workerRoot, repository_root: targetRoot, key: "stage:spec", session_id: sessionId, execution_id: "spec-attempt-2" });
    const recordPath = sessionOutputPath(workerRoot, "worktree.json", { repositoryRoot: targetRoot });
    assert.equal(JSON.parse(await readFile(recordPath, "utf8")).agent_sessions["stage:spec"].session_id, sessionId);
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    const installedRunner = await readFile(join(targetRoot, ".codex/scripts/harness-skill-exec.mjs"), "utf8");
    assert.match(installedRunner, /Read only the input fields and referenced artifacts needed for this task/);
    assert.match(installedRunner, /agent_sessions\?\.\[sessionKey\]/);
    assert.match(installedRunner, /resumeSessionId \? \['resume', resumeSessionId, '-'/);
    await writeFile(join(targetRoot, "application-owned.txt"), "keep visible\n");
    assert.equal(spawnSync("git", ["check-ignore", "-q", ".codex/harness-runtime/src/workflow/worktrees.mjs"], { cwd: targetRoot }).status, 0);
    assert.equal(spawnSync("git", ["check-ignore", "-v", ".harness-workflows/sessions/example/input.json"], { cwd: targetRoot }).status, 0);
    const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: targetRoot, encoding: "utf8" }).stdout;
    assert.match(status, /application-owned\.txt/);
    assert.doesNotMatch(status, /harness-skill-exec|harness-runtime|\.harness-workflows/);
    assert.equal(await readFile(join(targetRoot, "application-owned.txt"), "utf8"), "keep visible\n");
  } finally { await rm(targetRoot, { recursive: true, force: true }); }
});

test("fresh and updated consumer review CLI enforces admission and preserves Git visibility", async () => {
  const targetRoot = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), 'review-install-'));
  const runtimePath = '.codex/harness-runtime/src/workflow/review-attempts.mjs';
  const specReviewRuntimePath = '.codex/harness-runtime/src/workflow/spec-review.mjs';
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: targetRoot }).status, 0);
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    await protectLocalInstallArtifacts(targetRoot, REPOSITORY_ROOT);
    const installedKnowledgeSkill = await readFile(join(targetRoot, '.agents/skills/knowledge-harvest/SKILL.md'), 'utf8');
    assert.match(installedKnowledgeSkill, /^---\nname: knowledge-harvest\ndescription: .+\n---\n/);
    const criteriaPath = '.codex/internal-skills/spec-review/references/review-criteria.md';
    const installedCriteria = await readFile(join(targetRoot, criteriaPath), 'utf8');
    assert.match(installedCriteria, /필수 capability 완전성 점검/);
    assert.match(await readFile(join(targetRoot, '.codex/internal-skills/architecture-spec/GUIDE.md'), 'utf8'), /review-criteria\.md/);
    assert.match(await readFile(join(targetRoot, '.codex/internal-skills/spec-review/GUIDE.md'), 'utf8'), /review-criteria\.md/);
    const spec = join(targetRoot, 'docs/specs/review-install');
    await mkdir(spec, { recursive: true });
    await writeFile(join(spec, 'request.md'), 'Application-owned request\n');
    await writeFile(join(spec, 'product-spec.md'), 'Application-owned specification: (diagrams/product/UC-1.usecase.svg)\n');
    await writeFile(join(spec, 'architecture-spec.md'), 'Application-owned architecture specification\n');
    const cli = (action, ...args) => spawnSync(process.execPath, [join(targetRoot, '.codex/scripts/harness-spec-review.mjs'), action, '--root', targetRoot, '--ticket', 'review-install', ...args], { cwd: targetRoot, encoding: 'utf8' });
    const productReview = cli('begin', '--axis', 'product');
    assert.equal(productReview.status, 1);
    assert.match(productReview.stderr, /Only Architecture Spec review/);
    const started = cli('begin', '--axis', 'architecture');
    assert.equal(started.status, 0, started.stderr);
    const attempt = JSON.parse(started.stdout);
    assert.equal(attempt.target.workspace_root, targetRoot);
    assert.equal(attempt.target.ticket_id, 'review-install');
    assert.equal(attempt.target.axis, 'architecture');
    assert.equal(attempt.target.attempt_id, attempt.attempt_id);
    assert.ok(attempt.target.session_directory.startsWith(targetRoot));
    assert.ok(!Object.keys(attempt.inputs).some((path) => path.includes('/diagrams/')));
    await mkdir(join(spec, 'diagrams/product'), { recursive: true });
    await writeFile(join(spec, 'diagrams/product/UC-1.usecase.puml'), '@startuml\n@enduml\n');
    await writeFile(join(spec, 'diagrams/product/UC-1.usecase.svg'), '<svg></svg>\n');
    assert.match(cli('begin', '--axis', 'product').stderr, /Only Architecture Spec review/);
    const reviews = { architecture: { axis: 'architecture', ticket_id: 'review-install', reviewer_id: 'fresh-architecture-reviewer', author_ids: ['writer'], fork_turns: 'none', verdict: 'pass', inputs: attempt.inputs, findings: [] } };
    const evidence = 'runtime/spec-reviews/install.json';
    await writeFile(sessionOutputPath(targetRoot, evidence), JSON.stringify(reviews));
    assert.equal(cli('record', '--axis', 'architecture', '--attempt', attempt.attempt_id, '--reviews', evidence).status, 0);
    assert.equal(cli('check', '--axis', 'architecture', '--reviews', evidence).status, 0);
    const { evaluateStageGates } = await import(pathToFileURL(join(targetRoot, '.codex/harness-runtime/src/workflow/stage-gates.mjs')).href);
    const { loadNamedWorkflow } = await import(pathToFileURL(join(REPOSITORY_ROOT, 'src/workflow/loader.mjs')).href);
    const installedWorkflow = await loadNamedWorkflow('spec-me', { root: targetRoot });
    assert.equal((await evaluateStageGates({ workflow: installedWorkflow, stageId: 'product_diagram', root: targetRoot, ticketId: 'review-install' }))[0].status, 'pass');
    assert.match(cli('begin', '--axis', 'architecture').stderr, /Review inputs are unchanged/);

    const reviewInput = { repository: targetRoot, fixed_point: 'base', implementation_commit_sha: 'impl-1', commit_list: ['base', 'impl-1'], diff_range: { from: 'base', to: 'impl-1' }, diff: 'diff --git a/src/a b/src/a', product_spec_path: 'docs/specs/review-install/product-spec.md', architecture_spec_path: 'docs/specs/review-install/architecture-spec.md' };
    const implementationEvidence = 'runtime/spec-reviews/implementation.json';
    const implementationReviews = ['standards', 'spec'].map((role) => ({ role, state: role === 'standards' ? 'failed' : 'passed', context_id: role, independent: true, fresh_context: true, implementation_commit_sha: 'impl-1', review_input: reviewInput, report: { findings: role === 'standards' ? [{ kind: 'implementation_defect', summary: 'Repair the complete replay path' }] : [] } }));
    await writeFile(sessionOutputPath(targetRoot, implementationEvidence), JSON.stringify({ review_input: reviewInput, reviews: implementationReviews }));
    const repair = () => spawnSync(process.execPath, [join(targetRoot, '.codex/scripts/harness-code-review.mjs'), 'repair', '--root', targetRoot, '--plan', 'plan-a', '--reviews', implementationEvidence], { cwd: targetRoot, encoding: 'utf8' });
    const resolveRepair = (...args) => spawnSync(process.execPath, [join(targetRoot, '.codex/scripts/harness-code-review.mjs'), 'resolve', '--root', targetRoot, '--plan', 'plan-a', ...args], { cwd: targetRoot, encoding: 'utf8' });
    const designReviews = implementationReviews.map((review) => review.role === 'standards' ? { ...review, report: { findings: [{ kind: 'architecture_decision', summary: 'New state needs an approved design' }] } } : review);
    await writeFile(sessionOutputPath(targetRoot, implementationEvidence), JSON.stringify({ review_input: reviewInput, reviews: designReviews }));
    const design = repair();
    assert.equal(design.status, 1);
    assert.equal(JSON.parse(design.stdout).next_action, 'spec-me');
    await writeFile(sessionOutputPath(targetRoot, implementationEvidence), JSON.stringify({ review_input: reviewInput, reviews: implementationReviews }));
    assert.equal(repair().status, 0);
    assert.match(repair().stderr, /already has a reserved repair/);
    const genericContinuation = resolveRepair('--reason', '계속 해');
    assert.equal(genericContinuation.status, 1);
    assert.match(genericContinuation.stderr, /reviewed plan-set snapshot/);
    const reviewStatusPath = '.codex/scripts/harness-review-status.mjs';
    const statusCli = () => spawnSync(process.execPath, [join(targetRoot, reviewStatusPath), '--root', targetRoot, '--ticket', 'review-install', '--plan-set', 'review-set', '--plan', 'plan-a', '--reviews', implementationEvidence], { cwd: targetRoot, encoding: 'utf8' });
    const freshStatus = statusCli();
    assert.equal(freshStatus.status, 0, freshStatus.stderr);
    assert.equal(JSON.parse(freshStatus.stdout).records.at(-1).budget.used, 1);
    assert.equal(JSON.parse(freshStatus.stdout).implementation_findings.repairable.length, 1);
    await unlink(join(targetRoot, reviewStatusPath));
    const missingStatusCli = await runDoctor({ root: targetRoot, sourceRoot: REPOSITORY_ROOT });
    assert.ok(missingStatusCli.diagnostics.some((item) => item.code === 'installer_missing_file' && item.path === join(targetRoot, reviewStatusPath)));


    await writeFile(join(targetRoot, runtimePath), 'old runtime\n');
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    const update = await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.ok(update.updated.includes(runtimePath));
    assert.equal(cli('check', '--axis', 'architecture', '--reviews', evidence).status, 0);
    assert.match(cli('begin', '--axis', 'architecture').stderr, /Review inputs are unchanged/);
    assert.match(repair().stderr, /already has a reserved repair/);
    const lock = await buildHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.ok(lock.files[runtimePath]);
    assert.ok(lock.files[specReviewRuntimePath]);
    assert.equal(spawnSync('git', ['check-ignore', '-v', specReviewRuntimePath], { cwd: targetRoot }).status, 0);
    assert.ok(lock.files[criteriaPath]);
    assert.equal(spawnSync('git', ['check-ignore', '-v', criteriaPath], { cwd: targetRoot }).status, 0);
    const consumerStatus = spawnSync('git', ['status', '--short', '--untracked-files=all'], { cwd: targetRoot, encoding: 'utf8' }).stdout;
    assert.match(consumerStatus, /docs\/specs\/review-install\/product-spec\.md/);
    assert.ok(lock.files['.codex/scripts/harness-code-review.mjs']);
    assert.ok(lock.files[reviewStatusPath]);
    assert.equal(statusCli().status, 0);
    assert.equal(resolveRepair('--reason', '계속 해').status, 1);
    const staleInput = { ...reviewInput, plan_set_id: 'missing-plan-set', planning_snapshot_sha256: 'a'.repeat(64), completion_kind: 'plan_implemented' };
    await writeFile(sessionOutputPath(targetRoot, implementationEvidence), JSON.stringify({ review_input: staleInput, reviews: implementationReviews.map((review) => ({ ...review, review_input: staleInput })) }));
    assert.match(repair().stderr, /planning snapshot changed/);
    await writeFile(sessionOutputPath(targetRoot, implementationEvidence), JSON.stringify({ review_input: reviewInput, reviews: implementationReviews }));

    assert.equal(JSON.parse(statusCli().stdout).records.at(-1).budget.used, 1);
    const coordination = '.codex/internal-skills/review-coordination/GUIDE.md';
    assert.equal(await readFile(join(targetRoot, coordination), 'utf8'), await readFile(join(REPOSITORY_ROOT, coordination), 'utf8'));
    const doctorAfterStatusRestore = await runDoctor({ root: targetRoot, sourceRoot: REPOSITORY_ROOT });
    assert.ok(!doctorAfterStatusRestore.diagnostics.some((item) => item.path === join(targetRoot, reviewStatusPath)));
    assert.equal(spawnSync('git', ['check-ignore', '-v', reviewStatusPath], { cwd: targetRoot }).status, 0);

    const installedReference = pathToFileURL(join(targetRoot, '.codex/harness-runtime/src/workflow/plan-review.mjs')).href;
    const referenceCheck = spawnSync(process.execPath, ['--input-type=module', '-e', `import { validateCanonicalPlanReference } from ${JSON.stringify(installedReference)}; const ref = {kind:'file',reference:'docs/plans/plan.md',input_key:'plan#canonical',hash_algorithm:'sha256',normalization:'frontmatter-status-excluded-v1',sha256:'a'.repeat(64)}; validateCanonicalPlanReference(ref); try { validateCanonicalPlanReference({...ref, normalization:'raw-file'}); process.exit(1); } catch {}`], { cwd: targetRoot, encoding: 'utf8' });
    assert.equal(referenceCheck.status, 0, referenceCheck.stderr);
    for (const path of ['.codex/internal-skills/architecture-spec/GUIDE.md', '.codex/internal-skills/architecture-spec/references/template.md', '.codex/internal-skills/spec-review/GUIDE.md']) assert.equal(await readFile(join(targetRoot, path), 'utf8'), (await readFile(join(REPOSITORY_ROOT, path), 'utf8')).replaceAll('.codex/skills/', '.agents/skills/'));
    assert.equal(await readFile(join(targetRoot, '.agents/skills/spec-me/SKILL.md'), 'utf8'), (await readFile(join(REPOSITORY_ROOT, '.codex/skills/spec-me/SKILL.md'), 'utf8')).replaceAll('.codex/skills/', '.agents/skills/'));

    const doctor = await runDoctor({ root: targetRoot, sourceRoot: REPOSITORY_ROOT });
    assert.ok(!doctor.diagnostics.some((item) => item.severity === 'error' && item.path.endsWith('review-attempts.mjs')));
    const status = spawnSync('git', ['status', '--short', '--untracked-files=all'], { cwd: targetRoot, encoding: 'utf8' }).stdout;
    assert.match(status, /docs\/specs\/review-install\/request.md/);
    assert.doesNotMatch(status, /\.codex\/|\.agents\/|runtime\/reviews/);
    assert.equal(await readFile(join(spec, 'request.md'), 'utf8'), 'Application-owned request\n');
  } finally { await rm(targetRoot, { recursive: true, force: true }); }
});

test("installed workflow resumes across Codex sessions after fresh install and update", async () => {
  const targetRoot = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), "workflow-resume-install-"));
  const startupPath = ".codex/harness-runtime/src/workflow/startup-state.mjs";
  const executionPath = ".codex/harness-runtime/src/workflow/execution-state.mjs";
  const inputPath = ".codex/harness-runtime/src/workflow/stage-input.mjs";
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: targetRoot }).status, 0);
    await writeFile(join(targetRoot, "application.txt"), "baseline\n");
    assert.equal(spawnSync("git", ["add", "application.txt"], { cwd: targetRoot }).status, 0);
    assert.equal(spawnSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness-test@example.com", "commit", "-qm", "consumer baseline"], { cwd: targetRoot }).status, 0);

    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot, initialize: true });
    await protectLocalInstallArtifacts(targetRoot, REPOSITORY_ROOT);
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });

    const lock = JSON.parse(await readFile(join(targetRoot, ".codex/harness-lock.json"), "utf8"));
    for (const path of [startupPath, executionPath, inputPath]) assert.ok(lock.files[path], `missing installed lock entry: ${path}`);
    const runtime = async (path) => import(pathToFileURL(join(targetRoot, path)).href);
    const { sessionDirectory, sessionOutputPath } = await runtime(".codex/harness-runtime/src/workflow/session-output.mjs");
    const { inspectStartupState } = await runtime(startupPath);
    const { recordExecutionState } = await runtime(executionPath);
    const session = sessionDirectory(targetRoot);
    const workflowRef = "runtime/orchestrator/workflow.json";
    await writeFile(sessionOutputPath(targetRoot, workflowRef), JSON.stringify({ schema_version: 1, workflow_id: "resume-consumer", stages: [{ id: "spec", needs: [] }] }));
    await writeFile(sessionOutputPath(targetRoot, "runtime/orchestrator/state.json"), JSON.stringify({ schema_version: 1, codex_session_id: "previous-session", workflow_ref: workflowRef, status: "waiting", current_stage: "spec", stages: { spec: { status: "waiting", execution_id: "previous-execution" } } }));

    const observed = await inspectStartupState({ workspaceRoot: targetRoot, codexSessionId: "current-session" });
    assert.equal(observed.decision_hint, "resume_candidate");
    assert.equal(observed.matching_workflows.length, 1);
    const input = { schema_version: 1, execution_id: "resumed-execution", skill: "spec-me", workspace_root: targetRoot, session_directory: session, scope: "Continue pending stage", input_refs: [], context: { codex_session_id: "current-session", stage_id: "spec", workflow_ref: workflowRef } };
    const binding = { model: "fixture", reasoning_effort: "low" };
    await recordExecutionState({ root: targetRoot, input, binding, status: "running" });
    await recordExecutionState({ root: targetRoot, input, binding, status: "completed", code: "OK", result_ref: "runtime/result.json" });
    const state = JSON.parse(await readFile(join(session, "runtime/orchestrator/state.json"), "utf8"));
    assert.equal(state.codex_session_id, "current-session");
    assert.equal(state.stages.spec.status, "completed");

    await mkdir(join(targetRoot, "docs/agents"), { recursive: true });
    await writeFile(join(targetRoot, "docs/agents/EXEC.md"), "Consumer-owned execution instructions\n");
    await writeFile(join(targetRoot, "docs/agents/execution.json"), JSON.stringify({ schema_version: 1, profiles: {} }));
    await writeFile(join(targetRoot, "application.txt"), "application change\n");
    const doctor = await runDoctor({ root: targetRoot, sourceRoot: REPOSITORY_ROOT });
    for (const path of [startupPath, executionPath, inputPath]) assert.ok(!doctor.diagnostics.some((item) => item.severity === "error" && item.path.endsWith(path)));
    assert.equal(spawnSync("git", ["check-ignore", "-v", startupPath], { cwd: targetRoot }).status, 0);
    assert.notEqual(spawnSync("git", ["check-ignore", "-v", "docs/agents/EXEC.md"], { cwd: targetRoot }).status, 0);
    const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: targetRoot, encoding: "utf8" }).stdout;
    assert.match(status, /application\.txt/);
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.match(status, /docs\/agents\/execution\.json/);
    assert.doesNotMatch(status, /\.codex\/harness-runtime/);
  } finally { await rm(targetRoot, { recursive: true, force: true }); }
});

test("installed workflow dispatch uses the linked worktree session and keeps state in the controller session", async () => {
  const targetRoot = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), "worktree-session-install-"));
  const workerRoot = `${targetRoot}-worker`;
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: targetRoot }).status, 0);
    await writeFile(join(targetRoot, "application.txt"), "baseline\n");
    assert.equal(spawnSync("git", ["add", "application.txt"], { cwd: targetRoot }).status, 0);
    assert.equal(spawnSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness-test@example.com", "commit", "-qm", "consumer baseline"], { cwd: targetRoot }).status, 0);
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot, initialize: true });
    await protectLocalInstallArtifacts(targetRoot, REPOSITORY_ROOT);
    const addWorktree = spawnSync("git", ["worktree", "add", "-b", "test-spec-session", workerRoot, "HEAD"], { cwd: targetRoot, encoding: "utf8" });
    assert.equal(addWorktree.status, 0, addWorktree.stderr);
    await cp(join(targetRoot, ".codex"), join(workerRoot, ".codex"), { recursive: true });
    await cp(join(targetRoot, ".agents"), join(workerRoot, ".agents"), { recursive: true });
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot: workerRoot });
    await protectLocalInstallArtifacts(workerRoot, REPOSITORY_ROOT);

    const runtime = async (workspace, path) => import(pathToFileURL(join(workspace, ".codex/harness-runtime", path)).href);
    const { registerWorkflowWorktree } = await runtime(workerRoot, "src/workflow/worktrees.mjs");
    const record = await registerWorkflowWorktree({ workspace_root: workerRoot, return_root: targetRoot });
    const { sessionDirectory, sessionOutputPath } = await runtime(workerRoot, "src/workflow/session-output.mjs");
    const controlSession = sessionDirectory(targetRoot);
    const taskSession = record.session_directory;
    const workflowRef = "runtime/orchestrator/workflow.json";
    const workflow = { schema_version: 1, workflow_id: "installed-session-routing", scope: "Write the requested Specs", stages: [
      { id: "spec_authoring", skill: "spec-me", role: "default", scope: "Write the Specs", needs: [], conditions: [], gates: [], inputs: [{ base: "session", path: "runtime/request.md" }], outputs: [] },
    ] };
    const composerExecution = "workflow-compose-installed";
    const composerResultRef = `runtime/executions/${composerExecution}/result.json`;
    const composerInput = { schema_version: 1, execution_id: composerExecution, skill: "workflow-compose", workspace_root: targetRoot, shared_guidance_root: targetRoot, session_directory: controlSession, scope: "Prepare workflow", input_refs: [], context: { worktree_ref: join(taskSession, "worktree.json") } };
    const composerResult = { schema_version: 1, execution_id: composerExecution, skill: "workflow-compose", status: "completed", code: "OK", summary: "Prepared", artifacts: [], details: { worktree_ref: composerInput.context.worktree_ref } };
    await writeFile(sessionOutputPath(targetRoot, "runtime/request.md"), "User request");
    await writeFile(sessionOutputPath(targetRoot, workflowRef), JSON.stringify(workflow));
    await writeFile(sessionOutputPath(targetRoot, "runtime/orchestrator/state.json"), JSON.stringify({ schema_version: 1, codex_session_id: "old-session", workflow_ref: workflowRef, stages: { "workflow-compose": { status: "completed", execution_id: composerExecution, result_ref: composerResultRef, result_session_directory: controlSession } } }));
    await writeFile(sessionOutputPath(targetRoot, `runtime/executions/${composerExecution}/input.json`), JSON.stringify(composerInput));
    await writeFile(sessionOutputPath(targetRoot, composerResultRef), JSON.stringify(composerResult));

    const { prepareStageInput } = await runtime(workerRoot, "src/workflow/stage-input.mjs");
    const prepared = await prepareStageInput({ root: workerRoot, session: controlSession, workflowRef, stageId: "spec_authoring", codexSessionId: "new-session" });
    assert.equal(prepared.input.session_directory, taskSession);
    assert.equal(prepared.input.context.control_session_directory, controlSession);
    assert.ok(prepared.input.input_refs.some((item) => item.base === "control_session" && item.path === "runtime/request.md"));

    const { recordExecutionState } = await runtime(workerRoot, "src/workflow/execution-state.mjs");
    await recordExecutionState({ root: workerRoot, input: prepared.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "running" });
    await recordExecutionState({ root: workerRoot, input: prepared.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "blocked", code: "INPUT_MISSING", reason: "fixture" });
    const state = JSON.parse(await readFile(join(controlSession, "runtime/orchestrator/state.json"), "utf8"));
    assert.equal(state.stages.spec_authoring.result_session_directory, taskSession);
    assert.equal(state.stages.spec_authoring.status, "blocked");
    assert.ok(await readFile(join(taskSession, prepared.path), "utf8"));

    const parentId = prepared.input.execution_id;
    const parentRef = `runtime/executions/${parentId}/result.json`;
    const parentReturn = { schema_version: 1, execution_id: parentId, skill: "spec-me", status: "action_required", code: "SUBTASK_REQUIRED", result_ref: parentRef };
    const parentResult = { schema_version: 1, execution_id: parentId, skill: "spec-me", status: "action_required", code: "SUBTASK_REQUIRED", summary: "Research needed", artifacts: [], details: { required_subtasks: [{ skill: "code-research", purpose: "Inspect existing implementation" }] } };
    await writeFile(join(taskSession, parentRef), JSON.stringify(parentResult));
    await writeFile(join(taskSession, `runtime/executions/${parentId}/return.json`), JSON.stringify(parentReturn));
    await writeFile(join(taskSession, `runtime/executions/${parentId}/exec.stderr.json`), JSON.stringify({ thread_id: "01a185ae-2681-74a1-96c4-d9c5007f9ef8" }));
    await recordExecutionState({ root: workerRoot, input: prepared.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "running" });
    await recordExecutionState({ root: workerRoot, input: prepared.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "action_required", code: "SUBTASK_REQUIRED", result_ref: parentRef });
    const parentAnswer = await prepareStageInput({ root: workerRoot, session: controlSession, workflowRef, stageId: "spec_authoring", codexSessionId: "new-session", answer: "계속 진행" });
    assert.deepEqual(parentAnswer.answer, { answer: "계속 진행" });
    assert.equal(parentAnswer.input.context.resume_session_id, "01a185ae-2681-74a1-96c4-d9c5007f9ef8");
    const child = await prepareStageInput({ root: workerRoot, session: controlSession, workflowRef, stageId: "spec_authoring", codexSessionId: "new-session", subtask: "0" });
    const childId = child.input.execution_id, childRef = `runtime/executions/${childId}/result.json`;
    const waiting = await prepareStageInput({ root: workerRoot, session: controlSession, workflowRef, stageId: "spec_authoring", codexSessionId: "new-session", subtask: "0" });
    const waitingId = waiting.input.execution_id, waitingRef = `runtime/executions/${waitingId}/result.json`, waitingQuestion = `runtime/executions/${waitingId}/question.json`;
    await writeFile(join(taskSession, waitingQuestion), JSON.stringify({ question_id: "child", question: "계속할까요?", options: [{ id: "yes", label: "진행", consequence: "진행한다" }, { id: "no", label: "중단", consequence: "중단한다" }], recommended_option_id: "yes", rationale: "진행" }));
    await writeFile(join(taskSession, waitingRef), JSON.stringify({ schema_version: 1, execution_id: waitingId, skill: "code-research", status: "action_required", code: "USER_DECISION_REQUIRED", summary: "Decision", artifacts: [{ kind: "user_question", base: "session", path: waitingQuestion }], details: {} }));
    await writeFile(join(taskSession, `runtime/executions/${waitingId}/return.json`), JSON.stringify({ schema_version: 1, execution_id: waitingId, skill: "code-research", status: "action_required", code: "USER_DECISION_REQUIRED", result_ref: waitingRef }));
    await writeFile(join(taskSession, `runtime/executions/${waitingId}/exec.stderr.json`), JSON.stringify({ thread_id: "01a185ae-2681-74a1-96c4-d9c5007f9ef8" }));
    await recordExecutionState({ root: workerRoot, input: waiting.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "running" });
    await recordExecutionState({ root: workerRoot, input: waiting.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "action_required", code: "USER_DECISION_REQUIRED", result_ref: waitingRef });
    const childResume = await prepareStageInput({ root: workerRoot, session: controlSession, workflowRef, stageId: "spec_authoring", codexSessionId: "new-session", resumeSubtask: waitingId, answer: "진행" });
    assert.equal(childResume.input.context.resume_session_id, "01a185ae-2681-74a1-96c4-d9c5007f9ef8");
    assert.deepEqual(childResume.answer, { question_id: "child", answer: "진행" });
    const target = await prepareStageInput({ root: workerRoot, session: controlSession, workflowRef, stageId: "spec_authoring", codexSessionId: "new-session", subtask: "0" });
    const targetId = target.input.execution_id, targetRef = `runtime/executions/${targetId}/result.json`;
    await writeFile(join(taskSession, targetRef), JSON.stringify({ schema_version: 1, execution_id: targetId, skill: "code-research", status: "action_required", code: "REVIEW_REQUIRED", summary: "Review", artifacts: [], details: { review_request: { skill: "architecture-review", role: "architecture_review_lead", purpose: "Review the decision", context: { decision_id: "AD-001" } } } }));
    await writeFile(join(taskSession, `runtime/executions/${targetId}/return.json`), JSON.stringify({ schema_version: 1, execution_id: targetId, skill: "code-research", status: "action_required", code: "REVIEW_REQUIRED", result_ref: targetRef }));
    await writeFile(join(taskSession, `runtime/executions/${targetId}/exec.stderr.json`), JSON.stringify({ thread_id: "01a185ae-2681-74a1-96c4-d9c5007f9ef8" }));
    await recordExecutionState({ root: workerRoot, input: target.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "running" });
    await recordExecutionState({ root: workerRoot, input: target.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "action_required", code: "REVIEW_REQUIRED", result_ref: targetRef });
    const reviewAnswer = await prepareStageInput({ root: workerRoot, session: controlSession, workflowRef, stageId: "spec_authoring", codexSessionId: "new-session", resumeSubtask: targetId, answer: "사용자 답변" });
    assert.deepEqual(reviewAnswer.answer, { answer: "사용자 답변" });
    assert.equal(reviewAnswer.input.context.resume_session_id, "01a185ae-2681-74a1-96c4-d9c5007f9ef8");
    const reviewer = await prepareStageInput({ root: workerRoot, session: controlSession, workflowRef, stageId: "spec_authoring", codexSessionId: "new-session", reviewSubtask: targetId });
    const reviewerId = reviewer.input.execution_id, reviewerRef = `runtime/executions/${reviewerId}/result.json`, reportRef = `runtime/executions/${reviewerId}/review.md`;
    const checklist = ['requirements', 'targets', 'alternatives', 'tradeoffs', 'evidence', 'boundary', 'answered_objections'].map((item) => `- [ ] AD-001 / ${item} — 검토 필요`).join('\n') + '\n';
    await writeFile(join(taskSession, reportRef), checklist);
    await writeFile(join(taskSession, reviewerRef), JSON.stringify({ schema_version: 1, execution_id: reviewerId, skill: "architecture-review", status: "completed", code: "OK", summary: "Reviewed", artifacts: [{ kind: "architecture_review", base: "session", path: reportRef }], details: {} }));
    await writeFile(join(taskSession, `runtime/executions/${reviewerId}/return.json`), JSON.stringify({ schema_version: 1, execution_id: reviewerId, skill: "architecture-review", status: "completed", code: "OK", result_ref: reviewerRef }));
    await recordExecutionState({ root: workerRoot, input: reviewer.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "running" });
    await recordExecutionState({ root: workerRoot, input: reviewer.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "completed", code: "OK", result_ref: reviewerRef });
    const reviewed = await prepareStageInput({ root: workerRoot, session: controlSession, workflowRef, stageId: "spec_authoring", codexSessionId: "new-session", reviewSubtask: targetId, reviewResult: reviewerId });
    assert.equal(reviewed.input.context.review_result.execution_id, reviewerId);
    assert.equal(reviewed.input.context.resume_session_id, "01a185ae-2681-74a1-96c4-d9c5007f9ef8");
    await writeFile(join(taskSession, reportRef), checklist);
    await writeFile(join(taskSession, reviewerRef), JSON.stringify({ schema_version: 1, execution_id: reviewerId, skill: "architecture-review", status: "action_required", code: "REVIEW_REQUIRED", summary: "Evidence missing", artifacts: [{ kind: "architecture_review", base: "session", path: reportRef }], details: { outcome: "NEEDS_EVIDENCE" } }));
    await writeFile(join(taskSession, `runtime/executions/${reviewerId}/return.json`), JSON.stringify({ schema_version: 1, execution_id: reviewerId, skill: "architecture-review", status: "action_required", code: "REVIEW_REQUIRED", result_ref: reviewerRef }));
    await recordExecutionState({ root: workerRoot, input: reviewer.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "running" });
    await recordExecutionState({ root: workerRoot, input: reviewer.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "action_required", code: "REVIEW_REQUIRED", result_ref: reviewerRef });
    const unresolved = await prepareStageInput({ root: workerRoot, session: controlSession, workflowRef, stageId: "spec_authoring", codexSessionId: "new-session", reviewSubtask: targetId, reviewResult: reviewerId });
    assert.ok(unresolved.input.input_refs.some((ref) => ref.path === reportRef));
    const childReturn = { schema_version: 1, execution_id: childId, skill: "code-research", status: "completed", code: "OK", result_ref: childRef };
    const childResult = { schema_version: 1, execution_id: childId, skill: "code-research", status: "completed", code: "OK", summary: "Inspected", artifacts: [], details: {} };
    await writeFile(join(taskSession, childRef), JSON.stringify(childResult));
    await writeFile(join(taskSession, `runtime/executions/${childId}/return.json`), JSON.stringify(childReturn));
    await recordExecutionState({ root: workerRoot, input: child.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "running" });
    await recordExecutionState({ root: workerRoot, input: child.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "completed", code: "OK", result_ref: childRef });
    const resumed = await prepareStageInput({ root: workerRoot, session: controlSession, workflowRef, stageId: "spec_authoring", codexSessionId: "new-session", subtaskResult: childId });
    assert.equal(resumed.input.context.subtask_result_execution_id, childId);
    assert.equal(resumed.input.context.previous_result_ref, parentRef);
    const resumedId = resumed.input.execution_id, resumedRef = `runtime/executions/${resumedId}/result.json`, questionRef = `runtime/executions/${resumedId}/question.json`;
    const question = { question_id: "followup", question: "계속할까요?", options: [{ id: "yes", label: "진행", consequence: "진행한다" }, { id: "no", label: "중단", consequence: "중단한다" }], recommended_option_id: "yes", rationale: "요청된 진행" };
    await writeFile(join(taskSession, questionRef), JSON.stringify(question));
    await writeFile(join(taskSession, resumedRef), JSON.stringify({ schema_version: 1, execution_id: resumedId, skill: "spec-me", status: "action_required", code: "USER_DECISION_REQUIRED", summary: "Decision", artifacts: [{ kind: "user_question", base: "session", path: questionRef }], details: {} }));
    await writeFile(join(taskSession, `runtime/executions/${resumedId}/return.json`), JSON.stringify({ schema_version: 1, execution_id: resumedId, skill: "spec-me", status: "action_required", code: "USER_DECISION_REQUIRED", result_ref: resumedRef }));
    await writeFile(join(taskSession, `runtime/executions/${resumedId}/exec.stderr.json`), JSON.stringify({ thread_id: "01a185ae-2681-74a1-96c4-d9c5007f9ef8" }));
    await recordExecutionState({ root: workerRoot, input: resumed.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "running" });
    await recordExecutionState({ root: workerRoot, input: resumed.input, binding: { model: "test-model", reasoning_effort: "low" }, status: "action_required", code: "USER_DECISION_REQUIRED", result_ref: resumedRef });
    const afterQuestion = await prepareStageInput({ root: workerRoot, session: controlSession, workflowRef, stageId: "spec_authoring", codexSessionId: "new-session", answer: "진행" });
    assert.deepEqual(afterQuestion.input.context.completed_subtasks.map((item) => item.execution_id), [childId]);

    await writeFile(join(workerRoot, "application.txt"), "application change\n");
    const doctor = await runDoctor({ root: workerRoot, sourceRoot: REPOSITORY_ROOT });
    assert.ok(!doctor.diagnostics.some((item) => item.severity === "error" && item.path.endsWith("stage-input.mjs")));
    const reviewGuide = ".codex/internal-skills/architecture-review/GUIDE.md";
    const reviewRole = ".codex/agents/architecture_review_lead.toml";
    assert.match(await readFile(join(workerRoot, reviewGuide), "utf8"), /Decision별 체크박스/);
    assert.match(await readFile(join(workerRoot, reviewGuide), "utf8"), /원문을 다시 읽거나 기존 근거의 신뢰성을 반복 심사하지 않는다/);
    assert.match(await readFile(join(workerRoot, reviewRole), "utf8"), /carry forward unaffected checked items/);
    for (const path of [".codex/internal-skills/grill-with-docs/GUIDE.md", ".codex/internal-skills/grill-with-docs/references/how-to-grill.md", ".codex/internal-skills/architecture-review/GUIDE.md", ".codex/internal-skills/architecture-spec/GUIDE.md", ".codex/internal-skills/architecture-spec/references/topics.md", ".codex/internal-skills/product-spec/GUIDE.md", reviewRole]) {
      const expected = (await readFile(join(REPOSITORY_ROOT, path), "utf8")).replaceAll(".codex/skills/", ".agents/skills/");
      assert.equal(await readFile(join(workerRoot, path), "utf8"), expected);
      for (const link of expected.matchAll(/\[grilling\]\(([^)]+)\)/g)) assert.ok(await readFile(resolve(dirname(join(workerRoot, path)), link[1]), "utf8"));
      assert.equal(spawnSync("git", ["check-ignore", "-v", path], { cwd: workerRoot }).status, 0);
      assert.ok(!doctor.diagnostics.some((item) => item.severity === "error" && item.path?.endsWith(path)));
    }
    for (const skill of ["grilling", "spec-me", "orchestrator"]) {
      const path = `.agents/skills/${skill}/SKILL.md`;
      const expected = (await readFile(join(REPOSITORY_ROOT, `.codex/skills/${skill}/SKILL.md`), "utf8")).replaceAll(".codex/skills/", ".agents/skills/");
      assert.equal(await readFile(join(workerRoot, path), "utf8"), expected);
      assert.equal(spawnSync("git", ["check-ignore", "-v", path], { cwd: workerRoot }).status, 0);
    }
    assert.ok(!doctor.diagnostics.some((item) => item.severity === "error" && (item.path.endsWith(reviewGuide) || item.path.endsWith(reviewRole))));
    for (const path of [reviewGuide, reviewRole]) assert.equal(spawnSync("git", ["check-ignore", "-v", path], { cwd: workerRoot }).status, 0);
    assert.equal(spawnSync("git", ["check-ignore", "-v", ".codex/harness-runtime/src/workflow/stage-input.mjs"], { cwd: workerRoot }).status, 0);
    const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: workerRoot, encoding: "utf8" }).stdout;
    assert.match(status, /application\.txt/);
    assert.doesNotMatch(status, /\.codex\/harness-runtime|runtime\/executions/);
  } finally {
    await rm(workerRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("installed plan-review runtime reads Specs and plans without a separate coverage file", async () => {
  const targetRoot = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), "plan-review-install-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: targetRoot }).status, 0);
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot, initialize: true });
    await protectLocalInstallArtifacts(targetRoot, REPOSITORY_ROOT);
    await mkdir(join(targetRoot, "docs/specs/42"), { recursive: true });
    await mkdir(join(targetRoot, "docs/plans/42"), { recursive: true });
    await writeFile(join(targetRoot, "docs/specs/42/product-spec.md"), "# Product\n## Stable\nKeep\n## Changed\nBefore\n");
    await writeFile(join(targetRoot, "docs/specs/42/architecture-spec.md"), "# Architecture\n");
    await writeFile(join(targetRoot, "docs/plans/42/plans.md"), "# Plans\n- Product Spec: `docs/specs/42/product-spec.md`\n- Architecture Spec: `docs/specs/42/architecture-spec.md`\n");
    await writeFile(join(targetRoot, "docs/plans/42/plan-a.md"), "# Plan A\n");
    const installedRuntime = await import(pathToFileURL(join(targetRoot, ".codex/harness-runtime/src/workflow/plan-review.mjs")));
    const snapshot = await installedRuntime.snapshotPlanSet({ root: targetRoot, planSetId: "42" });
    assert.deepEqual(snapshot.plans.map(({ id }) => id), ["plan-a"]);
    const cli = join(targetRoot, ".codex/scripts/harness-plan-review.mjs");
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: targetRoot, encoding: "utf8" });
    const first = run("begin", "--root", targetRoot, "--plan-set", "42");
    assert.equal(first.status, 0, first.stderr);
    const admitted = JSON.parse(first.stdout);
    assert.equal(admitted.review_delta.mode, "full");
    const { sessionOutputPath } = await import("../src/workflow/session-output.mjs");
    const reviewFile = sessionOutputPath(targetRoot, "runtime/reviews/installed.json");
    await writeFile(reviewFile, JSON.stringify({ plan_set_id: "42", reviewer_id: "first", author_ids: ["writer"], fork_turns: "none", verdict: "pass", findings: [], inputs: admitted.inputs }));
    assert.equal(run("record", "--root", targetRoot, "--plan-set", "42", "--attempt", admitted.attempt_id, "--reviews", "runtime/reviews/installed.json").status, 0);
    await writeFile(join(targetRoot, "docs/specs/42/product-spec.md"), "# Product\n## Stable\nKeep\n## Changed\nAfter\n");
    assert.notEqual(run("check", "--root", targetRoot, "--plan-set", "42", "--phase", "planning").status, 0);
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    const second = run("begin", "--root", targetRoot, "--plan-set", "42");
    assert.equal(second.status, 0, second.stderr);
    const delta = JSON.parse(second.stdout).review_delta;
    assert.equal(delta.mode, "incremental");
    assert.deepEqual(delta.changed.map((item) => item.path), ["docs/specs/42/product-spec.md"]);
    assert.deepEqual(delta.changed[0].sections.map((section) => section.heading), ["## Changed"]);
    const lock = JSON.parse(await readFile(join(targetRoot, ".codex/harness-lock.json"), "utf8"));
    assert.ok(lock.files[".codex/harness-runtime/src/workflow/review-delta.mjs"]);
    assert.equal(spawnSync("git", ["check-ignore", "-v", ".codex/harness-runtime/src/workflow/review-delta.mjs"], { cwd: targetRoot }).status, 0);
    const doctor = await runDoctor({ root: targetRoot, sourceRoot: REPOSITORY_ROOT });
    assert.ok(!doctor.diagnostics.some((item) => item.path?.endsWith("/review-delta.mjs")), JSON.stringify(doctor.diagnostics));
    await writeFile(join(targetRoot, "docs/specs/42/request.md"), "# Request\nTest\n");
    await writeFile(join(targetRoot, "docs/specs/42/architecture-spec.md"), "# Architecture\n## Stable\nKeep\n## Change\nBefore\n");
    const specCli = join(targetRoot, ".codex/scripts/harness-spec-review.mjs");
    const specRun = (...args) => spawnSync(process.execPath, [specCli, ...args], { cwd: targetRoot, encoding: "utf8" });
    const specFirst = specRun("begin", "--root", targetRoot, "--ticket", "42", "--axis", "architecture");
    assert.equal(specFirst.status, 0, specFirst.stderr);
    const specAdmission = JSON.parse(specFirst.stdout);
    const specReviewFile = sessionOutputPath(targetRoot, "runtime/reviews/installed-spec.json");
    await writeFile(specReviewFile, JSON.stringify({ architecture: { axis: "architecture", ticket_id: "42", reviewer_id: "spec-first", author_ids: ["writer"], fork_turns: "none", verdict: "pass", findings: [], inputs: specAdmission.inputs } }));
    assert.equal(specRun("record", "--root", targetRoot, "--ticket", "42", "--axis", "architecture", "--attempt", specAdmission.attempt_id, "--reviews", "runtime/reviews/installed-spec.json").status, 0);
    await writeFile(join(targetRoot, "docs/specs/42/architecture-spec.md"), "# Architecture\n## Stable\nKeep\n## Change\nAfter\n");
    assert.notEqual(specRun("check", "--root", targetRoot, "--ticket", "42", "--axis", "architecture", "--reviews", "runtime/reviews/installed-spec.json").status, 0);
    const specSecond = specRun("begin", "--root", targetRoot, "--ticket", "42", "--axis", "architecture");
    assert.equal(specSecond.status, 0, specSecond.stderr);
    const specDelta = JSON.parse(specSecond.stdout).review_delta;
    assert.deepEqual(specDelta.changed.map((item) => item.path), ["docs/specs/42/architecture-spec.md"]);
    assert.deepEqual(specDelta.changed[0].sections.map((section) => section.heading), ["## Change"]);
    assert.equal(spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: targetRoot, encoding: "utf8" }).stdout.includes("docs/plans/42/plan-a.md"), true);
    assert.equal(spawnSync("git", ["check-ignore", "-v", ".codex/harness-runtime/src/workflow/plan-review.mjs"], { cwd: targetRoot }).status, 0);
    assert.ok(!Object.keys(snapshot.inputs).some((path) => path.endsWith("traceability.json")));
  } finally { await rm(targetRoot, { recursive: true, force: true }); }
});

test("installed GitHub-only tracker checks without creating Beads or hiding project files", async () => {
  const root = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), 'github-only-install-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot: root, initialize: true });
    await protectLocalInstallArtifacts(root, REPOSITORY_ROOT);
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
    await writeFile(join(root, '.codex/harness.yaml'), 'tracker:\n  mode: github\n  github:\n    repository: owner/repo\n    project_owner: owner\n    project_number: 4\n    status_field: Workflow Status\nbeads:\n  enabled: false\n');
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), '# Project guidance\n');
    const runtime = await import(pathToFileURL(join(root, '.codex/harness-runtime/src/tracker/lifecycle.mjs')));
    const run = async (command, args) => {
      if (command === 'bd') throw new Error('Beads must not run');
      if (args[1] === 'view') return JSON.stringify({ id: 'project' });
      if (args[1] === 'field-list') return JSON.stringify({ fields: [{ id: 'field', name: 'Workflow Status', type: 'ProjectV2SingleSelectField', options: ['Planned', 'In Progress', 'Blocked', 'Done'].map((name) => ({ id: name, name })) }] });
      return JSON.stringify({ data: { repository: { issue_0: { state: 'OPEN', projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'item', project: { id: 'project' }, fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'Planned', field: { id: 'field' } }] } }] } } } } });
    };
    assert.equal((await runtime.inspectTrackerSync({ workspace_root: root, ticket_refs: ['owner/repo#7'], run })).status, 'pass');
    const status = spawnSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).stdout;
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.doesNotMatch(status, /\.codex\/harness-runtime/);
    assert.equal(spawnSync('git', ['check-ignore', '-v', '.codex/harness-runtime/src/tracker/lifecycle.mjs'], { cwd: root }).status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovery skill survives fresh install, diagnosed loss and update while project files remain visible", async () => {
  const targetRoot = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), "recovery-install-"));
  const skillPath = ".agents/skills/harness-recover/SKILL.md";
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: targetRoot }).status, 0);
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot, initialize: true });
    await protectLocalInstallArtifacts(targetRoot, REPOSITORY_ROOT);
    const expected = (await readFile(join(REPOSITORY_ROOT, ".codex/skills/harness-recover/SKILL.md"), "utf8")).replaceAll(".codex/skills/", ".agents/skills/");
    assert.equal(await readFile(join(targetRoot, skillPath), "utf8"), expected);
    const implementSkillPath = ".agents/skills/implement-wrapper/SKILL.md";
    const expectedImplementSkill = (await readFile(join(REPOSITORY_ROOT, ".codex/skills/implement-wrapper/SKILL.md"), "utf8")).replaceAll(".codex/skills/", ".agents/skills/");
    assert.equal(await readFile(join(targetRoot, implementSkillPath), "utf8"), expectedImplementSkill);
    const trackerReferences = ["github", "local-markdown"].map((mode) => `.agents/skills/implement-wrapper/references/tracker/${mode}.md`);
    for (const relativePath of trackerReferences) {
      const sourcePath = relativePath.replace(".agents/skills/", ".codex/skills/");
      const expectedReference = (await readFile(join(REPOSITORY_ROOT, sourcePath), "utf8")).replaceAll(".codex/skills/", ".agents/skills/");
      assert.equal(await readFile(join(targetRoot, relativePath), "utf8"), expectedReference);
    }
    const docs = ["docs/agents/EXEC.md", "docs/agents/execution.json", "docs/contracts/product.md"];
    for (const path of docs) {
      await mkdir(dirname(join(targetRoot, path)), { recursive: true });
      await writeFile(join(targetRoot, path), "Application-owned preparation\n");
    }
    await unlink(join(targetRoot, skillPath));
    await writeFile(join(targetRoot, implementSkillPath), "stale implementation skill\n");
    await writeFile(join(targetRoot, trackerReferences[0]), "stale tracker reference\n");
    const broken = await runDoctor({ root: targetRoot, sourceRoot: REPOSITORY_ROOT });
    assert.ok(broken.diagnostics.some((item) => item.code === "installer_missing_file" && item.path === join(targetRoot, skillPath)));
    const updated = await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.ok(updated.updated.includes(skillPath) || updated.added.includes(skillPath));
    assert.ok(updated.updated.includes(implementSkillPath));
    assert.ok(updated.updated.includes(trackerReferences[0]));
    assert.equal(await readFile(join(targetRoot, skillPath), "utf8"), expected);
    assert.equal(await readFile(join(targetRoot, implementSkillPath), "utf8"), expectedImplementSkill);
    assert.equal(await readFile(join(targetRoot, trackerReferences[0]), "utf8"), (await readFile(join(REPOSITORY_ROOT, ".codex/skills/implement-wrapper/references/tracker/github.md"), "utf8")).replaceAll(".codex/skills/", ".agents/skills/"));
    const lock = await buildHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.ok(lock.files[skillPath]);
    for (const path of trackerReferences) assert.ok(lock.files[path]);
    const healthy = await runDoctor({ root: targetRoot, sourceRoot: REPOSITORY_ROOT });
    assert.ok(!healthy.diagnostics.some((item) => item.path === join(targetRoot, skillPath)));
    assert.ok(!healthy.diagnostics.some((item) => item.path === join(targetRoot, implementSkillPath)));
    for (const path of trackerReferences) assert.ok(!healthy.diagnostics.some((item) => item.path === join(targetRoot, path)));
    const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: targetRoot, encoding: "utf8" }).stdout;
    assert.doesNotMatch(status, /\.agents\/|\.codex\/|\.harness\//);
    assert.equal(spawnSync("git", ["check-ignore", "-v", skillPath], { cwd: targetRoot }).status, 0);
    assert.equal(spawnSync("git", ["check-ignore", "-v", implementSkillPath], { cwd: targetRoot }).status, 0);
    for (const path of trackerReferences) assert.equal(spawnSync("git", ["check-ignore", "-v", path], { cwd: targetRoot }).status, 0);
    for (const path of docs) {
      assert.ok(status.includes(path));
      assert.equal(spawnSync("git", ["check-ignore", "-v", path], { cwd: targetRoot }).status, 1);
      assert.equal(await readFile(join(targetRoot, path), "utf8"), "Application-owned preparation\n");
    }
  } finally { await rm(targetRoot, { recursive: true, force: true }); }
});

test("installed eval runtime grades pilot artifacts and remains out of consumer Git", async () => {
  const targetRoot = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), "eval-runtime-install-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: targetRoot }).status, 0);
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot, initialize: true });
    await protectLocalInstallArtifacts(targetRoot, REPOSITORY_ROOT);
    const runtime = join(targetRoot, ".codex/harness-runtime/src/eval");
    const installedContracts = await import(pathToFileURL(join(runtime, "contracts.mjs")).href);
    const { CodexProcessAdapter } = await import(pathToFileURL(join(runtime, "codex-adapter.mjs")).href);
    const { TrajectoryWriter } = await import(pathToFileURL(join(runtime, "journal.mjs")).href);
    const { buildCasePrompt } = await import(pathToFileURL(join(runtime, "runner.mjs")).href);
    const { gradeOutcome } = await import(pathToFileURL(join(runtime, "graders/outcome.mjs")).href);
    assert.ok(installedContracts.REQUIRED_OUTCOME_IDS.has("artifact_written"));
    assert.equal(buildCasePrompt({ id: "route", workflow: "spec-me", dispatch_workflow: false, scenario: { prompt: "Classify this request." } }), "Classify this request.");
    assert.equal(gradeOutcome({
      caseSpec: { required_outcome: ["artifact_written"], outcome_evidence: { artifact_written: { actions: ["write_file"], required_files: [".eval-output/result.json"] } } },
      trajectory: [
        { kind: "tool_call", actor: "codex", correlation_id: "write-1", action: "write_file", target: ".eval-output/result.json" },
        { kind: "tool_result", actor: "codex", correlation_id: "write-1", action: "write_file", target: ".eval-output/result.json", status: "success" },
      ],
      artifactEvidence: { files: [".eval-output/result.json"] },
    }).passed, true);

    const trajectory = await new TrajectoryWriter(join(targetRoot, "trajectory.jsonl"), { streamId: "installed-git-push-inference" }).init();
    const command = "/bin/zsh -lc \"node -e 'console.log(\\\"git push origin main\\\")'\"";
    const event = JSON.stringify({ type: "item.started", item: { id: "local-script", type: "command_execution", command } });
    const execution = await new CodexProcessAdapter().run({
      command: [process.execPath, "-e", `console.log(${JSON.stringify(event)})`],
      cwd: targetRoot,
      trajectory,
    });
    await trajectory.close();
    assert.equal(execution.records[0].action, "command_execution");

    await mkdir(join(targetRoot, "docs/agents"), { recursive: true });
    await writeFile(join(targetRoot, "docs/agents/EXEC.md"), "Project-owned execution contract\n");
    await writeFile(join(targetRoot, "app.js"), "Project-owned application file\n");
    const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: targetRoot, encoding: "utf8" }).stdout;
    assert.doesNotMatch(status, /\.codex\/|\.agents\//);
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.match(status, /app\.js/);
    assert.equal(spawnSync("git", ["check-ignore", "-v", ".codex/harness-runtime/src/eval/contracts.mjs"], { cwd: targetRoot }).status, 0);
    assert.equal(spawnSync("git", ["check-ignore", "-v", "docs/agents/EXEC.md"], { cwd: targetRoot }).status, 1);
  } finally { await rm(targetRoot, { recursive: true, force: true }); }
});

async function makeSourceAndTarget() {
  const sourceRoot = await mkdtemp(join(tmpdir(), "harness-installer-source-"));
  const targetRoot = await mkdtemp(join(tmpdir(), "harness-installer-target-"));
  await Promise.all([
    mkdir(join(sourceRoot, ".codex", "agents"), { recursive: true }),
    mkdir(join(sourceRoot, ".codex", "workflows"), { recursive: true }),
    mkdir(join(sourceRoot, ".codex", "schemas"), { recursive: true }),
    mkdir(join(sourceRoot, ".codex", "scripts"), { recursive: true }),
    mkdir(join(sourceRoot, ".codex", "skills", "alpha"), { recursive: true }),
    mkdir(join(targetRoot, ".codex", "agents"), { recursive: true }),
    mkdir(join(targetRoot, ".codex", "workflows"), { recursive: true }),
    mkdir(join(targetRoot, ".codex", "schemas"), { recursive: true }),
    mkdir(join(targetRoot, ".codex", "scripts"), { recursive: true }),
    mkdir(join(targetRoot, ".agents", "skills", "alpha"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(sourceRoot, ".codex", "harness.yaml"), "tracker:\n  mode: github\n", "utf8"),
    writeFile(join(sourceRoot, ".codex", "agents", "runner.toml"), "developer_instructions = '.codex/skills/alpha/SKILL.md'\n", "utf8"),
    writeFile(join(sourceRoot, ".codex", "workflows", "review.yaml"), "schema_version: 1\nid: review\n", "utf8"),
    writeFile(join(sourceRoot, ".codex", "schemas", "case.yaml"), "schema_version: 1\n", "utf8"),
    writeFile(join(sourceRoot, ".codex", "scripts", "runner.mjs"), "console.log('runner');\n", "utf8"),
    writeFile(join(sourceRoot, ".codex", "skills", "alpha", "SKILL.md"), "# alpha\n", "utf8"),
    writeFile(join(targetRoot, ".codex", "harness.yaml"), "tracker:\n  mode: github\n", "utf8"),
    writeFile(join(targetRoot, ".codex", "agents", "runner.toml"), "developer_instructions = '.agents/skills/alpha/SKILL.md'\n", "utf8"),
    writeFile(join(targetRoot, ".codex", "workflows", "review.yaml"), "schema_version: 1\nid: review\n", "utf8"),
    writeFile(join(targetRoot, ".codex", "schemas", "case.yaml"), "schema_version: 1\n", "utf8"),
    writeFile(join(targetRoot, ".codex", "scripts", "runner.mjs"), "console.log('runner');\n", "utf8"),
    writeFile(join(targetRoot, ".agents", "skills", "alpha", "SKILL.md"), "# alpha\n", "utf8"),
  ]);
  return { sourceRoot, targetRoot };
}

test("lock generation records managed assets but excludes project harness config", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();

  const lock = await buildHarnessLock({ sourceRoot, targetRoot });

  assert.equal(lock.files[".codex/harness.yaml"], undefined);
  assert.equal(lock.files[".codex/agents/runner.toml"].source_transform, "project-local-paths-v1");
  assert.equal(Object.keys(lock.files).length, 5);
});

test("lock generation can leave skipped user-owned files unlocked", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();

  const lock = await buildHarnessLock({ sourceRoot, targetRoot, excludePaths: [".codex/agents/runner.toml"] });

  assert.equal(lock.files[".codex/agents/runner.toml"], undefined);
  assert.equal(lock.files[".codex/harness.yaml"], undefined);
});

test("update replaces safe upstream changes, adds new skills, and preserves local edits", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  await writeFile(join(sourceRoot, ".codex", "agents", "runner.toml"), "developer_instructions = '.codex/skills/alpha/SKILL.md'\nversion = 2\n", "utf8");
  await mkdir(join(sourceRoot, ".codex", "skills", "beta"), { recursive: true });
  await writeFile(join(sourceRoot, ".codex", "skills", "beta", "SKILL.md"), "# beta\n", "utf8");
  await writeFile(join(targetRoot, ".codex", "workflows", "review.yaml"), "local workflow\n", "utf8");

  const result = await updateProject({ sourceRoot, targetRoot });

  assert.deepEqual(result.updated, [".codex/agents/runner.toml"]);
  assert.deepEqual(result.added, [".agents/skills/beta/SKILL.md"]);
  assert.ok(result.skipped.some((entry) => entry.path === ".codex/workflows/review.yaml" && entry.status === "locally_modified"));
  assert.match(await readFile(join(targetRoot, ".codex", "agents", "runner.toml"), "utf8"), /version = 2/);
  assert.equal(await readFile(join(targetRoot, ".agents", "skills", "beta", "SKILL.md"), "utf8"), "# beta\n");
  assert.equal((await readFile(join(targetRoot, ".codex", "harness-lock.json"), "utf8")).includes("beta/SKILL.md"), true);
});

test("update preserves a conflict and restores a missing locked file", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  await writeFile(join(sourceRoot, ".codex", "agents", "runner.toml"), "developer_instructions = '.codex/skills/alpha/SKILL.md'\nsource = 2\n", "utf8");
  await writeFile(join(targetRoot, ".codex", "agents", "runner.toml"), "developer_instructions = '.agents/skills/alpha/SKILL.md'\nlocal = true\n", "utf8");
  await unlink(join(targetRoot, ".codex", "schemas", "case.yaml"));

  const result = await updateProject({ sourceRoot, targetRoot });

  assert.ok(result.skipped.some((entry) => entry.path === ".codex/agents/runner.toml" && entry.status === "conflict"));
  assert.match(await readFile(join(targetRoot, ".codex", "agents", "runner.toml"), "utf8"), /local = true/);
  assert.ok(result.updated.includes(".codex/schemas/case.yaml"));
  assert.equal(await readFile(join(targetRoot, ".codex", "schemas", "case.yaml"), "utf8"), "schema_version: 1\n");
});

test("update adds new workflow and nested schema files to the owned inventory", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  await writeFile(join(sourceRoot, ".codex", "workflows", "new.yaml"), "schema_version: 1\nid: new\n", "utf8");
  await mkdir(join(sourceRoot, ".codex", "schemas", "tracker"), { recursive: true });
  await writeFile(join(sourceRoot, ".codex", "schemas", "tracker", "plan.yaml"), "schema_version: 1\n", "utf8");

  const result = await updateProject({ sourceRoot, targetRoot });

  assert.deepEqual(result.added, [".codex/schemas/tracker/plan.yaml", ".codex/workflows/new.yaml"]);
  assert.equal(await readFile(join(targetRoot, ".codex", "schemas", "tracker", "plan.yaml"), "utf8"), "schema_version: 1\n");
  assert.equal(await readFile(join(targetRoot, ".codex", "workflows", "new.yaml"), "utf8"), "schema_version: 1\nid: new\n");
});

test("update discovers and installs decision schemas, CLI scripts, workflows, and source skills", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  const assets = {
    ".codex/schemas/decision/system-targets.schema.yaml": "schema_version: 1\nid: system-targets\n",
    ".codex/scripts/harness-decision-gate.mjs": "console.log('gate');\n",
    ".codex/workflows/spec-me.yaml": "schema_version: 1\nid: spec-me\n",
    ".codex/skills/decision-targets/SKILL.md": "# decision targets\n",
  };
  for (const [path, content] of Object.entries(assets)) {
    const sourcePath = join(sourceRoot, path);
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, content, "utf8");
  }

  const result = await updateProject({ sourceRoot, targetRoot });

  assert.deepEqual(result.added, [
    ".agents/skills/decision-targets/SKILL.md",
    ".codex/schemas/decision/system-targets.schema.yaml",
    ".codex/scripts/harness-decision-gate.mjs",
    ".codex/workflows/spec-me.yaml",
  ]);
  assert.equal(await readFile(join(targetRoot, ".agents/skills/decision-targets/SKILL.md"), "utf8"), "# decision targets\n");
  assert.equal(await readFile(join(targetRoot, ".codex/schemas/decision/system-targets.schema.yaml"), "utf8"), assets[".codex/schemas/decision/system-targets.schema.yaml"]);
  assert.equal(await readFile(join(targetRoot, ".codex/scripts/harness-decision-gate.mjs"), "utf8"), assets[".codex/scripts/harness-decision-gate.mjs"]);
  assert.equal(await readFile(join(targetRoot, ".codex/workflows/spec-me.yaml"), "utf8"), assets[".codex/workflows/spec-me.yaml"]);
});

test("update deploys skill references and backs up their local conflict edits", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  const sourcePath = join(sourceRoot, ".codex/skills/alpha/references/model.md");
  const targetPath = join(targetRoot, ".agents/skills/alpha/references/model.md");
  try {
    await writeHarnessLock({ sourceRoot, targetRoot });
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "upstream v1\n");
    const added = await updateProject({ sourceRoot, targetRoot });
    assert.ok(added.added.includes(".agents/skills/alpha/references/model.md"));
    assert.equal(await readFile(targetPath, "utf8"), "upstream v1\n");
    await writeFile(sourcePath, "upstream v2\n");
    await updateProject({ sourceRoot, targetRoot });
    assert.equal(await readFile(targetPath, "utf8"), "upstream v2\n");
    await writeFile(targetPath, "local model\n");
    await writeFile(sourcePath, "upstream v3\n");
    const updated = await updateProject({ sourceRoot, targetRoot });
    assert.ok(updated.updated.includes(".agents/skills/alpha/references/model.md"));
    assert.equal(await readFile(targetPath, "utf8"), "upstream v3\n");
    assert.equal(await readFile(join(updated.backup_directory, ".agents/skills/alpha/references/model.md"), "utf8"), "local model\n");
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("update skips installation into a recognized Harness source checkout worktree", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  const packageJson = `${JSON.stringify({ name: "@example/harness-codex" })}\n`;
  await Promise.all([
    writeFile(join(sourceRoot, "package.json"), packageJson, "utf8"),
    writeFile(join(targetRoot, "package.json"), packageJson, "utf8"),
  ]);
  for (const relativePath of ["bin/harness-install.mjs", "src/installer/update.mjs", ".codex/skills/spec-me/SKILL.md"]) {
    const path = join(targetRoot, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "source checkout marker\n", "utf8");
  }

  const result = await updateProject({ sourceRoot, targetRoot });

  assert.deepEqual(result.skipped, [{ path: ".codex", status: "source_checkout" }]);
  await assert.rejects(() => readFile(join(targetRoot, ".codex/harness-lock.json")), { code: "ENOENT" });
});

test("update installs project-local runtime scripts and tracks them as owned", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  await writeFile(join(sourceRoot, ".codex", "scripts", "harness-workspace-preflight.mjs"), "console.log('ready');\n", "utf8");

  const result = await updateProject({ sourceRoot, targetRoot });

  assert.deepEqual(result.added, [".codex/scripts/harness-workspace-preflight.mjs"]);
  assert.equal(await readFile(join(targetRoot, ".codex", "scripts", "harness-workspace-preflight.mjs"), "utf8"), "console.log('ready');\n");
  const lock = await buildHarnessLock({ sourceRoot, targetRoot });
  assert.ok(lock.files[".codex/scripts/harness-workspace-preflight.mjs"]);
});

test("update installs the plans index lifecycle gate for consumer projects", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  const gate = "export function inspectPlansIndex() { return { status: 'pass' }; }\n";
  await writeFile(join(sourceRoot, ".codex", "scripts", "plans-index-gate.mjs"), gate, "utf8");

  const result = await updateProject({ sourceRoot, targetRoot });

  assert.deepEqual(result.added, [".codex/scripts/plans-index-gate.mjs"]);
  assert.equal(await readFile(join(targetRoot, ".codex", "scripts", "plans-index-gate.mjs"), "utf8"), gate);
  const lock = await buildHarnessLock({ sourceRoot, targetRoot });
  assert.ok(lock.files[".codex/scripts/plans-index-gate.mjs"]);
});

test("fresh installation includes the runtime required by the decision gate CLI", async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), "harness-runtime-install-"));
  try {
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    const implementSkill = join(targetRoot, ".codex/internal-skills/implement/GUIDE.md");
    const outcomeGrader = join(targetRoot, ".codex/harness-runtime/src/eval/graders/outcome.mjs");
    const outcomeGraderSource = await readFile(join(REPOSITORY_ROOT, "src/eval/graders/outcome.mjs"), "utf8");
    assert.equal(await readFile(outcomeGrader, "utf8"), outcomeGraderSource);
    const toTicketSkill = join(targetRoot, ".agents/skills/to-ticket/SKILL.md");
    const installedToTicketSkill = await readFile(toTicketSkill, "utf8");
    assert.match(installedToTicketSkill, /`plan_split`/);
    assert.match(installedToTicketSkill, /`plan_review`/);
    assert.match(installedToTicketSkill, /`plan_finalize`/);
    assert.match(installedToTicketSkill, /configured tracker 발행/);
    const planningEvidencePath = ".agents/skills/to-ticket/references/execution-evidence.md";
    const installedPlanningEvidence = await readFile(join(targetRoot, planningEvidencePath), "utf8");
    assert.equal(installedPlanningEvidence, await readFile(join(REPOSITORY_ROOT, ".codex/skills/to-ticket/references/execution-evidence.md"), "utf8"));
    assert.doesNotMatch(installedPlanningEvidence, /PlanCheckpointStore|"traceability"/);
    const installedIssueTemplate = await readFile(join(targetRoot, ".agents/skills/to-ticket/references/github-issue-template.md"), "utf8");
    assert.match(installedIssueTemplate, /verification_files/);
    assert.match(installedIssueTemplate, /verification_command/);
    const completionModule = join(targetRoot, ".codex/harness-runtime/src/workflow/completion.mjs");
    const completionSource = await readFile(join(REPOSITORY_ROOT, "src/workflow/completion.mjs"), "utf8");
    await writeFile(completionModule, "export const staleCompletion = true;\n");
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    const completionUpdate = await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.ok(completionUpdate.updated.includes(".codex/harness-runtime/src/workflow/completion.mjs"));
    assert.equal(await readFile(completionModule, "utf8"), completionSource);
    const internalRelativePath = ".agents/skills/spec-me/references/decision-knowledge.md";
    const internalSkill = join(targetRoot, internalRelativePath);
    const internalSource = await readFile(join(REPOSITORY_ROOT, ".codex/skills/spec-me/references/decision-knowledge.md"), "utf8");
    assert.equal(await readFile(internalSkill, "utf8"), internalSource);
    const specSkill = await readFile(join(targetRoot, ".agents/skills/spec-me/SKILL.md"), "utf8");
    const architectureReference = join(targetRoot, ".agents/skills/spec-me/references/architecture-decision.md");
    assert.equal(await readFile(architectureReference, "utf8"), await readFile(join(REPOSITORY_ROOT, ".codex/skills/spec-me/references/architecture-decision.md"), "utf8"));
    const productGuide = join(targetRoot, ".codex/internal-skills/product-spec/GUIDE.md");
    assert.equal(await readFile(productGuide, "utf8"), await readFile(join(REPOSITORY_ROOT, ".codex/internal-skills/product-spec/GUIDE.md"), "utf8"));
    assert.ok(specSkill.includes("internal-skills/product-spec/GUIDE.md"));
    assert.ok(specSkill.includes("references/architecture-decision.md"));
    await assert.rejects(readFile(join(targetRoot, ".agents/skills/decision-knowledge/SKILL.md")), { code: "ENOENT" });
    await writeFile(internalSkill, "stale internal guidance\n");
    const distributionRule = /trace it through managed asset discovery and transforms, fresh installation, (?:and )?update/;
    const installedImplementGuide = await readFile(implementSkill, "utf8");
    assert.match(installedImplementGuide, distributionRule);
    assert.match(installedImplementGuide, /workflow runtime dispatch의 `before_dispatch` workspace gate가 수행한다/);
    assert.doesNotMatch(installedImplementGuide, /node \.codex\/scripts\/harness-workspace-preflight\.mjs/);
    assert.match(installedImplementGuide, /구현 agent는 setup 복구 절차를 호출하지 않는다/);
    assert.doesNotMatch(installedImplementGuide, /setup의 준비 복구/);
    assert.match(installedImplementGuide, /<shared_guidance_root>\/docs\/agents\/testing-guidance\.md.*before planning, writing, modifying, selecting, or running any test/);
    const installedSkillExecutionGuide = await readFile(join(targetRoot, ".codex/internal-skills/skill-execution/GUIDE.md"), "utf8");
    assert.match(installedSkillExecutionGuide, /shared_guidance_root.*Git common directory.*--add-dir/s);
    assert.match(installedSkillExecutionGuide, /입력 JSON의 `workspace_root`를 `--root`에, `session_directory`를 `--session-directory`에 그대로 전달한다/);
    const installedSpecWriter = await readFile(join(targetRoot, ".codex/agents/spec_document_writer.toml"), "utf8");
    assert.match(installedSpecWriter, /Spec authoring does not run them, and missing execution documentation alone does not block writing a Spec/);
    const installedCodeResearcher = await readFile(join(targetRoot, ".codex/agents/code_researcher.toml"), "utf8");
    assert.match(installedCodeResearcher, /their absence alone does not block read-only code research/);
    const installedArchitectureGuide = await readFile(join(targetRoot, ".codex/internal-skills/architecture-spec/GUIDE.md"), "utf8");
    assert.match(installedArchitectureGuide, /does not require `docs\/agents\/EXEC\.md` or `docs\/agents\/execution\.json` to exist/);
    assert.match(installedImplementGuide, /plan's unit tests in this implementation slot/);
    assert.match(installedImplementGuide, /Do not run feature-level E2E at an individual plan boundary/);
    const installedWrapperSkill = await readFile(join(targetRoot, ".agents/skills/implement-wrapper/SKILL.md"), "utf8");
    const installedReusableTestingGuide = await readFile(join(targetRoot, ".codex/internal-skills/testing-guidance/GUIDE.md"), "utf8");
    assert.equal(installedReusableTestingGuide, await readFile(join(REPOSITORY_ROOT, ".codex/internal-skills/testing-guidance/GUIDE.md"), "utf8"));
    await writeFile(implementSkill, "stale consumer copy\n");
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.equal(await readFile(internalSkill, "utf8"), internalSource);
    const internalLock = await buildHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.ok(internalLock.files[internalRelativePath]);
    assert.match(await readFile(implementSkill, "utf8"), distributionRule);
    const targets = {
      schema_version: 1,
      id: "system-targets",
      system_characteristics: {
        interaction: "CLI workflow.",
        workload: "On-demand checks.",
        state: "Project-local YAML.",
        consistency: "Atomic file replacement.",
        availability: "Node.js during command execution.",
        growth: "No expected service traffic.",
      },
      initial: [],
      expected_growth: [],
      architecture_boundary: [],
    };
    await writeSystemTargets({ root: targetRoot, ticketId: "514", targets });

    const runtimePath = join(targetRoot, ".codex", "harness-runtime", "src", "workflow", "stage-gates.mjs");
    assert.match(await readFile(runtimePath, "utf8"), /evaluateSystemTargetsComplete/);
    const lock = await buildHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.ok(lock.files[".codex/harness-runtime/src/workflow/stage-gates.mjs"]);
    const result = spawnSync(process.execPath, [join(targetRoot, ".codex", "scripts", "harness-decision-gate.mjs"), "system_targets_complete", "--ticket", "514"], { cwd: targetRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "pass");

    const knowledgeCli = spawnSync(process.execPath, [join(targetRoot, ".codex", "scripts", "harness-knowledge.mjs")], { cwd: targetRoot, encoding: "utf8" });
    assert.equal(knowledgeCli.status, 1);
    assert.match(knowledgeCli.stderr, /Usage: harness-knowledge\.mjs/);
    assert.doesNotMatch(knowledgeCli.stderr, /ERR_MODULE_NOT_FOUND/);

    const trackerRuntime = join(targetRoot, ".codex", "harness-runtime", "src", "tracker", "lifecycle.mjs");
    assert.match(await readFile(trackerRuntime, "utf8"), /inspectTrackerSync/);
    const trackerCli = spawnSync(process.execPath, [join(targetRoot, ".codex", "scripts", "harness-tracker.mjs")], { cwd: targetRoot, encoding: "utf8" });
    assert.equal(trackerCli.status, 1);
    assert.match(trackerCli.stderr, /Usage: harness-tracker\.mjs/);
    assert.doesNotMatch(trackerCli.stderr, /ERR_MODULE_NOT_FOUND/);

    for (const module of ["src/workflow/worktrees.mjs", "src/workflow/completion.mjs"]) {
      await readFile(join(targetRoot, ".codex", "harness-runtime", module), "utf8");
    }
    for (const script of ["harness-workflow-worktree.mjs", "harness-workflow-complete.mjs"]) {
      const result = spawnSync(process.execPath, [join(targetRoot, ".codex", "scripts", script)], { cwd: targetRoot, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
    }
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("installed setup commits only its preparation files and preserves pre-existing staged work", async () => {
  const { root, cleanup } = await makeContractsFixture();
  try {
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot: root, initialize: true });
    await protectLocalInstallArtifacts(root, REPOSITORY_ROOT);
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
    const skill = await readFile(join(root, '.agents/skills/setup/SKILL.md'), 'utf8');
    assert.match(skill, /git commit --only/);
    assert.match(skill, /설치 전 이미 변경됐거나 미추적이던 사용자 파일은 포함하지 않는다/);
    await writeFile(join(root, 'user-work.txt'), 'pre-existing staged work\n');
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(git('add', '--', 'user-work.txt').status, 0);
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), '# Setup guidance\n');
    await writeFile(join(root, 'docs/agents/execution.json'), '{"schema_version":1,"profiles":{}}\n');
    const paths = ['docs/agents/EXEC.md', 'docs/agents/execution.json'];
    assert.equal(git('add', '--', ...paths).status, 0);
    const committed = git('commit', '--only', '-m', 'chore: initialize harness setup', '--', ...paths);
    assert.equal(committed.status, 0, committed.stderr);
    const committedPaths = git('show', '--format=', '--name-only', 'HEAD').stdout.trim().split('\n').sort();
    assert.deepEqual(committedPaths, [...paths].sort());
    assert.match(git('status', '--short', '--untracked-files=all').stdout, /^A  user-work\.txt/m);
    assert.equal(await readFile(join(root, 'user-work.txt'), 'utf8'), 'pre-existing staged work\n');
    assert.equal(git('check-ignore', '-v', '.codex/scripts/harness-setup.mjs').status, 0);
    assert.notEqual(git('check-ignore', 'docs/agents/EXEC.md').status, 0);
    const doctor = await runDoctor({ root, sourceRoot: REPOSITORY_ROOT });
    assert.ok(!doctor.diagnostics.some((item) => item.path?.endsWith('/setup/SKILL.md')), JSON.stringify(doctor.diagnostics));
  } finally { await cleanup(); }
});

test("installed consumer creates an automatically identified owned worktree without hiding application changes", async () => {
  const { root, cleanup } = await makeContractsFixture();
  try {
    await protectLocalInstallArtifacts(root, REPOSITORY_ROOT);
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
    const runtime = join(root, ".codex/harness-runtime/src/workflow/worktrees.mjs");
    const source = await readFile(join(REPOSITORY_ROOT, "src/workflow/worktrees.mjs"), "utf8");
    await writeFile(runtime, "export const staleRuntime = true;\n");
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
    const updated = await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
    assert.ok(updated.updated.includes(".codex/harness-runtime/src/workflow/worktrees.mjs"));
    assert.equal(await readFile(runtime, "utf8"), source);

    await mkdir(join(root, "docs/agents"), { recursive: true });
    await writeFile(join(root, "docs/agents/EXEC.md"), "Project execution and diagram preparation\n");
    await writeFile(join(root, "docs/agents/execution.json"), '{"profiles":{}}\n');
    assert.equal(spawnSync("git", ["add", "docs/agents/EXEC.md", "docs/agents/execution.json"], { cwd: root }).status, 0);
    assert.equal(spawnSync("git", ["commit", "--only", "-m", "chore: initialize harness setup", "--", "docs/agents/EXEC.md", "docs/agents/execution.json"], { cwd: root }).status, 0);

    const cli = join(root, ".codex/scripts/harness-workflow-worktree.mjs");
    const created = spawnSync(process.execPath, [cli, "create", "--root", root], { cwd: root, encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const handle = JSON.parse(created.stdout);
    assert.match(handle.worktree_id, /^[0-9a-f-]{36}$/);
    assert.equal(handle.source_workspace, root);
    assert.notEqual(handle.workspace, root);
    assert.equal(handle.state, "active");
    assert.equal(await readFile(join(handle.workspace, "docs/agents/EXEC.md"), "utf8"), "Project execution and diagram preparation\n");
    assert.equal(await readFile(join(handle.workspace, "docs/agents/execution.json"), "utf8"), '{"profiles":{}}\n');
    assert.ok((await readFile(join(handle.workspace, ".codex/tools/plantuml-render.mjs"), "utf8")).includes("PlantUML"));
    assert.equal(spawnSync("git", ["check-ignore", "docs/agents/EXEC.md"], { cwd: handle.workspace }).status, 1);
    assert.doesNotMatch(created.stdout, /workflow_id/);
    const sessionRecord = JSON.parse(await readFile(join(handle.session_directory, "worktree.json"), "utf8"));
    assert.equal(sessionRecord.worktree_id, handle.worktree_id);
    assert.equal("plan_set_id" in sessionRecord, false, "fresh Spec worktrees start without inheriting a plan set");
    const bound = spawnSync(process.execPath, [cli, "bind-plan-set-id", "--root", handle.workspace, "--feature-name", "Solo TRPG D6 narration"], { cwd: handle.workspace, encoding: "utf8" });
    assert.equal(bound.status, 0, bound.stderr);
    const planSetId = "solo-trpg-d6-narration";
    assert.equal(JSON.parse(bound.stdout).plan_set_id, planSetId);
    const installedWorktreeRecord = JSON.parse(await readFile(join(handle.session_directory, "worktree.json"), "utf8"));
    assert.equal(installedWorktreeRecord.plan_set_id, planSetId);
    await mkdir(join(handle.workspace, "docs/specs", planSetId), { recursive: true });
    await mkdir(join(handle.workspace, "docs/plans", planSetId), { recursive: true });
    await writeFile(join(handle.workspace, "docs/specs", planSetId, "product-spec.md"), "# Product\n");
    await writeFile(join(handle.workspace, "docs/specs", planSetId, "architecture-spec.md"), "# Architecture\n");
    await writeFile(join(handle.workspace, "docs/plans", planSetId, "plans.md"), `# Plans\n- Product Spec: \`docs/specs/${planSetId}/product-spec.md\`\n- Architecture Spec: \`docs/specs/${planSetId}/architecture-spec.md\`\n`);
    await writeFile(join(handle.workspace, "docs/plans", planSetId, "plan-a.md"), "# Plan A\n");
    const installedPlanReview = await import(pathToFileURL(join(handle.workspace, ".codex/harness-runtime/src/workflow/plan-review.mjs")).href);
    assert.equal((await installedPlanReview.snapshotPlanSet({ root: handle.workspace, planSetId })).plans.length, 1);
    await assert.rejects(installedPlanReview.snapshotPlanSet({ root: handle.workspace, planSetId: "other-set" }), /plan_set_id mismatch/);
    const admittedPlanReview = await installedPlanReview.updatePlanReview({ root: handle.workspace, planSetId, action: "begin" });
    const recordedPlanReview = await installedPlanReview.updatePlanReview({
      root: handle.workspace, planSetId, action: "record", attemptId: admittedPlanReview.attempt_id,
      review: { plan_set_id: planSetId, reviewer_id: "installed-reviewer", author_ids: ["installed-author"], fork_turns: "none", verdict: "pass", findings: [], inputs: admittedPlanReview.inputs },
    });
    assert.equal(recordedPlanReview.status, "pass");
    assert.equal((await installedPlanReview.inspectPlanSet({ root: handle.workspace, planSetId, phase: "planning" })).status, "pass");
    const conflictingBind = spawnSync(process.execPath, [cli, "bind-plan-set-id", "--root", handle.workspace, "--plan-set-id", "43"], { cwd: handle.workspace, encoding: "utf8" });
    assert.equal(conflictingBind.status, 1);
    assert.match(conflictingBind.stderr, /immutable once set/);
    const installedSpecSkill = await readFile(join(handle.workspace, ".agents/skills/spec-me/SKILL.md"), "utf8");
    assert.match(installedSpecSkill, /bind-plan-set-id/);
    assert.match(installedSpecSkill, /Never let a Spec writer, diagram writer, or `to-ticket` choose or rename it/);
    const preflight = spawnSync(process.execPath, [join(root, ".codex/scripts/harness-workspace-preflight.mjs"), "--workspace-root", handle.workspace, "--json"], { cwd: handle.workspace, encoding: "utf8" });
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.equal(JSON.parse(preflight.stdout).is_linked_worktree, true);

    const unrelatedSession = join(root, ".git/harness-workflows/sessions", "f".repeat(64));
    await mkdir(unrelatedSession, { recursive: true });
    await writeFile(join(unrelatedSession, "receipt.json"), JSON.stringify({ schema_version: 1, workflow_id: "execution-run", state: "completed" }));
    const activeList = spawnSync(process.execPath, [cli, "list", "--root", root], { cwd: root, encoding: "utf8" });
    assert.equal(activeList.status, 0, activeList.stderr);
    assert.deepEqual(JSON.parse(activeList.stdout).map(({ worktree_id }) => worktree_id), [handle.worktree_id]);

    const finished = spawnSync(process.execPath, [cli, "finish", "--root", handle.workspace, "--repository", root, "--worktree-id", handle.worktree_id, "--outcome", "completed"], { cwd: root, encoding: "utf8" });
    assert.equal(finished.status, 0, finished.stderr);
    assert.equal(JSON.parse(finished.stdout).state, "removed");
    assert.equal(JSON.parse(await readFile(join(handle.session_directory, "worktree.json"), "utf8")).plan_set_id, planSetId);
    const remaining = spawnSync(process.execPath, [cli, "list", "--root", root], { cwd: root, encoding: "utf8" });
    assert.equal(remaining.status, 0, remaining.stderr);
    assert.deepEqual(JSON.parse(remaining.stdout), []);
    assert.match(spawnSync("git", ["branch", "--list", handle.branch], { cwd: root, encoding: "utf8" }).stdout, new RegExp(handle.branch));

    await writeFile(join(root, "src/app.mjs"), "export const app = 'user change';\n");
    const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.ok(status.stdout.includes(" M src/app.mjs"));
    assert.equal(spawnSync("git", ["check-ignore", "docs/agents/EXEC.md"], { cwd: root }).status, 1);
  } finally { await cleanup(); }
});

test("updated consumer defers only source snapshot drift until final contract synchronization", async (t) => {
  const { root, cleanup } = await makeContractsFixture();
  t.after(cleanup);
  await mkdir(join(root, "docs/agents"), { recursive: true });
  await writeFile(join(root, "docs/agents/EXEC.md"), "Execution instructions\n");
  await writeFile(join(root, "docs/agents/execution.json"), JSON.stringify({ schema_version: 1, profiles: { focused: { purpose: "e2e", command: ["node", "-e", "process.exit(0)"], required_env: [], config_inputs: ["docs/agents/execution.json"], prepare: [["node", "-e", "process.exit(0)"]], verify_config: [["node", "-e", "process.exit(0)"]], dependencies: [], timeout_ms: 1000, readiness_timeout_ms: 100, poll_interval_ms: 10 } } }));
  await writeFile(join(root, "src/app.mjs"), "export const app = 'changed after contract seal';\n");
  await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
  await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });

  const { inspectProjectReadiness } = await import(pathToFileURL(join(root, ".codex/harness-runtime/src/workflow/project-readiness.mjs")));
  const deferred = await inspectProjectReadiness({ workspace_root: root, deferContractSync: true });
  assert.equal(deferred.status, "pass", JSON.stringify(deferred));
  assert.equal(deferred.contract_sync.status, "deferred");
  const preflight = spawnSync(process.execPath, [join(root, ".codex/scripts/harness-workspace-preflight.mjs"), "--workspace-root", root, "--for-implementation", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(preflight.status, 0, preflight.stderr || preflight.stdout);
  assert.equal(JSON.parse(preflight.stdout).contract_sync.status, "deferred");

  await writeFile(join(root, "docs/contracts/manifest.json"), "{");
  const invalid = await inspectProjectReadiness({ workspace_root: root, deferContractSync: true });
  assert.equal(invalid.status, "blocked");
  assert.notEqual(invalid.contract_sync?.status, "deferred");
  const invalidPreflight = spawnSync(process.execPath, [join(root, ".codex/scripts/harness-workspace-preflight.mjs"), "--workspace-root", root, "--for-implementation", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(invalidPreflight.status, 1);
});

test("installed consumer defers contract drift in its verified active worktree only", async (t) => {
  const { root, cleanup } = await makeContractsFixture();
  t.after(cleanup);
  await mkdir(join(root, "docs/agents"), { recursive: true });
  await writeFile(join(root, "docs/agents/EXEC.md"), "Execution instructions\n");
  await writeFile(join(root, "docs/agents/execution.json"), JSON.stringify({ schema_version: 1, profiles: { focused: { purpose: "e2e", command: ["node", "-e", "process.exit(0)"], required_env: [], config_inputs: ["docs/agents/execution.json"], prepare: [["node", "-e", "process.exit(0)"]], verify_config: [["node", "-e", "process.exit(0)"]], dependencies: [], timeout_ms: 1000, readiness_timeout_ms: 100, poll_interval_ms: 10 } } }));
  assert.equal(spawnSync("git", ["add", "docs/agents"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-qm", "prepare"], { cwd: root }).status, 0);
  await protectLocalInstallArtifacts(root, REPOSITORY_ROOT);
  await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot: root, initialize: true });
  const tree = await createWorkflowWorktree({ workspace_root: root, return_root: root });
  try {
    await writeFile(join(tree.workspace, "src/app.mjs"), "export const app = 'draft';\n");
    const installed = await import(pathToFileURL(join(tree.workspace, ".codex/harness-runtime/src/workflow/project-readiness.mjs")));
    const activeReadiness = await installed.inspectProjectReadiness({ workspace_root: tree.workspace, deferActiveWorktree: true });
    assert.equal(activeReadiness.reason, "project_ready_contract_sync_deferred", JSON.stringify(activeReadiness));
    const doctor = await runDoctor({ root: tree.workspace, sourceRoot: REPOSITORY_ROOT });
    assert.ok(doctor.diagnostics.some((item) => item.code === "contract_sync_deferred" && item.severity === "info"));
    assert.ok(!doctor.diagnostics.some((item) => item.code === "project_preparation_required"));
    assert.equal((await installed.inspectProjectReadiness({ workspace_root: tree.workspace })).status, "blocked");
    assert.equal((await installed.inspectProjectReadiness({ workspace_root: root, deferActiveWorktree: true })).status, "pass");
    const status = spawnSync("git", ["status", "--short"], { cwd: tree.workspace, encoding: "utf8" }).stdout;
    assert.match(status, /src\/app\.mjs/);
    assert.doesNotMatch(status, /\.codex\//);
    await writeFile(join(tree.workspace, "docs/contracts/manifest.json"), "{");
    assert.equal((await installed.inspectProjectReadiness({ workspace_root: tree.workspace, deferActiveWorktree: true })).status, "blocked");
  } finally { await finishWorkflowWorktree({ workspace_root: tree.workspace, repository_root: root, worktree_id: tree.worktree_id, outcome: "aborted" }); }
});

test("update installs standalone contracts runtime and preserves a locally edited workflow", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  try {
    await mkdir(join(sourceRoot, "src/contracts"), { recursive: true });
    await mkdir(join(sourceRoot, ".github/workflows"), { recursive: true });
    await writeFile(join(sourceRoot, "src/contracts/contracts.mjs"), "export const runtime = true;\n");
    await writeFile(join(sourceRoot, ".github/workflows/harness-contracts.yml"), "name: contracts v1\n");
    await writeHarnessLock({ sourceRoot, targetRoot });
    const first = await updateProject({ sourceRoot, targetRoot });
    assert.ok(first.added.includes(".harness/contracts.mjs"));
    assert.ok(first.added.includes(".github/workflows/harness-contracts.yml"));
    assert.equal(await readFile(join(targetRoot, ".harness/contracts.mjs"), "utf8"), "export const runtime = true;\n");
    assert.equal(await readFile(join(targetRoot, ".github/workflows/harness-contracts.yml"), "utf8"), "name: contracts v1\n");

    await writeFile(join(targetRoot, ".codex/workflows/review.yaml"), "user workflow\n");
    await writeFile(join(sourceRoot, ".codex/workflows/review.yaml"), "schema_version: 1\nid: review\nversion: 2\n");
    const updated = await updateProject({ sourceRoot, targetRoot });
    assert.ok(updated.skipped.some((entry) => entry.path === ".codex/workflows/review.yaml" && entry.status === "conflict"));
    assert.equal(await readFile(join(targetRoot, ".codex/workflows/review.yaml"), "utf8"), "user workflow\n");
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("install initializes a missing lock and updates are idempotent", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  const first = await updateProject({ sourceRoot, targetRoot, initialize: true });
  assert.ok(first.lock.files[".codex/agents/runner.toml"]);
  const second = await updateProject({ sourceRoot, targetRoot });
  assert.deepEqual(second.updated, []);
  assert.deepEqual(second.added, []);
});

test("default updates replace and back up skill conflicts while preserving agent conflicts", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  const agent = join(targetRoot, ".codex/agents/runner.toml");
  const skill = join(targetRoot, ".agents/skills/alpha/SKILL.md");
  await writeFile(agent, "local agent\n");
  await writeFile(skill, "local skill\n");
  await writeFile(join(sourceRoot, ".codex/agents/runner.toml"), "upstream agent v2\n");
  await writeFile(join(sourceRoot, ".codex/skills/alpha/SKILL.md"), "upstream skill v2\n");

  const defaultUpdate = await updateProject({ sourceRoot, targetRoot });
  assert.equal(await readFile(agent, "utf8"), "local agent\n");
  assert.equal(await readFile(skill, "utf8"), "upstream skill v2\n");
  assert.ok(defaultUpdate.backup_directory);
  assert.equal(await readFile(join(defaultUpdate.backup_directory, ".agents/skills/alpha/SKILL.md"), "utf8"), "local skill\n");
  assert.ok(defaultUpdate.skipped.some((entry) => entry.path === ".codex/agents/runner.toml" && entry.status === "conflict"));
  await writeFile(skill, "local skill v3\n");
  await writeFile(join(sourceRoot, ".codex/skills/alpha/SKILL.md"), "upstream skill v3\n");
  const forced = await updateProject({ sourceRoot, targetRoot, force: true });
  assert.equal(await readFile(agent, "utf8"), "upstream agent v2\n");
  assert.equal(await readFile(skill, "utf8"), "upstream skill v3\n");
  assert.ok(forced.backup_directory);
  assert.equal(await readFile(join(forced.backup_directory, ".codex/agents/runner.toml"), "utf8"), "local agent\n");
  assert.equal(await readFile(join(forced.backup_directory, ".agents/skills/alpha/SKILL.md"), "utf8"), "local skill v3\n");
});

test("default install backs up managed skill collisions, preserves user skills, and avoids repeat backups", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  const alpha = join(targetRoot, ".agents/skills/alpha/SKILL.md");
  const betaSource = join(sourceRoot, ".codex/skills/beta/SKILL.md");
  const betaTarget = join(targetRoot, ".agents/skills/beta/SKILL.md");
  const userSkill = join(targetRoot, ".agents/skills/personal/SKILL.md");
  await writeFile(alpha, "local-only edit\n");
  await mkdir(dirname(betaSource), { recursive: true });
  await mkdir(dirname(betaTarget), { recursive: true });
  await writeFile(betaSource, "upstream beta\n");
  await writeFile(betaTarget, "untracked user file\n");
  await mkdir(dirname(userSkill), { recursive: true });
  await writeFile(userSkill, "my skill\n");

  const first = await updateProject({ sourceRoot, targetRoot, initialize: true });
  assert.equal(await readFile(alpha, "utf8"), "# alpha\n");
  assert.equal(await readFile(join(first.backup_directory, ".agents/skills/alpha/SKILL.md"), "utf8"), "local-only edit\n");
  assert.equal(await readFile(betaTarget, "utf8"), "upstream beta\n");
  assert.equal(await readFile(join(first.backup_directory, ".agents/skills/beta/SKILL.md"), "utf8"), "untracked user file\n");
  assert.equal(await readFile(userSkill, "utf8"), "my skill\n");

  const second = await updateProject({ sourceRoot, targetRoot });
  assert.equal(second.backup_directory, null);
  assert.deepEqual(second.updated, []);
  assert.deepEqual(second.added, []);
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(targetRoot, { recursive: true, force: true });
});

test("update adds the PR template, preserves an existing one, and backs it up on force", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  const sourceTemplate = join(sourceRoot, ".github/pull_request_template.md");
  const targetTemplate = join(targetRoot, ".github/pull_request_template.md");
  await mkdir(dirname(sourceTemplate), { recursive: true });
  await writeFile(sourceTemplate, "upstream PR template\n");
  await writeHarnessLock({ sourceRoot, targetRoot });
  const added = await updateProject({ sourceRoot, targetRoot });
  assert.ok(added.added.includes(".github/pull_request_template.md"));
  await writeFile(targetTemplate, "local PR template\n");
  await writeFile(sourceTemplate, "upstream PR template v2\n");
  await updateProject({ sourceRoot, targetRoot });
  assert.equal(await readFile(targetTemplate, "utf8"), "local PR template\n");
  const forced = await updateProject({ sourceRoot, targetRoot, force: true });
  assert.equal(await readFile(targetTemplate, "utf8"), "upstream PR template v2\n");
  assert.equal(await readFile(join(forced.backup_directory, ".github/pull_request_template.md"), "utf8"), "local PR template\n");
});

test("reinstall initializes a missing lock without replacing project config", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeFile(join(targetRoot, ".codex/harness.yaml"), "user config\n");
  await updateProject({ sourceRoot, targetRoot, initialize: true });
  await updateProject({ sourceRoot, targetRoot, initialize: true });
  assert.equal(await readFile(join(targetRoot, ".codex/harness.yaml"), "utf8"), "user config\n");
});

test("retired managed files leave the lock and partial scope retains other baselines", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  await unlink(join(sourceRoot, ".codex/schemas/case.yaml"));
  await writeFile(join(targetRoot, ".codex/workflows/review.yaml"), "local workflow\n");
  const retired = await updateProject({ sourceRoot, targetRoot });
  let lock = JSON.parse(await readFile(join(targetRoot, ".codex/harness-lock.json"), "utf8"));
  assert.equal(lock.files[".codex/schemas/case.yaml"], undefined);
  assert.ok(retired.removed_lock_entries.includes(".codex/schemas/case.yaml"));
  const previousWorkflowBaseline = lock.files[".codex/workflows/review.yaml"].installed_sha256;
  await writeFile(join(sourceRoot, ".codex/agents/runner.toml"), "agent v2\n");
  await updateProject({ sourceRoot, targetRoot, scope: "agents" });
  lock = JSON.parse(await readFile(join(targetRoot, ".codex/harness-lock.json"), "utf8"));
  assert.equal(lock.files[".codex/workflows/review.yaml"].installed_sha256, previousWorkflowBaseline);
});

test("update repairs a retired skill source mapping and backs up the local edit", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  const lockPath = join(targetRoot, ".codex/harness-lock.json");
  const skillTarget = join(targetRoot, ".agents/skills/alpha/SKILL.md");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.files[".agents/skills/alpha/SKILL.md"].source_path = ".codex/skills/retired/SKILL.md";
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await writeFile(join(sourceRoot, ".codex/skills/alpha/SKILL.md"), "upstream v2\n");

  const vendorUpdate = await updateProject({ sourceRoot, targetRoot });
  assert.ok(vendorUpdate.updated.includes(".agents/skills/alpha/SKILL.md"));
  assert.equal(await readFile(skillTarget, "utf8"), "upstream v2\n");
  let repaired = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(repaired.files[".agents/skills/alpha/SKILL.md"].source_path, ".codex/skills/alpha/SKILL.md");

  await writeFile(lockPath, `${JSON.stringify({ ...repaired, files: { ...repaired.files, ".agents/skills/alpha/SKILL.md": { ...repaired.files[".agents/skills/alpha/SKILL.md"], source_path: ".codex/skills/retired/SKILL.md" } } }, null, 2)}\n`);
  await writeFile(skillTarget, "local edit\n");
  await writeFile(join(sourceRoot, ".codex/skills/alpha/SKILL.md"), "upstream v3\n");
  const repairedUpdate = await updateProject({ sourceRoot, targetRoot });
  assert.ok(repairedUpdate.updated.includes(".agents/skills/alpha/SKILL.md"));
  assert.equal(await readFile(skillTarget, "utf8"), "upstream v3\n");
  assert.equal(await readFile(join(repairedUpdate.backup_directory, ".agents/skills/alpha/SKILL.md"), "utf8"), "local edit\n");
  repaired = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(repaired.files[".agents/skills/alpha/SKILL.md"].source_path, ".codex/skills/alpha/SKILL.md");
  const report = await runDoctor({ root: targetRoot, lockPath: ".codex/harness-lock.json", sourceRoot });
  assert.equal(report.diagnostics.some((entry) => entry.code === "installer_source_missing"), false);
});

test("installed session output CLI resolves through the portable runtime", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: targetRoot }).status, 0);
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    const cli = join(targetRoot, ".codex/scripts/harness-session-output.mjs");
    const result = spawnSync(process.execPath, [cli, "--root", targetRoot], { cwd: targetRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /harness-workflows\/sessions\/[a-f0-9]{64}$/);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.ok(await readFile(join(targetRoot, ".codex/harness-runtime/src/workflow/session-output.mjs"), "utf8"));
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("VictoriaLogs replacement backs up and retires only the managed SigNoz skill", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  const retired = '.agents/skills/signoz-local-setup/SKILL.md';
  const source = join(sourceRoot, '.codex/skills/signoz-local-setup/SKILL.md');
  await mkdir(dirname(source), { recursive: true });
  await mkdir(dirname(join(targetRoot, retired)), { recursive: true });
  await writeFile(source, '# old setup\n');
  await writeFile(join(targetRoot, retired), '# project modified old setup\n');
  await writeHarnessLock({ sourceRoot, targetRoot });
  await unlink(source);
  const result = await updateProject({ sourceRoot, targetRoot });
  assert.deepEqual(result.retired, [retired]);
  await assert.rejects(readFile(join(targetRoot, retired)), { code: 'ENOENT' });
  assert.equal(await readFile(join(result.backup_directory, retired), 'utf8'), '# project modified old setup\n');
  assert.equal(result.lock.files[retired], undefined);
  assert.equal(await readFile(join(targetRoot, '.agents/skills/alpha/SKILL.md'), 'utf8'), '# alpha\n');
});
