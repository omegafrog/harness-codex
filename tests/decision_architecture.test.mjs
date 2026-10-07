import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeApprovalHash, verifyApproval } from "../src/decision/approval.mjs";
import { readArchitectureDecision, readMaterialApproval, readReviewRecord, validateEvidenceReferences, validatePrincipleReferences, writeArchitectureDecision, writeMaterialApproval, writeReviewRecord, writeSystemTargets } from "../src/decision/artifacts.mjs";
import { approvePrinciple, recordPrincipleReview, writeClaim, writeEvidence, writePrinciple, writeSource } from "../src/knowledge/registry.mjs";
import { createClaim, createEvidence, createPrinciple, createSource } from "../src/knowledge/model.mjs";
import { computeEvidenceApprovalHash } from "../src/knowledge/validation.mjs";
import { validateArchitectureDecision, validateReviewRecord } from "../src/decision/validation.mjs";
import { evaluateDecisionEvidenceComplete, evaluateStageGates } from "../src/workflow/stage-gates.mjs";
import { evaluateDecisionGate, recordMaterialApproval } from "../src/decision/review.mjs";
import { loadNamedWorkflow } from "../src/workflow/loader.mjs";
import { parseYaml } from "../src/eval/yaml.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const TARGETS = {
  schema_version: 1, id: "system-targets",
  system_characteristics: { interaction: "API", workload: "bursty", state: "durable", consistency: "strong writes", availability: "business hours", growth: "moderate" },
  initial: [], expected_growth: [{ id: "growth-boundary", metric: "average_rps", status: "resolved", value: 50, unit: "requests/second", provenance: "estimated", confidence: "medium", rationale: "Expected growth estimate." }], architecture_boundary: [],
  decision_metadata: { decision_layer_version: 1, decision_ids: ["api-boundary"] },
};
const DECISION = {
  schema_version: 1, id: "api-boundary", status: "accepted", category: "code",
  problem: "Keep request handling separate from persistence.", constraints: ["Existing Node runtime"],
  requirement_ids: ["REQ-005"], target_ids: ["growth-boundary"],
  options: [{ id: "modular-monolith", description: "Keep modules in one process." }, { id: "service", description: "Split a deployment service." }],
  selected_option: "modular-monolith", rejected_alternatives: [{ option_id: "service", reason: "No independent lifecycle is required." }],
  rationale: "The workflow is synchronous and shares one lifecycle.", tradeoffs: ["Release and runtime remain shared."],
  principle_ids: [], evidence_ids: ["adr-context"], boundary: "Revisit if independent scaling or failure isolation becomes necessary.",
  review_id: "api-boundary-review", approval: { approver: "user", approved_at: "2026-01-01T00:00:00.000Z", subject_hash: "" },
};
const REVIEW = {
  schema_version: 1, id: "api-boundary-review", decision_id: "api-boundary", reviewer: "reviewer",
  assessment: "The selected option fits the current lifecycle.", outcome: "ACCEPTED",
  material_ids: [],
  checklist: { requirements: true, targets: true, alternatives: true, tradeoffs: true, evidence: true, boundary: true, answered_objections: true },
  objections: [],
};

function withValidApproval(decision = DECISION) {
  const copy = structuredClone(decision);
  copy.approval.subject_hash = computeApprovalHash(copy);
  return copy;
}

function withValidReview(review = REVIEW) {
  const copy = structuredClone(review);
  copy.approval = { approver: copy.reviewer, approved_at: "2026-01-01T00:00:00.000Z", subject_hash: "" };
  copy.approval.subject_hash = computeApprovalHash(copy);
  return copy;
}

test("approval hash sorts keys and excludes approval, status, history, derived review metadata", () => {
  const first = { b: 2, a: 1, approval: { subject_hash: "old" }, status: "proposed", history: [1], review_required: true };
  const reordered = { review_required: false, history: [2], status: "accepted", a: 1, approval: { subject_hash: "new" }, b: 2 };
  assert.equal(computeApprovalHash(first), computeApprovalHash(reordered));
  assert.match(computeApprovalHash(first), /^[a-f0-9]{64}$/);
  assert.equal(verifyApproval({ ...first, substantive: "changed" }, { approver: "user", approved_at: "2026-01-01T00:00:00.000Z", subject_hash: computeApprovalHash(first) }).valid, false);
  const review = { checklist: { evidence: true }, objections: [{ id: "objection", status: "open" }] };
  const approval = { approver: "reviewer", approved_at: "2026-01-01T00:00:00.000Z", subject_hash: computeApprovalHash(review) };
  assert.equal(verifyApproval({ ...review, objections: [{ id: "objection", status: "resolved" }] }, approval).valid, false, "nested objection status is substantive review content");
  assert.equal(computeApprovalHash({ evidence_ids: ["e-1"] }), computeApprovalHash({ evidence_ids: ["e-1"] }), "referenced evidence bodies are never included in the subject hash");
});

