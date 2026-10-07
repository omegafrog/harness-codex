import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeApprovalHash } from "../src/decision/approval.mjs";
import { writeSystemTargets } from "../src/decision/artifacts.mjs";
import { evaluateDecisionEvidenceComplete } from "../src/workflow/stage-gates.mjs";
import { createClaim, createPrinciple, createSource } from "../src/knowledge/model.mjs";
import { approvePrinciple, lookupPrinciples, recordPrincipleReview, transitionPrinciple, writeClaim, writeEvidence, writePrinciple, writeSource } from "../src/knowledge/registry.mjs";
import { computeEvidenceApprovalHash } from "../src/knowledge/validation.mjs";
import { compareKnowledgeMerge } from "../src/knowledge/merge.mjs";
import { markDeprecatedPrincipleImpacts } from "../src/decision/impact.mjs";

function source() {
  return createSource({
    id: "source-ops", title: "Operations Standard", uri: "https://example.test/ops", publisher: "Ops Council",
    tier: "formal_standards", authority: "Ops Council", independent_authority_id: "ops-council",
    recency: "high", relevance: "high", commercial_bias: "low", primary_source: true, preference: "preferred",
    domain_metadata: { area: "operations" }, discovered_at: "2026-10-01T00:00:00.000Z", collection_status: "not_collected",
  });
}

function claim() {
  return createClaim({
    id: "claim-timeout", source_id: "source-ops", statement: "Remote calls need a bounded timeout",
    locator: { section: "3.1", excerpt: "Remote calls need a bounded timeout" }, retrieved_at: "2026-10-01T00:00:00.000Z",
    context: "Synchronous service calls", qualifiers: [],
  });
}

function principle(status = "candidate") {
  const value = createPrinciple({
    id: `principle-${status}`, title: "Bound remote calls", statement: "Remote calls should have bounded timeouts.",
    strength: "SHOULD", consensus: "Independent sources support bounded waits.", applies_when: ["synchronous calls"], exceptions: [],
    supporting_claim_ids: ["claim-timeout"], contradicting_claim_ids: [],
    corroboration: [{ independent_authority_id: "ops-council", claim_ids: ["claim-timeout"], assessment: "Supports bounded waits." }],
    countersearch: [{ query: "unbounded synchronous calls", searched_at: "2026-10-01T00:00:00.000Z", result: "no_results", scope: "Operations standards", assessment: "No counter-evidence found." }],
    review: { actor: "reviewer", outcome: "accepted", assessment: "Support and countersearch reviewed." },
    status, history: [{ status: "candidate", at: "2026-10-01T00:00:00.000Z", actor: "researcher" }],
  });
  return value;
}

function decision() {
  const value = {
    schema_version: 1, id: "decision-a", status: "accepted", category: "code",
    problem: "Set a timeout", constraints: ["Existing runtime"], requirement_ids: ["REQ-1"], target_ids: ["target-a"],
    options: [{ id: "bounded", description: "Use a bounded timeout" }, { id: "open", description: "Wait forever" }],
    selected_option: "bounded", rejected_alternatives: [{ option_id: "open", reason: "Can exhaust workers." }],
    rationale: "Bounded waits free capacity.", tradeoffs: ["Timeout values need tuning."], principle_ids: ["principle-old"],
    evidence_ids: ["evidence-a"], boundary: "Revisit when workload changes.", review_id: "review-a",
  };
  value.approval = { approver: "user", approved_at: "2026-10-01T00:00:00.000Z", subject_hash: computeApprovalHash(value) };
  value.history = [{ event: "accepted", at: "2026-10-01T00:00:00.000Z" }];
  return value;
}

