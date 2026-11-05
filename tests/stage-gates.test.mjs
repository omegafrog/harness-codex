import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { updateProject } from "../.harness/src/installer/update.mjs";
import { protectLocalInstallArtifacts } from "../.harness/src/installer/local-exclude.mjs";
import { evaluateWorkflowStage } from "../.harness/src/workflow/stage-gates.mjs";
import { validateArchitectureDecision } from "../.harness/src/decision/validation.mjs";
import { computeApprovalHash } from "../.harness/src/decision/approval.mjs";
import { evaluateDecisionGate } from "../.harness/src/decision/review.mjs";
import { approveArchitectureDecision } from "../.harness/src/decision/artifacts.mjs";
import { writeExecutionInput } from "../.harness/src/workflow/execution-input.mjs";

test("new technology decisions require comparable evaluations and a recorded choice", async () => {
  const decision = {
    schema_version: 2, id: "db", status: "accepted", review_mode: "Normal", category: "infrastructure", problem: "저장", constraints: ["운영"],
    requirement_ids: ["R1"], target_ids: ["T1"], options: [{ id: "a", description: "관리형" }, { id: "b", description: "직접 운영" }],
    selected_option: "a", rejected_alternatives: [{ option_id: "b", reason: "운영 부담" }], rationale: "운영 부담", tradeoffs: ["비용"], boundary: "초기 규모",
    criteria: [{ id: "operations", requirement_id: "R1", condition: "백업 책임", kind: "required", priority: "high" }],
    evaluations: ["a", "b"].map((option_id) => ({ option_id, criterion_id: "operations", result: "met", reason: "백업 제공", evidence_kind: "documented", source: "https://example.com/docs", condition: "현재 버전", checked_at: "2026-11-05T00:00:00Z" })),
    selection: { decision: "관리형 선택", accepted_tradeoffs: "비용", uncertainty: "규모별 비용", revisit_when: "성장 시", user_choice: "사용자가 선택" },
  };
  decision.approval = { approver: "user", approved_at: "2026-11-05T00:00:00Z", subject_hash: computeApprovalHash(decision) };
  const targets = { initial: [{ id: "T1" }], expected_growth: [], architecture_boundary: [] };
  assert.equal(validateArchitectureDecision(decision).valid, true);
  assert.equal(evaluateDecisionGate(decision, targets).decision_review_complete.status, "pass");
  assert.ok(validateArchitectureDecision({ ...decision, schema_version: 1 }).errors.some(({ code }) => code === "invalid_schema_version"));
  const learningDecision = { ...decision, review_mode: 'Learning', review_id: 'learning-review' };
  learningDecision.approval = { ...decision.approval, subject_hash: computeApprovalHash(learningDecision) };
  assert.equal(evaluateDecisionGate(learningDecision, targets).decision_review_complete.status, 'blocked');
  const learningReview = { schema_version: 2, id: 'learning-review', decision_id: 'db', reviewer: 'reviewer', assessment: '조건과 선택 검토', outcome: 'ACCEPTED', findings: [] };
  assert.equal(evaluateDecisionGate(learningDecision, targets, learningReview).decision_review_complete.status, 'pass');
  assert.equal(evaluateDecisionGate(learningDecision, targets, { ...learningReview, findings: [{ severity: 'major', description: '조건 누락', evidence: '기준' }] }).decision_review_complete.status, 'blocked');
  const incomplete = structuredClone(decision);
  incomplete.evaluations.pop();
  assert.ok(validateArchitectureDecision(incomplete).errors.some(({ code }) => code === "missing_evaluation"));
  const changed = structuredClone(decision);
  changed.selection.user_choice = "다른 선택";
  assert.ok(validateArchitectureDecision(changed).errors.some(({ code }) => code === "approval_hash_mismatch"));
  const root = await mkdtemp(join(tmpdir(), "decision-choice-"));
  try {
    await mkdir(join(root, "docs/specs/example/architecture-decisions"), { recursive: true });
    await mkdir(join(root, ".io/runtime/executions/ask"), { recursive: true });
    const draft = { ...decision, status: "proposed" };
    delete draft.approval;
    await writeFile(join(root, "docs/specs/example/architecture-decisions/db.yaml"), JSON.stringify(draft));
    await writeFile(join(root, ".io/runtime/executions/ask/decision-answers.json"), JSON.stringify([{ question_id: "ask:1", answer: "사용자가 선택" }]));
    const input = { root, ticketId: "example", decisionId: "db", answersPath: "runtime/executions/ask/decision-answers.json", questionId: "ask:1" };
    await assert.rejects(approveArchitectureDecision({ ...input, questionId: "ask:2" }), /actual answer/);
    const approved = await approveArchitectureDecision(input);
    assert.equal(approved.value.status, "accepted");
    assert.equal(validateArchitectureDecision(approved.value).valid, true);
    await mkdir(join(root, '.io/runtime/orchestrator'), { recursive: true });
    await writeFile(join(root, '.io/runtime/orchestrator/state.json'), JSON.stringify({ stages: { 'workflow-compose': { execution_id: 'compose' } } }));
    await writeExecutionInput(root, { skill: 'workflow-compose', execution_id: 'compose', scope: '기술 선택은 위임합니다', context: {} }, 'example');
    draft.selection = { ...draft.selection, user_choice: '기술 선택은 위임합니다' };
    await writeFile(join(root, 'docs/specs/example/architecture-decisions/db.yaml'), JSON.stringify(draft));
    assert.equal((await approveArchitectureDecision({ root, ticketId: 'example', decisionId: 'db', delegated: true })).value.approval.approver, 'user-delegation');
    draft.selection.user_choice = '기록되지 않은 위임';
    await writeFile(join(root, 'docs/specs/example/architecture-decisions/db.yaml'), JSON.stringify(draft));
    await assert.rejects(approveArchitectureDecision({ root, ticketId: 'example', decisionId: 'db', delegated: true }), /recorded original request/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Learning is opt-in and Normal is the default", () => {
  const workflow = { stages: [{ id: "learning", condition: "learning_mode" }] };
  assert.equal(evaluateWorkflowStage({ workflow, stageId: "learning" }).action, "skip");
  assert.equal(evaluateWorkflowStage({ workflow, stageId: "learning", input: { mode: "Learning" } }).action, "dispatch");
});

test("installed review gate rejects missing and stale reviews and accepts the current admitted review", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-current-spec-review-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    const dir = join(root, "docs/specs/example");
    await mkdir(dir, { recursive: true });
    for (const name of ["request.md", "product-spec.md", "architecture-spec.md"]) await writeFile(join(dir, name), `# ${name}\n`);
    const runtime = `file://${join(root, ".harness/src/workflow")}`;
    const { snapshotSpecReview, requireCurrentSpecReview } = await import(`${runtime}/spec-review.mjs`);
    const { updateReviewAttempt } = await import(`${runtime}/review-attempts.mjs`);
    await assert.rejects(requireCurrentSpecReview({ root, ticketId: "example" }), /recorded passing Architecture review/);
    const inputs = await snapshotSpecReview({ root, ticketId: "example" });
    assert.deepEqual(Object.keys(inputs).sort(), ["docs/specs/example/architecture-spec.md", "docs/specs/example/product-spec.md"]);
    await assert.rejects(snapshotSpecReview({ root, ticketId: "example", input_paths: ["docs/specs/example/request.md"] }), /limited to Product and Architecture Specs/);
    const scope = "spec-example-architecture";
    const admitted = await updateReviewAttempt({ root, scope, action: "begin", inputs });
    const review = { axis: "architecture", ticket_id: "example", reviewer_id: "reviewer", author_ids: ["writer"], fork_turns: "none", verdict: "pass", inputs, findings: [] };
    await updateReviewAttempt({ root, scope, action: "record", attemptId: admitted.attempt_id, inputs, review });
    assert.equal((await requireCurrentSpecReview({ root, ticketId: "example" })).status, "pass");
    await writeFile(join(dir, "request.md"), "# Changed request\n");
    await writeFile(join(root, "CONTEXT.md"), "# Changed glossary\n");
    assert.equal((await requireCurrentSpecReview({ root, ticketId: "example" })).status, "pass");
    const targets = { schema_version: 1, id: 'system-targets', system_characteristics: Object.fromEntries(['interaction', 'workload', 'state', 'consistency', 'availability', 'growth'].map((name) => [name, '기준'])), initial: [{ id: 'T1', metric: 'mau', status: 'resolved', value: 10, unit: 'users', provenance: 'user_supplied', confidence: 'high', rationale: '예상 사용자' }], expected_growth: [], architecture_boundary: [], decision_metadata: { decision_layer_version: 2, decision_ids: ['db'] } };
    const decision = { schema_version: 2, id: 'db', status: 'proposed', review_mode: 'Normal', category: 'infrastructure', problem: '저장', constraints: ['운영'], requirement_ids: ['R1'], target_ids: ['T1'], options: [{ id: 'a', description: '관리형' }], selected_option: 'a', single_option_reason: '유일한 허용 옵션', rationale: '운영', tradeoffs: ['비용'], boundary: '초기', criteria: [{ id: 'ops', requirement_id: 'R1', condition: '백업', kind: 'required', priority: 'high' }], evaluations: [{ option_id: 'a', criterion_id: 'ops', result: 'met', reason: '백업 제공', evidence_kind: 'documented', source: 'https://example.com/docs', condition: '현재 버전', checked_at: '2026-11-05T00:00:00Z' }], selection: { decision: '선택', accepted_tradeoffs: '비용', uncertainty: '가격', revisit_when: '성장 시', user_choice: '관리형' } };
    await mkdir(join(dir, 'architecture-decisions'), { recursive: true });
    await writeFile(join(dir, 'system-targets.yaml'), JSON.stringify(targets));
    await writeFile(join(dir, 'architecture-decisions/db.yaml'), JSON.stringify(decision));
    await mkdir(join(root, '.io/runtime/executions/ask'), { recursive: true });
    await writeFile(join(root, '.io/runtime/executions/ask/decision-answers.json'), JSON.stringify([{ question_id: 'ask:1', answer: '관리형' }]));
    const decisionCli = join(root, '.codex/scripts/harness-decision-gate.mjs');
    assert.equal(JSON.parse(execFileSync(process.execPath, [decisionCli, 'approve', '--ticket', 'example', '--decision', 'db', '--answers', 'runtime/executions/ask/decision-answers.json', '--question', 'ask:1'], { cwd: root, encoding: 'utf8' })).status, 'accepted');
    assert.equal(JSON.parse(execFileSync(process.execPath, [decisionCli, 'decision_evidence_complete', '--ticket', 'example'], { cwd: root, encoding: 'utf8' })).status, 'pass');
    assert.equal(JSON.parse(execFileSync(process.execPath, [decisionCli, 'decision_review_complete', '--ticket', 'example'], { cwd: root, encoding: 'utf8' })).status, 'pass');
    await writeFile(join(dir, "architecture-spec.md"), "# Changed\n");
    await assert.rejects(requireCurrentSpecReview({ root, ticketId: "example" }), /inputs changed/);
    const status = execFileSync("git", ["status", "--short", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
    assert.match(status, /docs\/specs\/example\/architecture-spec\.md/);
    assert.doesNotMatch(status, /\.harness\/src/);
    assert.match(execFileSync("git", ["check-ignore", "-v", ".harness/src/workflow/spec-review.mjs"], { cwd: root, encoding: "utf8" }), /\.harness/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const condition of ["product_diagram_required", "architecture_diagram_required"]) {
  const workflow = { stages: [{ id: "diagram", condition }] };

  test(`${condition} dispatches and skips from its boolean input`, () => {
    assert.equal(evaluateWorkflowStage({ workflow, stageId: "diagram", input: { [condition]: true } }).action, "dispatch");
    assert.equal(evaluateWorkflowStage({ workflow, stageId: "diagram", input: { [condition]: false } }).action, "skip");
  });

  test(`${condition} blocks missing or non-boolean input`, () => {
    assert.throws(() => evaluateWorkflowStage({ workflow, stageId: "diagram", input: {} }), new RegExp(`input\\.${condition} must be a boolean`));
    assert.throws(() => evaluateWorkflowStage({ workflow, stageId: "diagram", input: { [condition]: "yes" } }), new RegExp(`input\\.${condition} must be a boolean`));
  });
}

test("installed decision gate CLI validates applicable Product and Architecture diagrams", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-diagram-gate-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    for (const axis of ["product", "architecture"]) {
      const specName = axis === "product" ? "product-spec.md" : "architecture-spec.md";
      const directory = join(root, "docs/specs/example/diagrams", axis);
      await mkdir(directory, { recursive: true });
      await mkdir(join(root, "docs/specs/example"), { recursive: true });
      await writeFile(join(root, "docs/specs/example", specName), `![Diagram](diagrams/${axis}/sample.svg)\n`);
      await writeFile(join(directory, "sample.puml"), "@startuml\n@enduml\n");
      await writeFile(join(directory, "sample.svg"), "<svg></svg>\n");
      const gate = axis === "product" ? "product_diagram_completion" : "architecture_diagram_completion";
      const result = JSON.parse(execFileSync(process.execPath, [join(root, ".codex/scripts/harness-decision-gate.mjs"), gate, "--ticket", "example"], { cwd: root, encoding: "utf8" }));
      assert.equal(result.status, "pass");
      assert.equal(result.rule_id, gate);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed diagram gates block missing and inconsistent artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-diagram-gate-blocked-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    const gateCli = join(root, ".codex/scripts/harness-decision-gate.mjs");
    const specRoot = join(root, "docs/specs/example");
    const directory = join(specRoot, "diagrams/product");
    await mkdir(directory, { recursive: true });
    await writeFile(join(specRoot, "product-spec.md"), "No diagram link.\n");

    const runGate = () => {
      try {
        execFileSync(process.execPath, [gateCli, "product_diagram_completion", "--ticket", "example"], { cwd: root, encoding: "utf8" });
        assert.fail("expected installed gate to block");
      } catch (error) {
        assert.equal(error.status, 2);
        return JSON.parse(error.stdout);
      }
    };

    const missing = runGate();
    assert.equal(missing.status, "blocked");
    assert.ok(missing.violations.some(({ code }) => code === "missing_diagram_source"));

    await writeFile(join(directory, "sample.puml"), "@startuml\n@enduml\n");
    await writeFile(join(directory, "sample.svg"), "<svg></svg>\n");
    const inconsistent = runGate();
    assert.equal(inconsistent.status, "blocked");
    assert.ok(inconsistent.violations.some(({ code }) => code === "missing_diagram_link"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed Architecture review gate blocks Specs still marked as draft or pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-spec-status-gate-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    const specRoot = join(root, "docs/specs/example");
    await mkdir(specRoot, { recursive: true });
    await writeFile(join(specRoot, "request.md"), "# Request\n");
    await writeFile(join(specRoot, "product-spec.md"), "**Status:** Draft for review\n");
    await writeFile(join(specRoot, "architecture-spec.md"), "**Status:** Architecture Spec independent review pending\n");
    const runtime = `file://${join(root, ".harness/src/workflow")}`;
    const { snapshotSpecReview } = await import(`${runtime}/spec-review.mjs`);
    const inputs = await snapshotSpecReview({ root, ticketId: "example" });
    const reviewPath = join(root, ".io/runtime/spec-review-result.json");
    await mkdir(join(root, ".io/runtime"), { recursive: true });
    await writeFile(reviewPath, JSON.stringify({ architecture: {
      axis: "architecture", ticket_id: "example", reviewer_id: "reviewer", author_ids: ["author"],
      fork_turns: "none", verdict: "pass", findings: [], inputs,
    } }));
    const check = () => {
      try {
        execFileSync(process.execPath, [join(root, ".codex/scripts/harness-spec-review.mjs"), "check", "--root", root, "--ticket", "example", "--axis", "architecture", "--reviews", "runtime/spec-review-result.json"], { cwd: root, encoding: "utf8" });
        return null;
      } catch (error) {
        assert.equal(error.status, 1);
        return JSON.parse(error.stdout);
      }
    };

    const draft = check();
    assert.equal(draft?.status, "blocked");
    assert.match(draft.reason, /not finalized/i);

    await writeFile(join(specRoot, "product-spec.md"), "**Status:** Approved\n");
    await writeFile(join(specRoot, "architecture-spec.md"), "**Status:** Approved\n");
    const approvedInputs = await snapshotSpecReview({ root, ticketId: "example" });
    const saved = JSON.parse(await readFile(reviewPath, "utf8"));
    saved.architecture.inputs = approvedInputs;
    await writeFile(reviewPath, JSON.stringify(saved));
    assert.equal(JSON.parse(execFileSync(process.execPath, [join(root, ".codex/scripts/harness-spec-review.mjs"), "check", "--root", root, "--ticket", "example", "--axis", "architecture", "--reviews", "runtime/spec-review-result.json"], { cwd: root, encoding: "utf8" })).status, "pass");

    const status = execFileSync("git", ["status", "--short", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
    assert.match(status, /docs\/specs\/example\/product-spec\.md/);
    assert.doesNotMatch(status, /\.codex\/scripts\/harness-spec-review\.mjs|\.harness\/src/);
    assert.match(execFileSync("git", ["check-ignore", "-v", ".codex/scripts/harness-spec-review.mjs"], { cwd: root, encoding: "utf8" }), /\.codex/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