test("decision validation requires code or infrastructure, refs, alternatives and reviewable content", () => {
  const result = validateArchitectureDecision(withValidApproval(), { targetIds: ["growth-boundary"] });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  const invalid = structuredClone(DECISION);
  invalid.category = "database";
  invalid.target_ids = ["missing"];
  invalid.rejected_alternatives = [];
  const rejected = validateArchitectureDecision(invalid, { targetIds: ["growth-boundary"] });
  assert.equal(rejected.valid, false);
  assert.ok(rejected.errors.some((error) => error.code === "invalid_decision_category"));
  assert.ok(rejected.errors.some((error) => error.code === "unknown_target_ref"));
  assert.ok(rejected.errors.some((error) => error.code === "missing_rejected_alternative"));
});

test("review validation enforces all seven checklist items and outcome enum", () => {
  assert.equal(validateReviewRecord(withValidReview(), { decisionIds: ["api-boundary"] }).valid, true);
  const linkedMaterialApproval = withValidReview({ ...REVIEW, material_approval: { approval_id: "material-use-approval-1" } });
  assert.equal(validateReviewRecord(linkedMaterialApproval, { decisionIds: ["api-boundary"] }).valid, true);
  assert.equal(validateReviewRecord({ ...linkedMaterialApproval, material_approval: { approval_id: "../escape" } }, { decisionIds: ["api-boundary"] }).valid, false);
  const incomplete = withValidReview();
  incomplete.checklist.boundary = false;
  const result = validateReviewRecord(incomplete, { decisionIds: ["api-boundary"] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "incomplete_review_checklist"));
  const openObjection = withValidReview({ ...REVIEW, objections: [{ id: "scaling-risk", statement: "Confirm the growth boundary.", provenance: "User claim user-claim-1 and Architecture Boundary target growth-boundary", claim_ids: ["user-claim-1"], target_ids: ["growth-boundary"], unavailable_refs: { principle_ids: "No approved Principle is available for this concern.", evidence_ids: "No project Evidence is currently linked." }, status: "open" }] });
  const gates = evaluateDecisionGate(withValidApproval(), TARGETS, openObjection, { claimIds: ["user-claim-1"] });
  assert.equal(gates.decision_review_complete.status, "blocked");
});

test("review gate blocks new material until exact content has user use-approval", () => {
  const material = {
    id: "review-source-pack", source_ids: ["source-1"], claim_ids: ["claim-1"],
    presented_content: "Source excerpt: warm services show bounded queue growth after traffic peaks.",
    context: "Claim applies to a warm service after peak traffic starts.", provenance: "Source section 3, table 2.",
  };
  const approval = recordMaterialApproval(material, { role: "user", id: "human-1" }, "approved");
  const review = withValidReview({ ...REVIEW, material_ids: [material.id], material_approval: { approval_id: approval.id } });
  assert.equal(evaluateDecisionGate(withValidApproval(), TARGETS, review).decision_review_complete.status, "blocked");
  assert.equal(evaluateDecisionGate(withValidApproval(), TARGETS, review, { materialApprovals: { [approval.id]: approval } }).decision_review_complete.status, "pass");

  const changed = { ...approval, presented_content: "Changed source and claim content under the same IDs." };
  assert.equal(evaluateDecisionGate(withValidApproval(), TARGETS, review, { materialApprovals: { [approval.id]: changed } }).decision_review_complete.status, "fail");
  const rejected = { ...approval, result: "rejected" };
  assert.equal(evaluateDecisionGate(withValidApproval(), TARGETS, review, { materialApprovals: { [approval.id]: rejected } }).decision_review_complete.status, "blocked");

  const secondMaterial = { ...material, id: "second-source-pack", source_ids: ["source-2"], claim_ids: ["claim-2"], presented_content: "Source excerpt: independent second study. Claim: this workload differs." };
  const secondApproval = recordMaterialApproval(secondMaterial, { role: "user", id: "human-1" }, "approved");
  const multiple = withValidReview({
    ...REVIEW,
    material_ids: [material.id, secondMaterial.id],
    material_approvals: [{ approval_id: approval.id }, { approval_id: secondApproval.id }],
  });
  assert.equal(evaluateDecisionGate(withValidApproval(), TARGETS, multiple, { materialApprovals: { [approval.id]: approval } }).decision_review_complete.status, "blocked", "every used material requires an approval");
  assert.equal(evaluateDecisionGate(withValidApproval(), TARGETS, multiple, { materialApprovals: { [approval.id]: approval, [secondApproval.id]: secondApproval } }).decision_review_complete.status, "pass");
});

