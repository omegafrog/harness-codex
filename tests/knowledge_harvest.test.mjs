import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createClaim, createSource, SOURCE_TIERS } from "../src/knowledge/model.mjs";
import { validateClaim, validateSource } from "../src/knowledge/validation.mjs";
import { readClaim, readSource, writeClaim, writeSource } from "../src/knowledge/registry.mjs";
import { evaluateSource, groupIndependentAuthorities, rankSourceTiers } from "../src/knowledge/research.mjs";
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

test("source and claim schemas are closed version-one YAML contracts", async () => {
  const sourceSchemaPath = fileURLToPath(new URL("../.codex/schemas/knowledge/source.schema.yaml", import.meta.url));
  const claimSchemaPath = fileURLToPath(new URL("../.codex/schemas/knowledge/claim.schema.yaml", import.meta.url));
  const sourceSchema = parseYaml(await readFile(sourceSchemaPath, "utf8"));
  const claimSchema = parseYaml(await readFile(claimSchemaPath, "utf8"));
  assert.equal(sourceSchema.id, "knowledge-source");
  assert.equal(sourceSchema.additional_properties, false);
  assert.deepEqual(sourceSchema.properties.tier.enum, SOURCE_TIERS);
  assert.equal(claimSchema.id, "knowledge-claim");
  assert.equal(claimSchema.additional_properties, false);
  assert.deepEqual(claimSchema.required, ["schema_version", "id", "source_id", "statement", "locator", "retrieved_at", "context", "qualifiers"]);
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

test("knowledge harvest workflow, profiles, skill, and installer assets agree", async () => {
  const workflow = parseYaml(await readFile(join(ROOT, ".codex", "workflows", "knowledge-harvest-workflow.yaml"), "utf8"));
  assert.deepEqual(workflow.stages.map(({ id }) => id), ["discover", "qualify", "collect", "extract"]);
  assert.equal(workflow.stages[0].role, "knowledge_source_researcher");
  assert.equal(workflow.stages[3].role, "knowledge_claim_extractor");
  for (const relativePath of [
    ".codex/agents/knowledge_source_researcher.toml",
    ".codex/agents/knowledge_claim_extractor.toml",
    ".codex/scripts/harness-knowledge.mjs",
    ".codex/skills/knowledge-harvest/SKILL.md",
  ]) await readFile(join(ROOT, relativePath), "utf8");

  const sourceProfile = await readFile(join(ROOT, ".codex", "agents", "knowledge_source_researcher.toml"), "utf8");
  assert.match(sourceProfile, /discover and classify/i);
  assert.match(sourceProfile, /Do not synthesize a Principle or conclusion/);
  const loadedWorkflow = await loadNamedWorkflow("knowledge-harvest-workflow", { root: ROOT });
  assert.deepEqual(loadedWorkflow.stages.map(({ id }) => id), ["discover", "qualify", "collect", "extract"]);
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
