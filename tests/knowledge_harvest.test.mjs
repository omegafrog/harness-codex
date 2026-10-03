import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createClaim, createPrinciple, createSource, SOURCE_TIERS } from "../src/knowledge/model.mjs";
import { computePrincipleApprovalHash, validateClaim, validatePrinciple, validateSource } from "../src/knowledge/validation.mjs";
import { approvePrinciple, readClaim, readPrinciple, readSource, revisePrinciple, transitionPrinciple, writeClaim, writePrinciple, writeSource } from "../src/knowledge/registry.mjs";
import { assessPrincipleEvidence, evaluateSource, groupIndependentAuthorities, rankSourceTiers } from "../src/knowledge/research.mjs";
import { parseYaml } from "../src/eval/yaml.mjs";
import { loadNamedWorkflow } from "../src/workflow/index.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function source(overrides = {}) {
  return createSource({
    id: "source-standard-2026",
    title: "Service Operations Standard",
    uri: "https://standards.example.test/service-operations",
    publisher: "Standards Council",
    tier: "formal_standards",
    authority: "Standards Council",
    independent_authority_id: "standards-council",
    recency: "high",
    relevance: "high",
    commercial_bias: "low",
    primary_source: true,
    preference: "preferred",
    domain_metadata: { domain: "service operations" },
    discovered_at: "2026-09-28T10:00:00.000Z",
    collection_status: "not_collected",
    ...overrides,
  });
}

function claim(overrides = {}) {
  return createClaim({
    id: "claim-timeout-boundary",
    source_id: "source-standard-2026",
    statement: "The service should impose a bounded timeout on remote operations.",
    locator: { section: "4.2", page: 18, uri_fragment: "timeouts" },
    retrieved_at: "2026-09-28T10:30:00.000Z",
    context: "This requirement applies to synchronous service-to-service calls.",
    qualifiers: ["The standard permits documented exceptions for batch operations."],
    ...overrides,
  });
}

function principle(overrides = {}) {
  return createPrinciple({
    id: "principle-bounded-timeouts",
    title: "Bound remote operation time",
    statement: "Remote operations should have a bounded timeout.",
    strength: "SHOULD",
    consensus: "strong support among independent standards and implementation guidance",
    applies_when: ["synchronous remote operations"],
    exceptions: ["batch operations with an explicit job deadline"],
    supporting_claim_ids: ["claim-timeout-boundary"],
    contradicting_claim_ids: [],
    corroboration: [{ independent_authority_id: "standards-council", claim_ids: ["claim-timeout-boundary"], assessment: "independent support" }],
    countersearch: [{ query: "unbounded timeout remote operation", searched_at: "2026-09-28T11:00:00.000Z", result: "no_results", scope: "formal standards and primary technical sources for synchronous remote calls", assessment: "No relevant counter-evidence found in the stated scope." }],
    review: { actor: "knowledge-principle-reviewer", outcome: "accepted", assessment: "Support and countersearch reviewed; no unresolved material counter-evidence." },
    status: "candidate",
    history: [{ status: "candidate", at: "2026-09-28T11:30:00.000Z", actor: "synthesizer" }],
    ...overrides,
  });
}

test("Source model exposes the six discovery tiers in priority order", () => {
  assert.deepEqual(SOURCE_TIERS, [
    "formal_standards",
    "industry_framework",
    "primary_technical",
    "established_expert",
    "empirical",
    "community",
  ]);
  assert.equal(createSource({ id: "s1" }).schema_version, 1);
  assert.equal(createClaim({ id: "c1" }).schema_version, 1);
});

test("Source qualification keeps dimensions distinct and Community cannot qualify alone", () => {
  const evaluated = evaluateSource(source());
  assert.equal(evaluated.tier_priority, 1);
  assert.equal(evaluated.qualification, "qualified");
  assert.deepEqual(evaluated.dimensions, {
    authority: "Standards Council",
    independence: "standards-council",
    recency: "high",
    relevance: "high",
    commercial_bias: "low",
    primary_source: true,
    preference: "preferred",
    domain_metadata: { domain: "service operations" },
  });

  const community = evaluateSource(source({ id: "community-post", tier: "community", primary_source: false }));
  assert.equal(community.tier_priority, 6);
  assert.equal(community.qualification, "not_independent_support");
  assert.equal(community.can_stand_alone_for_principle, false);
});