test("review gate requires material inventory and resolves claims against available approvals", () => {
  const missingInventory = { ...REVIEW };
  delete missingInventory.material_ids;
  assert.ok(validateReviewRecord(missingInventory, { decisionIds: [DECISION.id] }).errors.some((error) => error.code === "missing_material_ids"));
  assert.equal(evaluateDecisionGate(withValidApproval(), TARGETS, missingInventory).decision_review_complete.status, "fail");

  const material = { id: "review-source", source_ids: ["source-1"], claim_ids: ["supported-claim"], presented_content: "Source excerpt: supported behavior. Claim: it applies under the observed load.", context: "Relevant section", provenance: "Presented report section 2." };
  const materialApproval = recordMaterialApproval(material, { role: "user", id: "human-1" }, "approved");
  const objection = {
    id: "unsupported-claim", statement: "Explain the user claim.", provenance: "User claim supported-claim.",
    claim_ids: ["unsupported-claim"], target_ids: ["growth-boundary"],
    unavailable_refs: { principle_ids: "No approved Principle is available.", evidence_ids: "No linked Evidence is available." },
    status: "open",
  };
  const review = withValidReview({
    ...REVIEW,
    material_ids: [material.id],
    material_approval: { approval_id: materialApproval.id },
    objections: [objection],
  });
  const result = evaluateDecisionGate(withValidApproval(), TARGETS, review, { materialApprovals: { [materialApproval.id]: materialApproval } }).decision_review_complete;
  assert.equal(result.status, "fail");
  assert.ok(result.violations.some((error) => error.code === "unknown_claim_ref"));

  const supportedReview = withValidReview({ ...review, objections: [{ ...objection, claim_ids: ["supported-claim"] }] });
  const supported = evaluateDecisionGate(withValidApproval(), TARGETS, supportedReview, { materialApprovals: { [materialApproval.id]: materialApproval } }).decision_review_complete;
  assert.equal(supported.status, "blocked", "an approved claim reference passes integrity validation but its open objection remains unresolved");
  assert.equal(supported.violations.some((error) => error.code === "unknown_claim_ref"), false);

  const orphanedApproval = withValidReview({ ...review, material_ids: [] });
  assert.equal(evaluateDecisionGate(withValidApproval(), TARGETS, orphanedApproval, { materialApprovals: { [materialApproval.id]: materialApproval } }).decision_review_complete.status, "fail");
});

test("an objection must trace each available reference or state why that reference is unavailable", () => {
  const missingTrace = withValidReview({ ...REVIEW, outcome: "NEEDS_DEFENSE", objections: [{ id: "unsupported-objection", statement: "Explain the claim.", provenance: "Review finding", status: "open" }] });
  const invalid = validateReviewRecord(missingTrace, { targetIds: ["growth-boundary"] });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.code === "missing_objection_reference"));

  const explicitGaps = withValidReview({ ...REVIEW, outcome: "NEEDS_DEFENSE", objections: [{
    id: "scaling-risk", statement: "Explain the user claim at the growth boundary.", provenance: "User claim user-claim-1 against target growth-boundary.",
    claim_ids: ["user-claim-1"], target_ids: ["growth-boundary"], status: "open",
    unavailable_refs: { principle_ids: "No approved Principle is available for this design topic.", evidence_ids: "No project Evidence is currently linked to this decision." },
  }] });
  assert.equal(validateReviewRecord(explicitGaps, { claimIds: ["user-claim-1"], targetIds: ["growth-boundary"] }).valid, true);
});

