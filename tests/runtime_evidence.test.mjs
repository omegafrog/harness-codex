import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectRuntimeEvidence } from "../src/knowledge/runtime-evidence.mjs";
import { observeHarnessExecution, retryRuntimeEvidence } from "../src/eval/runtime-observer.mjs";
import { readStagedEvidence } from "../src/knowledge/evidence.mjs";
import { computeApprovalHash } from "../src/decision/approval.mjs";
import { normalizeEvidence } from "../src/knowledge/evidence.mjs";
import { computeEvidenceApprovalHash } from "../src/knowledge/validation.mjs";
import { writeEvidence } from "../src/knowledge/registry.mjs";
import { validateEvidenceReferences } from "../src/decision/artifacts.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-evidence-"));
  await mkdir(join(root, "docs", "specs", "506", "architecture-decisions"), { recursive: true });
  const decision = {
    schema_version: 1, id: "decision-a", status: "accepted", category: "code", problem: "Choose a bounded module structure.",
    constraints: ["Existing Node runtime"], requirement_ids: ["REQ-005"], target_ids: ["growth-boundary"],
    options: [{ id: "modular", description: "Keep one process." }, { id: "service", description: "Split deployment." }],
    selected_option: "modular", rejected_alternatives: [{ option_id: "service", reason: "No independent lifecycle is needed." }],
    rationale: "The workflow has one lifecycle.", tradeoffs: ["Release remains shared."], principle_ids: [], evidence_ids: ["adr-context"],
    boundary: "Revisit when independent scaling is required.", review_id: "decision-a-review",
    approval: { approver: "user", approved_at: "2026-01-01T00:00:00Z", subject_hash: "" },
  };
  decision.approval.subject_hash = computeApprovalHash(decision);
  await writeFile(join(root, "docs", "specs", "506", "architecture-decisions", "decision-a.yaml"), `${JSON.stringify(decision)}\n`);
  return root;
}

const observation = (overrides = {}) => ({
  origin_project: "harness-codex", run_id: "run-1", event_id: "test-1", timestamp: "2026-10-03T13:00:00Z",
  environment: { runtime: "node 22" }, type: "failure_test", execution_status: "completed",
  measurement_validity: "valid", observations: [{ metric: "tests_passed", value: 12, unit: "tests" }],
  summary: "Twelve code validation tests passed.", ...overrides,
});

function cli(root, ...args) {
  return spawnSync(process.execPath, [new URL("../.codex/scripts/harness-knowledge.mjs", import.meta.url).pathname, "evidence", ...args, "--root", root], { encoding: "utf8" });
}

