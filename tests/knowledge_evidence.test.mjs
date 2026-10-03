import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EVIDENCE_TYPES } from "../src/knowledge/model.mjs";
import { normalizeEvidence, stageEvidenceSummary } from "../src/knowledge/evidence.mjs";
import { computeEvidenceApprovalHash, validateEvidence } from "../src/knowledge/validation.mjs";
import { readEvidence, writeEvidence } from "../src/knowledge/registry.mjs";
import { parseYaml } from "../src/eval/yaml.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = join(ROOT, ".codex", "scripts", "harness-knowledge.mjs");

function cli(root, args) {
  return spawnSync(process.execPath, [SCRIPT, "evidence", ...args, "--root", root], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

const evidence = (overrides = {}) => ({
  schema_version: 1,
  id: "loadtest-2026-09-30",
  origin_project: "harness-codex",
  environment: { region: "local", runtime: "node 22", dataset: "synthetic" },
  timestamp: "2026-09-30T12:00:00Z",
  type: "loadtest",
  execution_status: "completed",
  measurement_validity: "valid",
  observations: [{ metric: "requests_per_second", value: 240, unit: "request/s" }],
  source_reference: "run-2026-09-30-a",
  decision_ids: ["decision-api-capacity"],
  summary: "Synthetic load test completed at 240 requests per second.",
  ...overrides,
});

test("Evidence stays local until its presented summary is explicitly approved and published", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-evidence-cli-"));
  try {
    const imported = cli(root, ["import", "--json", JSON.stringify(evidence())]);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(JSON.parse(imported.stdout).status, "pending_approval");

    const stagedPath = join(root, "docs", "specs", ".runtime", "506-06-local-evidence", "evidence", "loadtest-2026-09-30.yaml");
    const stagedText = await readFile(stagedPath, "utf8");
    assert.match(stagedText, /pending_approval/);
    assert.doesNotMatch(stagedText, /summary_sha256/);
    await assert.rejects(() => readdir(join(root, "knowledge", "evidence")), { code: "ENOENT" });

    const approved = cli(root, ["approve", "--id", "loadtest-2026-09-30", "--actor", "jiwoo", "--actor-role", "user"]);
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(JSON.parse(approved.stdout).approval.summary_sha256, /^[a-f0-9]{64}$/);

    const published = cli(root, ["publish", "--id", "loadtest-2026-09-30"]);
    assert.equal(published.status, 0, published.stderr);
    assert.equal(JSON.parse(published.stdout).evidence.summary, evidence().summary);
    assert.match(await readFile(join(root, "knowledge", "evidence", "loadtest-2026-09-30.yaml"), "utf8"), /summary_sha256/);
    const shown = cli(root, ["show", "--id", "loadtest-2026-09-30"]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).approval.actor, "jiwoo");
    const repeatedPublish = cli(root, ["publish", "--id", "loadtest-2026-09-30"]);
    assert.equal(repeatedPublish.status, 0, repeatedPublish.stderr);
    assert.equal(JSON.parse(repeatedPublish.stdout).idempotent, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Evidence import filters raw output and secrets, and failed measurements are invalid", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-evidence-safe-import-"));
  try {
    const failed = evidence({
      id: "failure-test-2026-09-30",
      type: "failure_test",
      execution_status: "interrupted",
      measurement_validity: "valid",
      stdout: "RAW STDOUT must not be stored",
      api_key: "sk-super-secret",
      journal: "docs/plans/.runtime/plan/events.jsonl",
    });
    const imported = cli(root, ["import", "--json", JSON.stringify(failed)]);
    assert.equal(imported.status, 0, imported.stderr);
    const candidate = JSON.parse(imported.stdout).evidence;
    assert.equal(candidate.measurement_validity, "invalid");
    assert.equal("stdout" in candidate, false);
    assert.equal("api_key" in candidate, false);
    assert.equal("journal" in candidate, false);
    const stored = await readFile(join(root, "docs", "specs", ".runtime", "506-06-local-evidence", "evidence", "failure-test-2026-09-30.yaml"), "utf8");
    assert.doesNotMatch(stored, /RAW STDOUT|super-secret|events\.jsonl/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Evidence rejects sensitive values embedded in summary or provenance before staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-evidence-secret-values-"));
  try {
    for (const overrides of [
      { summary: "Load test completed; api_key=sk-secret-value" },
      { source_reference: "Bearer super-secret-token" },
      { environment: { dataset: "docs/plans/.runtime/506/checkpoint.md" } },
    ]) {
      const result = cli(root, ["import", "--json", JSON.stringify(evidence(overrides))]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /sensitive|raw runtime/i);
    }
    assert.deepEqual(await readdir(join(root, "docs", "specs", ".runtime", "506-06-local-evidence", "evidence")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed atomic staging replacement preserves the prior candidate and can be retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-evidence-atomic-retry-"));
  const originalNow = Date.now;
  const fixedTime = 1730000000000;
  try {
    const imported = cli(root, ["import", "--json", JSON.stringify(evidence())]);
    assert.equal(imported.status, 0, imported.stderr);
    const candidatePath = join(root, "docs", "specs", ".runtime", "506-06-local-evidence", "evidence", `${evidence().id}.yaml`);
    const before = await readFile(candidatePath, "utf8");
    const temporaryPath = `${candidatePath}.tmp-${process.pid}-${fixedTime}`;
    await writeFile(temporaryPath, "occupied");
    Date.now = () => fixedTime;
    await assert.rejects(() => stageEvidenceSummary({ root, evidenceId: evidence().id, summary: "Revised normalized summary.", at: "2026-09-30T13:00:00Z" }), { code: "EEXIST" });
    assert.equal(await readFile(candidatePath, "utf8"), before);

    Date.now = originalNow;
    await rm(temporaryPath);
    const retried = await stageEvidenceSummary({ root, evidenceId: evidence().id, summary: "Revised normalized summary.", at: "2026-09-30T13:00:00Z" });
    assert.equal(retried.summary, "Revised normalized summary.");
  } finally {
    Date.now = originalNow;
    await rm(root, { recursive: true, force: true });
  }
});

test("Evidence rejection is resumable and approval cannot survive a changed summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-evidence-resume-"));
  try {
    const imported = cli(root, ["import", "--json", JSON.stringify(evidence())]);
    assert.equal(imported.status, 0, imported.stderr);
    const rejected = cli(root, ["reject", "--id", evidence().id, "--actor", "jiwoo", "--reason", "Remove an unsupported conclusion."]);
    assert.equal(rejected.status, 0, rejected.stderr);
    assert.equal(JSON.parse(rejected.stdout).status, "rejected");

    const resumed = cli(root, ["stage", "--id", evidence().id, "--json", JSON.stringify({ summary: "Measured 240 requests per second in a synthetic environment." })]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).status, "pending_approval");
    const approved = cli(root, ["approve", "--id", evidence().id, "--actor", "jiwoo", "--actor-role", "user"]);
    assert.equal(approved.status, 0, approved.stderr);

    const changed = cli(root, ["stage", "--id", evidence().id, "--json", JSON.stringify({ summary: "Changed after approval." })]);
    assert.equal(changed.status, 0, changed.stderr);
    const publish = cli(root, ["publish", "--id", evidence().id]);
    assert.notEqual(publish.status, 0);
    assert.match(publish.stderr, /approval|approved/i);
    await assert.rejects(() => readFile(join(root, "knowledge", "evidence", `${evidence().id}.yaml`)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Evidence schema and validator preserve the supported provenance contract", async () => {
  const schema = parseYaml(await readFile(join(ROOT, ".codex", "schemas", "knowledge", "evidence.schema.yaml"), "utf8"));
  assert.equal(schema.id, "knowledge-evidence");
  assert.equal(schema.additional_properties, false);
  assert.deepEqual(schema.properties.type.enum, EVIDENCE_TYPES);
  assert.deepEqual(schema.required, ["schema_version", "id", "origin_project", "environment", "timestamp", "type", "execution_status", "measurement_validity", "observations", "source_reference", "decision_ids", "summary", "approval"]);
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "docs/specs/.runtime/506-06-local-evidence/evidence/candidate.yaml"], { cwd: ROOT });
  assert.equal(ignored.status, 0, "local Evidence staging must be ignored even though durable docs/specs files are tracked");

  const normalized = normalizeEvidence(evidence({ type: "production_metric", api_key: "discarded secret" }));
  assert.equal(normalized.type, "production_metric");
  assert.equal("api_key" in normalized, false);
  assert.equal(validateEvidence({ ...normalized, summary: evidence().summary }).valid, true);
  const invalid = validateEvidence({ ...normalized, summary: evidence().summary, measurement_validity: "valid", execution_status: "failed" });
  assert.ok(invalid.errors.some(({ code }) => code === "failed_run_valid_measurement"));
});

test("durable Evidence uses the project registry and de-duplicates the same origin/run/type identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-evidence-registry-"));
  try {
    const candidate = normalizeEvidence(evidence());
    await assert.rejects(() => writeEvidence({ root, evidence: { ...candidate, summary: evidence().summary } }), /human approval/i);
    const approved = { ...candidate, summary: evidence().summary };
    approved.approval = { actor_type: "human", actor: "jiwoo", approved_at: "2026-09-30T12:30:00Z", summary_sha256: computeEvidenceApprovalHash(approved) };
    const saved = await writeEvidence({ root, evidence: approved });
    assert.equal(saved.path, join(root, "knowledge", "evidence", `${candidate.id}.yaml`));
    assert.deepEqual(await readEvidence({ root, evidenceId: candidate.id }), approved);

    const sameRunDifferentId = { ...approved, id: "same-run-other-id" };
    sameRunDifferentId.approval = { ...approved.approval, summary_sha256: computeEvidenceApprovalHash(sameRunDifferentId) };
    const duplicate = await writeEvidence({ root, evidence: { ...sameRunDifferentId, summary: evidence().summary } });
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.path, saved.path);

    const conflicting = { ...sameRunDifferentId, observations: [{ metric: "requests_per_second", value: 241, unit: "request/s" }], summary: "Conflicting run content." };
    conflicting.approval = { ...approved.approval, summary_sha256: computeEvidenceApprovalHash(conflicting) };
    await assert.rejects(() => writeEvidence({ root, evidence: conflicting }), /same origin\/run\/type identity/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staging path rejects symlinks, preserves the failed candidate boundary, then allows retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-evidence-path-"));
  const outside = await mkdtemp(join(tmpdir(), "knowledge-evidence-outside-"));
  const stageParent = join(root, "docs", "specs", ".runtime", "506-06-local-evidence");
  try {
    await mkdir(join(root, "docs", "specs", ".runtime"), { recursive: true });
    await symlink(outside, stageParent);
    const failed = cli(root, ["import", "--json", JSON.stringify(evidence())]);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /symlink/i);
    assert.deepEqual(await readdir(outside), []);

    await rm(stageParent);
    const retried = cli(root, ["import", "--json", JSON.stringify(evidence())]);
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(JSON.parse(retried.stdout).status, "pending_approval");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("durable Evidence registry refuses a symlink escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-evidence-durable-path-"));
  const outside = await mkdtemp(join(tmpdir(), "knowledge-evidence-durable-outside-"));
  try {
    await mkdir(join(root, "knowledge"), { recursive: true });
    await symlink(outside, join(root, "knowledge", "evidence"));
    const candidate = normalizeEvidence(evidence());
    const approved = { ...candidate, summary: evidence().summary };
    approved.approval = { actor_type: "human", actor: "jiwoo", approved_at: "2026-09-30T12:30:00Z", summary_sha256: computeEvidenceApprovalHash(approved) };
    await assert.rejects(() => writeEvidence({ root, evidence: approved }), /symlink/i);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