test("a closed objection requires recorded user reasoning, not only an answer", () => {
  const objection = {
    id: "reasoned-objection", statement: "Explain the boundary choice.", provenance: "User claim claim-1 against target-1.",
    claim_ids: ["claim-1"], target_ids: ["target-1"],
    unavailable_refs: { principle_ids: "No approved Principle is available.", evidence_ids: "No linked Evidence is available." },
    status: "answered", answer: "ㅇㅇ",
  };
  const invalid = validateReviewRecord(withValidReview({ ...REVIEW, objections: [objection] }), { claimIds: ["claim-1"], targetIds: ["target-1"] });
  assert.ok(invalid.errors.some((error) => error.code === "missing_objection_rationale"));
  const valid = validateReviewRecord(withValidReview({ ...REVIEW, objections: [{ ...objection, rationale: "The team accepts this limit because the measured peak remains below it." }] }), { claimIds: ["claim-1"], targetIds: ["target-1"] });
  assert.equal(valid.valid, true);
});

test("decision and review schemas express the closed v1 contracts", async () => {
  const decisionSchema = parseYaml(await (await import("node:fs/promises")).readFile(new URL("../.codex/schemas/decision/architecture-decision.schema.yaml", import.meta.url), "utf8"));
  const reviewSchema = parseYaml(await (await import("node:fs/promises")).readFile(new URL("../.codex/schemas/decision/review.schema.yaml", import.meta.url), "utf8"));
  assert.equal(decisionSchema.additional_properties, false);
  assert.deepEqual(decisionSchema.properties.category.enum, ["code", "infrastructure"]);
  assert.deepEqual(reviewSchema.properties.outcome.enum, ["ACCEPTED", "NEEDS_DEFENSE", "NEEDS_EVIDENCE", "NEEDS_REVISION"]);
  assert.deepEqual(reviewSchema.properties.checklist.required, ["requirements", "targets", "alternatives", "tradeoffs", "evidence", "boundary", "answered_objections"]);
  assert.ok(reviewSchema.required.includes("material_ids"));
  assert.deepEqual(reviewSchema.properties.material_approval.required, ["approval_id"]);
  assert.deepEqual(reviewSchema.properties.material_approvals.items.required, ["approval_id"]);
  const workflowSchema = parseYaml(await readFile(new URL("../.codex/schemas/workflow.schema.yaml", import.meta.url), "utf8"));
  assert.ok(workflowSchema.properties.stages.items.properties.gates.items.enum.includes("decision_evidence_complete"));
  assert.ok(workflowSchema.properties.stages.items.properties.condition.enum.includes("learning_mode"));
});