test("tier ranking and independent authority grouping do not count same-publisher documents twice", () => {
  const ranked = rankSourceTiers([
    { id: "community", tier: "community" },
    { id: "framework", tier: "industry_framework" },
    { id: "standard", tier: "formal_standards" },
  ]);
  assert.deepEqual(ranked.map(({ id }) => id), ["standard", "framework", "community"]);

  const grouped = groupIndependentAuthorities([
    source({ id: "same-a", independent_authority_id: "standards-council" }),
    source({ id: "same-b", independent_authority_id: "standards-council" }),
    source({ id: "other", independent_authority_id: "other-body" }),
  ]);
  assert.equal(grouped.independent_authority_count, 2);
  assert.deepEqual(grouped.groups.map(({ independent_authority_id, source_ids }) => [independent_authority_id, source_ids]), [
    ["standards-council", ["same-a", "same-b"]],
    ["other-body", ["other"]],
  ]);
});

test("Source and Claim validation closes fields and preserves atomic provenance", () => {
  assert.deepEqual(validateSource(source()), { valid: true, errors: [] });
  assert.deepEqual(validateClaim(claim(), { sourceIds: ["source-standard-2026"] }), { valid: true, errors: [] });

  const missingLocator = claim({ locator: {} });
  assert.ok(validateClaim(missingLocator, { sourceIds: ["source-standard-2026"] }).errors.some(({ code }) => code === "missing_locator_detail"));
  assert.ok(validateClaim(claim(), { sourceIds: [] }).errors.some(({ code }) => code === "unknown_source_ref"));
  assert.ok(validateClaim(claim({ statement: "The service should use bounded timeouts. It should retry failed calls." }), { sourceIds: ["source-standard-2026"] }).errors.some(({ code }) => code === "non_atomic_claim"));
  assert.ok(validateSource(source({ unexpected: true })).errors.some(({ code }) => code === "unknown_source_field"));
});

test("Principle validation requires conditions, references, independent corroboration, scoped countersearch, and reviewer assessment", () => {
  const sourceRecord = source();
  const supportedClaim = claim();
  const refs = { claims: [supportedClaim], sources: [sourceRecord] };
  assert.deepEqual(validatePrinciple(principle(), refs), { valid: true, errors: [] });
  assert.ok(validatePrinciple(principle({ countersearch: [] }), refs).errors.some(({ code }) => code === "missing_countersearch"));
  assert.ok(validatePrinciple(principle({ countersearch: [{ query: "timeout counterevidence", searched_at: "2026-09-28T11:00:00Z", result: "no_results", assessment: "Nothing found" }] }), refs).errors.some(({ code }) => code === "missing_countersearch_scope"));
  assert.ok(validatePrinciple(principle({ supporting_claim_ids: ["missing-claim"] }), refs).errors.some(({ code }) => code === "unknown_claim_ref"));
  assert.ok(validatePrinciple(principle({ status: "approved" }), refs).errors.some(({ code }) => code === "missing_human_approval"));
  const approved = principle({ status: "approved", approval: { actor_type: "human", actor: "jiwoo", approved_at: "2026-09-28T12:00:00.000Z", body_sha256: computePrincipleApprovalHash(principle()) } });
  assert.ok(validatePrinciple(approved, refs).valid);
  assert.ok(validatePrinciple({ ...approved, approval: { ...approved.approval, approved_at: "September 28, 2026" } }, refs).errors.some(({ code }) => code === "missing_human_approval"));
  assert.ok(validatePrinciple({ ...principle(), history: [{ status: "candidate", actor: "synth", at: "Sep 28, 2026" }] }, refs).errors.some(({ code }) => code === "invalid_principle_history"));
  const held = principle({ review: { actor: "reviewer", outcome: "needs_evidence", assessment: "One authority is insufficient." } });
  assert.equal(validatePrinciple(held, refs).valid, true);
  assert.ok(assessPrincipleEvidence({ principle: held, claims: refs.claims, sources: refs.sources, minimum_independent_authorities: 1 }).blockers.includes("missing_accepted_review"));
  const unresolved = principle({ review: { actor: "reviewer", outcome: "accepted", assessment: "looks good" }, unresolved_counter_evidence: ["material contradiction"] });
  assert.equal(assessPrincipleEvidence({ principle: unresolved, claims: refs.claims, sources: refs.sources, minimum_independent_authorities: 1 }).approval_ready, false);
  assert.ok(assessPrincipleEvidence({ principle: unresolved, claims: refs.claims, sources: refs.sources, minimum_independent_authorities: 1 }).blockers.includes("unresolved_counter_evidence"));
});