test("runtime code validation can stage without Decision IDs and preserves purpose", async () => {
  const root = await fixture();
  try {
    const result = await collectRuntimeEvidence({ root, definition: { execution_purpose: "code_validation" }, observation: observation() });
    assert.equal(result.collected, true);
    const staged = await readStagedEvidence({ root, evidenceId: result.evidence.id });
    assert.equal(staged.evidence.execution_purpose, "code_validation");
    assert.deepEqual(staged.evidence.decision_ids, []);
    assert.match(staged.evidence.id, /^[A-Za-z0-9._-]+$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime decision validation requires resolvable declared Decision IDs", async () => {
  const root = await fixture();
  try {
    const missing = await collectRuntimeEvidence({ root, definition: { execution_purpose: "decision_validation", decision_ids: ["missing"] }, observation: observation() });
    assert.equal(missing.collected, false);
    assert.equal(missing.diagnostic.code, "unresolved_decision_reference");
    const result = await collectRuntimeEvidence({ root, definition: { execution_purpose: "decision_validation", decision_ids: ["decision-a"] }, observation: observation() });
    assert.equal(result.collected, true);
    assert.deepEqual(result.evidence.decision_ids, ["decision-a"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime collection fails closed for missing purpose and deduplicates stable run/event identity", async () => {
  const root = await fixture();
  try {
    const unclassified = await collectRuntimeEvidence({ root, definition: {}, observation: observation() });
    assert.equal(unclassified.collected, false);
    assert.equal(unclassified.diagnostic.code, "unsupported_execution_purpose");
    const definition = { execution_purpose: "code_validation" };
    const first = await collectRuntimeEvidence({ root, definition, observation: observation() });
    const second = await collectRuntimeEvidence({ root, definition, observation: observation() });
    assert.equal(second.idempotent, true);
    const conflict = await collectRuntimeEvidence({ root, definition, observation: observation({ observations: [{ metric: "tests_passed", value: 11, unit: "tests" }] }) });
    assert.equal(conflict.collected, false);
    assert.equal(conflict.diagnostic.code, "runtime_evidence_identity_conflict");
    const stagedText = await readFile(first.path, "utf8");
    assert.doesNotMatch(stagedText, /stdout|events\.jsonl|checkpoint/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("knowledge CLI collects runtime Evidence, then existing approval and publish flow makes it durable", async () => {
  const root = await fixture();
  try {
    const collected = cli(root, "collect-runtime", "--json", JSON.stringify({ definition: { execution_purpose: "code_validation" }, observation: observation() }));
    assert.equal(collected.status, 0, collected.stderr);
    const candidate = JSON.parse(collected.stdout);
    assert.equal(candidate.collected, true);
    const approved = cli(root, "approve", "--id", candidate.evidence.id, "--actor", "jiwoo", "--actor-role", "user", "--at", "2026-10-03T13:00:00Z");
    assert.equal(approved.status, 0, approved.stderr);
    const published = cli(root, "publish", "--id", candidate.evidence.id);
    assert.equal(published.status, 0, published.stderr);
    assert.equal(JSON.parse(published.stdout).evidence.execution_purpose, "code_validation");
    const shown = cli(root, "show", "--id", candidate.evidence.id);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).approval.actor, "jiwoo");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("production execution observer automatically stages only explicitly classified Harness outcomes", async () => {
  const root = await fixture();
  try {
    const result = await observeHarnessExecution({
      root,
      definition: { execution_purpose: "code_validation" },
      runId: "eval-run-1",
      caseId: "unit-contract",
      caseResult: { state: "passed", execution_result: { state: "passed", duration_ms: 125 } },
    });
    assert.equal(result.collected, true);
    assert.equal(result.evidence.execution_purpose, "code_validation");
    assert.deepEqual(result.evidence.decision_ids, []);
    assert.match(result.path, /docs\/specs\/\.runtime\/506-08-runtime-evidence\/evidence/);
    assert.deepEqual(result.evidence.observations, [{ metric: "case_result_state", value: "passed", unit: "state" }]);
    const unclassified = await observeHarnessExecution({
      root, definition: {}, runId: "eval-run-2", caseId: "unit-contract",
      caseResult: { state: "passed", execution_result: { state: "passed", duration_ms: 125 } },
    });
    assert.equal(unclassified.collected, false);
    assert.equal(unclassified.diagnostic.code, "unsupported_execution_purpose");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime observation captures normalized verdict measures and keeps an identical retry idempotent", async () => {
  const root = await fixture();
  try {
    const input = {
      root,
      definition: { execution_purpose: "code_validation" },
      runId: "eval-run-stable",
      caseId: "unit-contract",
      observedAt: "2026-10-03T13:00:00.000Z",
      caseResult: {
        state: "passed",
        quality: { quality: 0.91 },
        efficiency: { tokens: 34, latency_ms: 125, tool_calls: 4, turns: 2, handoffs: 1 },
        required_outcome: { passed: true },
        hard_gates: { passed: true, violations: [] },
      },
    };
    const first = await observeHarnessExecution(input);
    const retry = await observeHarnessExecution(input);
    assert.equal(retry.idempotent, true);
    assert.equal(first.evidence.timestamp, input.observedAt);
    assert.deepEqual(first.evidence.observations, [
      { metric: "case_result_state", value: "passed", unit: "state" },
      { metric: "quality", value: 0.91, unit: "score" },
      { metric: "tokens", value: 34, unit: "tokens" },
      { metric: "latency_ms", value: 125, unit: "ms" },
      { metric: "tool_calls", value: 4, unit: "calls" },
      { metric: "turns", value: 2, unit: "turns" },
      { metric: "handoffs", value: 1, unit: "handoffs" },
      { metric: "required_outcome_passed", value: 1, unit: "boolean" },
      { metric: "hard_gates_passed", value: 1, unit: "boolean" },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed runtime staging can retry only the normalized local candidate", async () => {
  const root = await fixture();
  const retryPath = join(root, ".codex", "evals", ".runtime", "run-1", "cases", "case-a", "runtime-evidence-retry.json");
  try {
    const blocker = join(root, "docs", "specs", ".runtime");
    await mkdir(join(root, "docs", "specs"), { recursive: true });
    await writeFile(blocker, "block staging");
    const failed = await observeHarnessExecution({
      root,
      definition: { execution_purpose: "code_validation" },
      runId: "run-1",
      caseId: "case-a",
      observedAt: "2026-10-03T13:00:00.000Z",
      retryArtifactPath: retryPath,
      caseResult: { state: "failed", quality: { quality: 0.2 }, efficiency: { tokens: 12, latency_ms: 40 } },
    });
    assert.equal(failed.collected, false);
    assert.equal(failed.diagnostic.code, "evidence_write_failed");
    assert.equal(failed.retryable, true);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(retryPath, "utf8")).observation).sort(), [
      "environment", "event_id", "execution_status", "measurement_validity", "observations", "origin_project", "run_id", "summary", "timestamp", "type",
    ]);

    await rm(blocker);
    const retried = await retryRuntimeEvidence({ root, retryArtifactPath: retryPath });
    assert.equal(retried.collected, true);
    assert.equal(retried.evidence.execution_status, "failed");
    await assert.rejects(() => readFile(retryPath), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime retry rejects traversal and leaves paths outside the ignored runtime untouched", async () => {
  const root = await fixture();
  const outsidePath = join(root, ".codex", "evals", "outside-retry.json");
  try {
    await mkdir(join(root, ".codex", "evals"), { recursive: true });
    await writeFile(outsidePath, JSON.stringify({ schema_version: 1 }));
    const escapedPath = join(root, ".codex", "evals", ".runtime", "..", "..", "outside-retry.json");
    await assert.rejects(() => retryRuntimeEvidence({ root, retryArtifactPath: escapedPath }), /stay under \.codex\/evals\/\.runtime/);
    assert.equal(await readFile(outsidePath, "utf8"), JSON.stringify({ schema_version: 1 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("code validation cannot be attached as Decision evidence while legacy Evidence keeps its reference rule", async () => {
  const root = await fixture();
  try {
    const base = {
      origin_project: "harness-codex", environment: { runtime: "node 22" }, timestamp: "2026-10-03T13:00:00Z",
      type: "failure_test", execution_status: "completed", measurement_validity: "valid",
      observations: [{ metric: "tests_passed", value: 12, unit: "tests" }], source_reference: "run-1/test-1",
    };
    const codeEvidence = { ...normalizeEvidence({ ...base, id: "code-evidence", execution_purpose: "code_validation", decision_ids: [] }), summary: "Twelve tests passed." };
    codeEvidence.approval = { actor_type: "human", actor: "user", approved_at: "2026-10-03T13:00:00Z", summary_sha256: computeEvidenceApprovalHash(codeEvidence) };
    await writeEvidence({ root, evidence: codeEvidence });
    await assert.rejects(() => validateEvidenceReferences({ root, evidenceIds: ["code-evidence"] }), /code.validation Evidence can only be used/i);

    const legacy = { ...normalizeEvidence({ ...base, id: "manual-evidence", source_reference: "manual-run-1", decision_ids: ["decision-a"] }), summary: "Manual benchmark observation." };
    legacy.approval = { actor_type: "human", actor: "user", approved_at: "2026-10-03T13:00:00Z", summary_sha256: computeEvidenceApprovalHash(legacy) };
    await writeEvidence({ root, evidence: legacy });
    assert.deepEqual(await validateEvidenceReferences({ root, evidenceIds: ["manual-evidence"] }), ["manual-evidence"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