test("decision and review artifact adapters preserve validated YAML objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "architecture-decision-"));
  try {
    const decision = withValidApproval();
    await writeArchitectureDecision({ root, ticketId: "506", decision, refs: { targetIds: ["growth-boundary"] } });
    const review = withValidReview();
    await writeReviewRecord({ root, ticketId: "506", review, refs: { decisionIds: ["api-boundary"] } });
    const materialApproval = recordMaterialApproval({ id: "source-pack", source_ids: ["source-1"], claim_ids: ["claim-1"], presented_content: "Source excerpt: peak traffic occurs in section 4. Claim: capacity covers that load.", context: "Section 4, peak traffic", provenance: "User presented report section 4." }, { role: "user", id: "human-1" }, "approved");
    await writeMaterialApproval({ root, ticketId: "506", approval: materialApproval });
    assert.deepEqual(await readArchitectureDecision({ root, ticketId: "506", decisionId: decision.id, refs: { targetIds: ["growth-boundary"] } }), decision);
    assert.deepEqual(await readReviewRecord({ root, ticketId: "506", reviewId: REVIEW.id, refs: { decisionIds: ["api-boundary"] } }), review);
    assert.deepEqual(await readMaterialApproval({ root, ticketId: "506", approvalId: materialApproval.id }), materialApproval);
    await writeFile(join(root, "docs", "specs", "506", "architecture-decisions", `${decision.id}.yaml`), JSON.stringify({ ...decision, id: "wrong-decision-id" }));
    await assert.rejects(() => readArchitectureDecision({ root, ticketId: "506", decisionId: decision.id }), /different object ID/);
    await writeFile(join(root, "docs", "specs", "506", "architecture-reviews", `${REVIEW.id}.yaml`), JSON.stringify({ ...review, id: "wrong-review-id" }));
    await assert.rejects(() => readReviewRecord({ root, ticketId: "506", reviewId: REVIEW.id }), /different object ID/);
    await assert.rejects(() => readArchitectureDecision({ root, ticketId: "../escape", decisionId: "x" }), /safe ticket identifier/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decision gates are common to Learning and Normal and skip legacy unmarked tickets", async () => {
  const workflow = await loadNamedWorkflow("spec-me", { root: ROOT });
  const architecture = workflow.stages.find((stage) => stage.id === "verify-architecture-decisions");
  assert.ok(architecture.gates.includes("decision_evidence_complete"));
  assert.ok(architecture.gates.includes("decision_review_complete"));
  const root = await mkdtemp(join(tmpdir(), "architecture-decision-gates-"));
  try {
    const legacy = { ...TARGETS };
    delete legacy.decision_metadata;
    await writeSystemTargets({ root, ticketId: "legacy", targets: legacy });
    const decisionGatedWorkflow = { ...workflow, stages: [{ ...architecture, gates: ["decision_evidence_complete", "decision_review_complete"] }] };
    const legacyResults = await evaluateStageGates({ workflow: decisionGatedWorkflow, stageId: architecture.id, root, ticketId: "legacy", mode: "Learning" });
    assert.deepEqual(legacyResults.map((gate) => gate.status), ["pass", "pass"]);

    await writeSystemTargets({ root, ticketId: "506", targets: TARGETS });
    const principleId = "system-boundary-principle";
    const sourceRecord = createSource({ id: "source-boundary", title: "Boundary Standard", uri: "https://example.test/boundary", publisher: "Boundary Council", tier: "formal_standards", authority: "Boundary Council", independent_authority_id: "boundary-council", recency: "high", relevance: "high", commercial_bias: "low", primary_source: true, preference: "preferred", domain_metadata: { area: "architecture" }, discovered_at: "2026-01-01T00:00:00.000Z", collection_status: "not_collected" });
    const claimRecord = createClaim({ id: "claim-boundary", source_id: sourceRecord.id, statement: "System boundaries should follow workload changes", locator: { section: "1", excerpt: "System boundaries should follow workload changes" }, retrieved_at: "2026-01-01T00:00:00.000Z", context: "Architecture boundary decisions", qualifiers: [] });
    const principleRecord = createPrinciple({ id: principleId, title: "Respect workload boundaries", statement: "Architecture should respond to workload boundaries.", strength: "SHOULD", consensus: "Supported by the cited standard.", applies_when: ["workload changes"], exceptions: [], supporting_claim_ids: [claimRecord.id], contradicting_claim_ids: [], corroboration: [{ independent_authority_id: "boundary-council", claim_ids: [claimRecord.id], assessment: "Supports this boundary." }], countersearch: [{ query: "boundary counter-evidence", searched_at: "2026-01-01T00:00:00.000Z", result: "no_results", scope: "Formal standards", assessment: "No relevant counter-evidence." }], review: { actor: "reviewer", outcome: "accepted", assessment: "Support and countersearch reviewed." }, status: "candidate", history: [{ status: "candidate", at: "2026-01-01T00:00:00.000Z", actor: "researcher" }] });
    await writeSource({ root, source: sourceRecord });
    await writeClaim({ root, claim: claimRecord });
    await writePrinciple({ root, principle: principleRecord });
    await recordPrincipleReview({ root, principleId, review: principleRecord.review, at: "2026-01-01T00:01:00.000Z", minimum_independent_authorities: 1 });
    await approvePrinciple({ root, principleId, actor: { role: "user", id: "user" }, at: "2026-01-01T00:02:00.000Z" });
    const evidence = createEvidence({ id: "adr-context", origin_project: "project-506", environment: { runtime: "node" }, timestamp: "2026-01-01T00:00:00.000Z", type: "benchmark", execution_status: "completed", measurement_validity: "valid", observations: [{ metric: "average_rps", value: 10, unit: "rps" }], source_reference: "run-506", decision_ids: ["api-boundary"], summary: "Measured baseline capacity." });
    evidence.approval = { actor_type: "human", actor: "user", approved_at: "2026-01-01T00:03:00.000Z", summary_sha256: computeEvidenceApprovalHash(evidence) };
    await writeEvidence({ root, evidence });
    const decisionWithPrinciple = structuredClone(DECISION);
    decisionWithPrinciple.principle_ids = [principleId];
    await writeArchitectureDecision({ root, ticketId: "506", decision: withValidApproval(decisionWithPrinciple), refs: { targetIds: ["growth-boundary"] } });
    await writeReviewRecord({ root, ticketId: "506", review: withValidReview(), refs: { decisionIds: ["api-boundary"] } });
    const result = await evaluateStageGates({ workflow: decisionGatedWorkflow, stageId: architecture.id, root, ticketId: "506", mode: "Normal" });
    assert.deepEqual(result.map((gate) => gate.status), ["pass", "pass"]);
    const material = { id: "new-source-pack", source_ids: ["source-1"], claim_ids: ["claim-1"], presented_content: "Source excerpt: peak load behavior from section 4. Claim: observed load remains within the stated boundary.", context: "Peak load behavior from section 4.", provenance: "Presented report section 4." };
    const materialApproval = recordMaterialApproval(material, { role: "user", id: "human-1" }, "approved");
    const reviewWithNewMaterial = withValidReview({ ...REVIEW, material_ids: [material.id], material_approval: { approval_id: materialApproval.id } });
    await writeReviewRecord({ root, ticketId: "506", review: reviewWithNewMaterial, refs: { decisionIds: ["api-boundary"] } });
    assert.equal((await evaluateStageGates({ workflow: decisionGatedWorkflow, stageId: architecture.id, root, ticketId: "506" }))[1].status, "blocked");
    await writeMaterialApproval({ root, ticketId: "506", approval: materialApproval });
    assert.equal((await evaluateStageGates({ workflow: decisionGatedWorkflow, stageId: architecture.id, root, ticketId: "506" }))[1].status, "pass");
    for (const gateId of ["decision_evidence_complete", "decision_review_complete"]) {
      const cli = spawnSync(process.execPath, [join(ROOT, ".codex/scripts/harness-decision-gate.mjs"), gateId, "--ticket", "506"], { cwd: root, encoding: "utf8" });
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(JSON.parse(cli.stdout).status, "pass");
    }
    const reviewWithUserClaim = withValidReview({
      ...REVIEW,
      objections: [{
        id: "user-claim-objection", statement: "Explain the user claim at this boundary.", provenance: "User claim user-claim-1 against growth-boundary.",
        claim_ids: ["user-claim-1"], target_ids: ["growth-boundary"],
        unavailable_refs: { principle_ids: "No approved Principle is available.", evidence_ids: "No linked Evidence is available." },
        status: "resolved", answer: "The claim is constrained to the measured growth boundary.", rationale: "We measured the boundary at peak load and accept the limit beyond it.",
      }],
    });
    await writeReviewRecord({ root, ticketId: "506", review: reviewWithUserClaim, refs: { decisionIds: ["api-boundary"] } });
    assert.equal((await evaluateStageGates({ workflow: decisionGatedWorkflow, stageId: architecture.id, root, ticketId: "506", claimIds: ["user-claim-1"] }))[1].status, "pass");
    const unknownUserClaim = (await evaluateStageGates({ workflow: decisionGatedWorkflow, stageId: architecture.id, root, ticketId: "506" }))[1];
    assert.equal(unknownUserClaim.status, "fail");
    assert.ok(unknownUserClaim.violations.some((error) => error.code === "unknown_claim_ref"));
    await rm(join(root, "knowledge", "principles", `${principleId}.yaml`));
    const missingPrincipleGate = await evaluateDecisionEvidenceComplete({ root, ticketId: "506" });
    assert.equal(missingPrincipleGate.status, "blocked");
    await assert.rejects(() => validateEvidenceReferences({ root, evidenceIds: ["missing-evidence"] }), (error) => error.code === "ENOENT");
    await assert.rejects(() => validatePrincipleReferences({ root, principleIds: ["missing-principle"] }), (error) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