test("independence gate counts authorities, not Source/Claim volume, and never infers consensus", () => {
  const oneAuthority = [source({ id: "s-a" }), source({ id: "s-b" })];
  const oneClaimEach = [claim({ id: "c-a", source_id: "s-a" }), claim({ id: "c-b", source_id: "s-b" })];
  const assessment = assessPrincipleEvidence({ principle: principle({
    supporting_claim_ids: ["c-a", "c-b"],
    corroboration: [
      { independent_authority_id: "standards-council", claim_ids: ["c-a"], assessment: "Corroborates the claim." },
      { independent_authority_id: "standards-council", claim_ids: ["c-b"], assessment: "A second document from the same authority." },
    ],
  }), claims: oneClaimEach, sources: oneAuthority, minimum_independent_authorities: 2 });
  assert.equal(assessment.independent_authority_count, 1);
  assert.equal(assessment.approval_ready, false);
  assert.equal(assessment.consensus, "strong support among independent standards and implementation guidance");
  assert.equal(assessment.consensus_inferred, false);
});

test("Principle own-body hash invalidates approval; human approval is distinct and lifecycle history survives deprecation", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-principle-registry-"));
  try {
    const original = principle();
    const refs = { claims: [claim()], sources: [source()] };
    await writePrinciple({ root, principle: original, refs });
    await assert.rejects(() => transitionPrinciple({ root, principleId: original.id, to: "reviewed", actor: "reviewer", at: "September 28, 2026", refs }), /ISO 8601/);
    const reviewed = await transitionPrinciple({ root, principleId: original.id, to: "reviewed", actor: "reviewer", at: "2026-09-28T12:00:00.000Z", refs, minimum_independent_authorities: 1 });
    assert.equal(reviewed.principle.status, "reviewed");
    await assert.rejects(() => writePrinciple({ root, principle: reviewed.principle, refs }), /transitionPrinciple/);
    await assert.rejects(() => approvePrinciple({ root, principleId: original.id, actor: "knowledge-principle-reviewer", at: "2026-09-28T12:01:00.000Z", refs }), /human approver/);
    const approved = await approvePrinciple({ root, principleId: original.id, actor: "jiwoo", at: "2026-09-28T12:01:00.000Z", refs });
    assert.equal(approved.principle.status, "approved");
    assert.equal(approved.principle.approval.body_sha256, computePrincipleApprovalHash(approved.principle));
    await assert.rejects(() => writePrinciple({ root, principle: approved.principle, refs }), /approvePrinciple/);
    const edited = { ...approved.principle, statement: "Remote operations usually need bounded timeouts." };
    assert.ok(validatePrinciple(edited, refs).errors.some(({ code }) => code === "approval_hash_mismatch"));
    const revised = await revisePrinciple({ root, principleId: original.id, changes: { statement: edited.statement }, actor: "jiwoo", at: "2026-09-28T12:02:00.000Z", refs });
    assert.equal(revised.principle.status, "candidate");
    assert.equal("approval" in revised.principle, false);
    await transitionPrinciple({ root, principleId: original.id, to: "reviewed", actor: "reviewer", at: "2026-09-28T12:03:00.000Z", refs, minimum_independent_authorities: 1 });
    await approvePrinciple({ root, principleId: original.id, actor: "jiwoo", at: "2026-09-28T12:04:00.000Z", refs });
    const deprecated = await transitionPrinciple({ root, principleId: original.id, to: "deprecated", actor: "jiwoo", at: "2026-09-28T12:05:00.000Z", reason: "superseded guidance", refs });
    assert.equal(deprecated.principle.status, "deprecated");
    assert.deepEqual(deprecated.principle.history.map(({ status }) => status), ["candidate", "reviewed", "approved", "candidate", "reviewed", "approved", "deprecated"]);
    assert.equal((await readPrinciple({ root, principleId: original.id, refs })).status, "deprecated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source and claim schemas are closed version-one YAML contracts", async () => {
  const sourceSchemaPath = fileURLToPath(new URL("../.codex/schemas/knowledge/source.schema.yaml", import.meta.url));
  const claimSchemaPath = fileURLToPath(new URL("../.codex/schemas/knowledge/claim.schema.yaml", import.meta.url));
  const sourceSchema = parseYaml(await readFile(sourceSchemaPath, "utf8"));
  const claimSchema = parseYaml(await readFile(claimSchemaPath, "utf8"));
  const principleSchema = parseYaml(await readFile(fileURLToPath(new URL("../.codex/schemas/knowledge/principle.schema.yaml", import.meta.url)), "utf8"));
  assert.equal(sourceSchema.id, "knowledge-source");
  assert.equal(sourceSchema.additional_properties, false);
  assert.deepEqual(sourceSchema.properties.tier.enum, SOURCE_TIERS);
  assert.equal(claimSchema.id, "knowledge-claim");
  assert.equal(claimSchema.additional_properties, false);
  assert.deepEqual(claimSchema.required, ["schema_version", "id", "source_id", "statement", "locator", "retrieved_at", "context", "qualifiers"]);
  assert.equal(principleSchema.id, "knowledge-principle");
  assert.equal(principleSchema.additional_properties, false);
  assert.ok(principleSchema.properties.countersearch.items.properties.scope);
  assert.deepEqual(principleSchema.properties.strength.enum, ["MUST", "SHOULD", "MAY"]);
});

test("registry stores and reads sources and claims under project-local knowledge paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-harvest-registry-"));
  try {
    await writeSource({ root, source: source() });
    await writeClaim({ root, claim: claim(), refs: { sourceIds: ["source-standard-2026"] } });
    assert.deepEqual(await readSource({ root, sourceId: "source-standard-2026" }), source());
    assert.deepEqual(await readClaim({ root, claimId: "claim-timeout-boundary", refs: { sourceIds: ["source-standard-2026"] } }), claim());
    assert.match(await readFile(join(root, "knowledge", "sources", "source-standard-2026.yaml"), "utf8"), /independent_authority_id/);
    assert.match(await readFile(join(root, "knowledge", "claims", "claim-timeout-boundary.yaml"), "utf8"), /retrieved_at/);
    await assert.rejects(() => writeClaim({ root, claim: claim({ source_id: "missing-source" }), refs: { sourceIds: [] } }), /unknown_source_ref/);
    await assert.rejects(() => readSource({ root, sourceId: "../escape" }), /safe identifier/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry rejects symlink traversal and reports missing or malformed original-source records", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-harvest-registry-"));
  const outside = await mkdtemp(join(tmpdir(), "knowledge-harvest-outside-"));
  try {
    await mkdir(join(root, "knowledge"), { recursive: true });
    await symlink(outside, join(root, "knowledge", "sources"));
    await assert.rejects(() => writeSource({ root, source: source() }), /symlink/);
    await rm(join(root, "knowledge", "sources"));
    await assert.rejects(() => readSource({ root, sourceId: "unavailable-source" }), /ENOENT/);
    await mkdir(join(root, "knowledge", "sources"), { recursive: true });
    await writeFile(join(root, "knowledge", "sources", "unavailable-source.yaml"), "not: [valid", "utf8");
    await assert.rejects(() => readSource({ root, sourceId: "unavailable-source" }), /YAML|JSON|mapping/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("knowledge CLI validates, saves, and reads Source and Claim without synthesizing Principles", async () => {
  const script = join(ROOT, ".codex", "scripts", "harness-knowledge.mjs");
  const sourceRecord = source();
  const create = spawnSync(process.execPath, [script, "source", "validate", "--json", JSON.stringify(sourceRecord)], { cwd: ROOT, encoding: "utf8" });
  assert.equal(create.status, 0, create.stderr);
  assert.equal(JSON.parse(create.stdout).valid, true);

  const forbidden = spawnSync(process.execPath, [script, "principle", "synthesize"], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(forbidden.status, 0);
  assert.match(forbidden.stderr, /Usage:/);

  const root = await mkdtemp(join(tmpdir(), "knowledge-harvest-cli-"));
  try {
    const savedSource = spawnSync(process.execPath, [script, "source", "save", "--root", root, "--json", JSON.stringify(source())], { cwd: ROOT, encoding: "utf8" });
    assert.equal(savedSource.status, 0, savedSource.stderr);
    const savedClaim = spawnSync(process.execPath, [script, "claim", "save", "--root", root, "--json", JSON.stringify(claim())], { cwd: ROOT, encoding: "utf8" });
    assert.equal(savedClaim.status, 0, savedClaim.stderr);
    const readClaim = spawnSync(process.execPath, [script, "claim", "show", "--root", root, "--id", "claim-timeout-boundary"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(readClaim.status, 0, readClaim.stderr);
    assert.equal(JSON.parse(readClaim.stdout).source_id, "source-standard-2026");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge CLI cannot publish a candidate Principle", async () => {
  const script = join(ROOT, ".codex", "scripts", "harness-knowledge.mjs");
  const root = await mkdtemp(join(tmpdir(), "knowledge-principle-cli-"));
  try {
    await writeSource({ root, source: source() });
    await writeClaim({ root, claim: claim() });
    const candidate = spawnSync(process.execPath, [script, "principle", "save", "--root", root, "--json", JSON.stringify(principle())], { cwd: ROOT, encoding: "utf8" });
    assert.equal(candidate.status, 0, candidate.stderr);
    const publish = spawnSync(process.execPath, [script, "principle", "publish", "--root", root, "--id", "principle-bounded-timeouts"], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(publish.status, 0);
    assert.match(publish.stderr, /Only an approved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge harvest workflow, profiles, skill, and installer assets agree", async () => {
  const workflow = parseYaml(await readFile(join(ROOT, ".codex", "workflows", "knowledge-harvest-workflow.yaml"), "utf8"));
  assert.deepEqual(workflow.stages.map(({ id }) => id), ["discover", "qualify", "collect", "extract", "corroboration", "countersearch", "synthesis", "review", "humanapprove", "publish"]);
  assert.equal(workflow.stages[0].role, "knowledge_source_researcher");
  assert.equal(workflow.stages[3].role, "knowledge_claim_extractor");
  assert.equal(workflow.stages[6].role, "knowledge_principle_synthesizer");
  assert.equal(workflow.stages[7].role, "knowledge_principle_reviewer");
  assert.equal(workflow.stages[8].role, "human_approver");
  for (const relativePath of [
    ".codex/agents/knowledge_source_researcher.toml",
    ".codex/agents/knowledge_claim_extractor.toml",
    ".codex/agents/knowledge_principle_synthesizer.toml",
    ".codex/agents/knowledge_principle_reviewer.toml",
    ".codex/scripts/harness-knowledge.mjs",
    ".codex/skills/knowledge-harvest/SKILL.md",
    ".codex/schemas/knowledge/principle.schema.yaml",
  ]) await readFile(join(ROOT, relativePath), "utf8");

  const sourceProfile = await readFile(join(ROOT, ".codex", "agents", "knowledge_source_researcher.toml"), "utf8");
  assert.match(sourceProfile, /discover and classify/i);
  assert.match(sourceProfile, /Do not synthesize a Principle or conclusion/);
  const reviewerProfile = await readFile(join(ROOT, ".codex", "agents", "knowledge_principle_reviewer.toml"), "utf8");
  assert.match(reviewerProfile, /recordMaterialApproval/);
  assert.match(reviewerProfile, /Principle approval never substitutes for material-use approval/);
  const loadedWorkflow = await loadNamedWorkflow("knowledge-harvest-workflow", { root: ROOT });
  assert.deepEqual(loadedWorkflow.stages.map(({ id }) => id), ["discover", "qualify", "collect", "extract", "corroboration", "countersearch", "synthesis", "review", "humanapprove", "publish"]);
});

test("official recorded source supports offline Source and Claim provenance without claiming live access", async () => {
  const recordingPath = join(ROOT, "tests", "fixtures", "knowledge-harvest", "rfc9110-200-ok.json");
  const recording = JSON.parse(await readFile(recordingPath, "utf8"));
  assert.equal(recording.live_access_attempted, false);
  assert.match(recording.live_access_limitation, /does not test network reachability/);
  assert.equal(recording.source.uri, "https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.1");
  assert.equal(createHash("sha256").update(recording.recorded_excerpt).digest("hex"), recording.source.content_sha256);
  assert.equal(validateSource(recording.source).valid, true);
  assert.equal(validateClaim(recording.claim, { sourceIds: [recording.source.id] }).valid, true);
});