test("Principle lookup keeps approved authority separate from informational candidates and never writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-lookup-"));
  try {
    await writeSource({ root, source: source() });
    await writeClaim({ root, claim: claim() });
    await writePrinciple({ root, principle: principle("candidate") });
    const approved = principle("candidate");
    approved.id = "principle-approved";
    await writePrinciple({ root, principle: approved });
    await recordPrincipleReview({ root, principleId: approved.id, review: approved.review, at: "2026-10-01T00:01:00.000Z", minimum_independent_authorities: 1 });
    await approvePrinciple({ root, principleId: approved.id, actor: { role: "user", id: "user" }, at: "2026-10-01T00:02:00.000Z" });
    const evidence = {
      schema_version: 1, id: "evidence-timeout", origin_project: "project-a", environment: { runtime: "node" },
      timestamp: "2026-10-01T00:00:00.000Z", type: "benchmark", execution_status: "completed", measurement_validity: "valid",
      observations: [{ metric: "timeout_ms", value: 500, unit: "ms" }], source_reference: "run-1", decision_ids: ["decision-a"], summary: "Observed bounded timeout behavior.",
    };
    evidence.approval = { actor_type: "human", actor: "user", approved_at: "2026-10-01T00:03:00.000Z", summary_sha256: computeEvidenceApprovalHash(evidence) };
    await writeEvidence({ root, evidence });
    const result = await lookupPrinciples({ root, query: "bounded timeout" });
    assert.deepEqual(result.authoritative.map(({ id }) => id), ["principle-approved"]);
    assert.equal(result.informational.length, 1);
    assert.equal(result.next_step, "material_use_approval");
    assert.equal(result.registry_write_performed, false);
    assert.equal(JSON.parse(await readFile(join(root, "knowledge", "principles", "principle-candidate.yaml"), "utf8")).status, "candidate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty or informational-only lookup directs research and hold without creating a Principle", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-empty-lookup-"));
  try {
    const empty = await lookupPrinciples({ root, query: "timeouts" });
    assert.deepEqual(empty.authoritative, []);
    assert.deepEqual(empty.informational, []);
    assert.equal(empty.next_step, "research_or_approval_then_hold");
    assert.equal(empty.semantic_sufficiency, "insufficient");
    assert.equal(empty.registry_write_performed, false);
    assert.equal((await readdir(join(root, "knowledge", "principles")).catch(() => [])).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-ID three-way Knowledge comparison allows unchanged/identical content and reports divergent body or approval", () => {
  const base = { id: "claim-a", statement: "Base", approval: { body_sha256: "base" } };
  assert.deepEqual(compareKnowledgeMerge(base, { ...base, statement: "Ours" }, base), []);
  assert.deepEqual(compareKnowledgeMerge(base, { ...base, statement: "Ours" }, { ...base, statement: "Ours" }), []);
  const conflicts = compareKnowledgeMerge(base, { ...base, statement: "Ours" }, { ...base, approval: { body_sha256: "theirs" } });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].id, "claim-a");
  assert.ok(conflicts[0].fields.includes("statement"));
  assert.ok(conflicts[0].fields.includes("approval"));
});

test("deprecating a referenced Principle marks only affected Decisions and preserves their history and approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-impact-"));
  try {
    const targets = {
      schema_version: 1, id: "system-targets",
      system_characteristics: { interaction: "HTTP", workload: "steady", state: "durable", consistency: "strong", availability: "continuous", growth: "moderate" },
      initial: [], expected_growth: [{ id: "target-a", metric: "average_rps", status: "resolved", value: 10, unit: "rps", provenance: "estimated", confidence: "medium", rationale: "Observed baseline." }], architecture_boundary: [],
      decision_metadata: { decision_layer_version: 1, decision_ids: ["decision-a"] },
    };
    await writeSystemTargets({ root, ticketId: "ticket-a", targets });
    const sourceRecord = source();
    const claimRecord = claim();
    await writeSource({ root, source: sourceRecord });
    await writeClaim({ root, claim: claimRecord });
    const deprecatedPrinciple = principle("candidate");
    deprecatedPrinciple.id = "principle-old";
    await writePrinciple({ root, principle: deprecatedPrinciple });
    await recordPrincipleReview({ root, principleId: deprecatedPrinciple.id, review: deprecatedPrinciple.review, at: "2026-10-01T00:01:00.000Z", minimum_independent_authorities: 1 });
    await approvePrinciple({ root, principleId: deprecatedPrinciple.id, actor: { role: "user", id: "user" }, at: "2026-10-01T00:02:00.000Z" });
    await mkdir(join(root, "docs/specs/ticket-a/architecture-decisions"), { recursive: true });
    await mkdir(join(root, "docs/specs/ticket-b/architecture-decisions"), { recursive: true });
    await writeFile(join(root, "docs/specs/ticket-a/architecture-decisions/decision-a.yaml"), JSON.stringify(decision()));
    await writeFile(join(root, "docs/specs/ticket-b/architecture-decisions/decision-a.yaml"), JSON.stringify({ ...decision(), id: "decision-b", principle_ids: [] }));
    await transitionPrinciple({ root, principleId: "principle-old", to: "deprecated", actor: "user", at: "2026-10-01T00:04:00.000Z", reason: "Superseded guidance." });
    const results = await markDeprecatedPrincipleImpacts({ root, principleId: "principle-old" });
    assert.deepEqual(results.map(({ ticketId, decisionId }) => [ticketId, decisionId]), [["ticket-a", "decision-a"]]);
    const marked = JSON.parse(await readFile(join(root, "docs/specs/ticket-a/architecture-decisions/decision-a.yaml"), "utf8"));
    assert.equal(marked.review_required, true);
    assert.deepEqual(marked.history, decision().history);
    assert.deepEqual(marked.approval, decision().approval);
    assert.equal((await evaluateDecisionEvidenceComplete({ root, ticketId: "ticket-a" })).status, "blocked");
    const unrelated = JSON.parse(await readFile(join(root, "docs/specs/ticket-b/architecture-decisions/decision-a.yaml"), "utf8"));
    assert.equal(unrelated.review_required, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
