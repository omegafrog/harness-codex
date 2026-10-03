import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectRuntimeEvidence } from "../src/knowledge/runtime-evidence.mjs";
import { readStagedEvidence } from "../src/knowledge/evidence.mjs";
import { computeApprovalHash } from "../src/decision/approval.mjs";
import { openPlanJournal } from "../src/eval/plan-journal.mjs";
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

test("plan journal records collection diagnostics separately and keeps execution history ordering", async () => {
  const root = await fixture();
  let journal;
  try {
    journal = await openPlanJournal({ root, planId: "runtime-evidence-test" });
    await journal.append("verification_passed", { command: "node --test" });
    const result = await journal.observeExecution({ definition: { execution_purpose: "code_validation" }, observation: observation() });
    await journal.append("plan_continued", { step: "next" });
    assert.equal(result.collected, true);
    const events = await journal.replay();
    assert.deepEqual(events.events.map((event) => event.type), ["verification_passed", "runtime_evidence_collection", "plan_continued"]);
    assert.equal(events.events[1].payload.evidence_id, result.evidence.id);
    assert.equal(JSON.stringify(events.events[1]).includes("tests_passed"), false);
  } finally {
    await journal?.close();
    await rm(root, { recursive: true, force: true });
  }
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
