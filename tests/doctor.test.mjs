import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { runDoctor } from "../src/doctor/index.mjs";
import { HarnessLockError, classifyLockEntries, hashFile, validateHarnessLock } from "../src/installer/lock.mjs";

const HOOKS = `
hooks:
  before_dispatch: [dependency, resource_conflict, workspace, permission_preflight]
  before_handoff: [checkpoint_completeness, evidence_flush]
  before_complete: [required_outcome, tests, review, evidence]
  after_merge: [tracker_reconciliation]
`;

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), "harness-doctor-"));
  await mkdir(join(root, ".codex", "workflows"), { recursive: true });
  await mkdir(join(root, ".codex", "agents"), { recursive: true });
  await mkdir(join(root, ".agents", "skills", "review"), { recursive: true });
  await writeFile(join(root, ".codex", "agents", "reviewer.toml"), "name = 'reviewer'\n", "utf8");
  await writeFile(join(root, ".agents", "skills", "review", "SKILL.md"), "# review\n", "utf8");
  await writeFile(join(root, ".codex", "harness.yaml"), `
tracker:
  mode: local-markdown
eval:
  environment_profiles:
    default:
      permission_profile: eval-workspace
      sandbox: workspace-write
      network: restricted
`, "utf8");
  await writeFile(join(root, ".codex", "workflows", "review.yaml"), `
schema_version: 1
id: review
roles: [reviewer]
skills: [review]
${HOOKS}
stages:
  - id: review
    role: reviewer
    skill: review
    needs: []
`, "utf8");
  return root;
}

test("doctor passes a valid workflow and reports structured diagnostics", async () => {
  const root = await makeProject();
  const report = await runDoctor({ root, lockPath: null, nativePermissionProfiles: ["eval-workspace"] });

  assert.equal(report.passed, true);
  assert.deepEqual(report.summary, { errors: 0, warnings: 0, info: 0 });
  assert.deepEqual(report.diagnostics, []);
});

test("doctor reports broken references, stale legacy skills, and permission conflicts", async () => {
  const root = await makeProject();
  await writeFile(join(root, ".codex", "workflows", "broken.yaml"), `
schema_version: 1
id: broken
roles: [missing_role]
skills: [review]
${HOOKS}
stages:
  - id: broken
    role: missing_role
    skill: review
    needs: []
`, "utf8");
  await writeFile(join(root, ".codex", "harness.yaml"), `
tracker:
  mode: local-markdown
eval:
  environment_profiles:
    restricted:
      permission_profile: shared
      sandbox: workspace-write
      network: restricted
    allowed:
      permission_profile: shared
      sandbox: workspace-write
      network: allowed
`, "utf8");
  const report = await runDoctor({ root, lockPath: null });
  const codes = report.diagnostics.map((diagnostic) => diagnostic.code);

  assert.equal(report.passed, false);
  assert.ok(codes.includes("broken_reference"));
  assert.ok(codes.includes("permission_conflict"));
  assert.ok(report.diagnostics.every((diagnostic) => diagnostic.path));
});

test("doctor verifies agent permission references against supplied native profiles", async () => {
  const root = await makeProject();
  await writeFile(join(root, ".codex", "agents", "reviewer.toml"), "permission_profile = 'missing-native'\n", "utf8");

  const report = await runDoctor({ root, lockPath: null, nativePermissionProfiles: ["eval-workspace"] });

  assert.equal(report.passed, false);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === "permission_profile_stale" && diagnostic.permission_profile === "missing-native"));
});

test("doctor rejects workflow files that resolve through a symlink outside the repository", async () => {
  const root = await makeProject();
  const outside = await mkdtemp(join(tmpdir(), "harness-doctor-workflow-outside-"));
  const outsideWorkflow = join(outside, "escaped.yaml");
  await writeFile(outsideWorkflow, `
schema_version: 1
id: escaped
roles: [reviewer]
skills: [review]
${HOOKS}
stages:
  - id: review
    role: reviewer
    skill: review
    needs: []
`, "utf8");
  await symlink(outsideWorkflow, join(root, ".codex", "workflows", "escaped.yaml"));

  const report = await runDoctor({ root, lockPath: null, nativePermissionProfiles: ["eval-workspace"] });

  assert.equal(report.passed, false);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.path.endsWith("escaped.yaml") && diagnostic.code === "workflow_schema"));
});

test("doctor rejects a harness lock reached through an outside parent symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-doctor-lock-root-"));
  const outside = await mkdtemp(join(tmpdir(), "harness-doctor-lock-outside-"));
  const hash = "d".repeat(64);
  await writeFile(join(outside, "harness-lock.json"), JSON.stringify({ schema_version: 1, files: { "outside.txt": { installed_sha256: hash, upstream_sha256: hash } } }), "utf8");
  await symlink(outside, join(root, ".codex"));

  const report = await runDoctor({ root, nativePermissionProfiles: [] });

  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === "installer_lock_invalid" && diagnostic.message.includes("outside repository root")));
});

test("doctor rejects a dangling harness lock symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-doctor-dangling-lock-"));
  await mkdir(join(root, ".codex"), { recursive: true });
  await symlink("missing-lock.json", join(root, ".codex", "harness-lock.json"));

  const report = await runDoctor({ root, nativePermissionProfiles: [] });

  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.code === "installer_lock_invalid"), true);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.code === "installer_lock_missing"), false);
});

test("doctor rejects dangling canonical owned directories", async () => {
  const root = await makeProject();
  await symlink("missing-schemas", join(root, ".codex", "schemas"));

  const report = await runDoctor({ root, lockPath: null, nativePermissionProfiles: ["eval-workspace"] });

  assert.equal(report.passed, false);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === "installer_path_invalid"));
});

test("doctor reports symlinked harness-owned files even when lock checks are disabled", async () => {
  const root = await makeProject();
  const outside = await mkdtemp(join(tmpdir(), "harness-doctor-agent-outside-"));
  const outsideAgent = join(outside, "agent.toml");
  await writeFile(outsideAgent, "permission_profile = 'eval-workspace'\n", "utf8");
  await symlink(outsideAgent, join(root, ".codex", "agents", "escaped.toml"));

  const report = await runDoctor({ root, lockPath: null, nativePermissionProfiles: ["eval-workspace"] });

  assert.equal(report.passed, false);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === "installer_path_invalid"));
});

test("doctor blocks an incomplete implementation PR authoring template", async () => {
  const root = await makeProject();
  await mkdir(join(root, ".github"), { recursive: true });
  await writeFile(join(root, ".github", "pull_request_template.md"), "## Summary\n", "utf8");

  const report = await runDoctor({ root, lockPath: null, nativePermissionProfiles: ["eval-workspace"] });
  const codes = report.diagnostics.map((diagnostic) => diagnostic.code);

  assert.equal(report.passed, false);
  assert.ok(codes.includes("authoring_managed_section"));
  assert.ok(codes.includes("authoring_closing_refs"));
  assert.ok(codes.includes("authoring_single_pr_invariant"));
});

test("doctor rejects duplicate or out-of-scope canonical PR sections", async () => {
  const root = await makeProject();
  await mkdir(join(root, ".github"), { recursive: true });
  await writeFile(join(root, ".github", "pull_request_template.md"), [
    "## Summary",
    "<!-- harness:managed:implementation-pr:start -->",
    "## Summary",
    "<!-- harness:managed:implementation-pr:end -->",
    "<!-- harness:managed:implementation-pr:start -->",
    "## Plan Set",
    "<!-- harness:managed:implementation-pr:end -->",
  ].join("\n"), "utf8");

  const report = await runDoctor({ root, lockPath: null, nativePermissionProfiles: ["eval-workspace"] });
  assert.equal(report.passed, false);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === "authoring_managed_section"));
});

test("doctor rejects duplicate canonical headings inside the managed PR section", async () => {
  const root = await makeProject();
  await mkdir(join(root, ".github"), { recursive: true });
  const template = await readFile(join(process.cwd(), ".github", "pull_request_template.md"), "utf8");
  const duplicate = template.replace("## Plan Set\n", "## Plan Set\n\n## Summary\n");
  await writeFile(join(root, ".github", "pull_request_template.md"), duplicate, "utf8");

  const report = await runDoctor({ root, lockPath: null, nativePermissionProfiles: ["eval-workspace"] });

  assert.equal(report.passed, false);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === "authoring_managed_section" && diagnostic.duplicate_sections?.includes("Summary")));
});

test("doctor rejects canonical PR headings outside the managed section", async () => {
  const root = await makeProject();
  await mkdir(join(root, ".github"), { recursive: true });
  const template = await readFile(join(process.cwd(), ".github", "pull_request_template.md"), "utf8");
  await writeFile(join(root, ".github", "pull_request_template.md"), `## Summary\n\n${template}`, "utf8");

  const report = await runDoctor({ root, lockPath: null, nativePermissionProfiles: ["eval-workspace"] });

  assert.equal(report.passed, false);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === "authoring_managed_section" && diagnostic.outside_sections?.includes("Summary")));
});

test("lock classification distinguishes unchanged, upstream, local, and conflict states", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-lock-"));
  const unchanged = join(root, "unchanged.txt");
  const upstream = join(root, "upstream.txt");
  const local = join(root, "local.txt");
  const conflict = join(root, "conflict.txt");
  await Promise.all([
    writeFile(unchanged, "same", "utf8"),
    writeFile(upstream, "old", "utf8"),
    writeFile(local, "local", "utf8"),
    writeFile(conflict, "conflict", "utf8"),
  ]);
  const oldHash = "0".repeat(64);
  const upstreamHash = "1".repeat(64);
  const current = {
    unchanged: await hashFile(unchanged),
    upstream: await hashFile(upstream),
    local: await hashFile(local),
    conflict: await hashFile(conflict),
  };
  const entries = await classifyLockEntries({
    root,
    lock: {
      schema_version: 1,
      files: {
        "unchanged.txt": { installed_sha256: current.unchanged, upstream_sha256: current.unchanged },
        "upstream.txt": { installed_sha256: current.upstream, upstream_sha256: upstreamHash },
        "local.txt": { installed_sha256: oldHash, upstream_sha256: oldHash },
        "conflict.txt": { installed_sha256: oldHash, upstream_sha256: upstreamHash },
      },
    },
  });

  assert.deepEqual(Object.fromEntries(entries.map((entry) => [entry.path, entry.status])), {
    "unchanged.txt": "unchanged",
    "upstream.txt": "upstream_updated",
    "local.txt": "locally_modified",
    "conflict.txt": "conflict",
  });
});

test("missing locked files use a distinct status", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-lock-missing-"));
  const hash = "c".repeat(64);

  const entries = await classifyLockEntries({
    root,
    lock: { schema_version: 1, files: { "missing.txt": { installed_sha256: hash, upstream_sha256: hash } } },
  });

  assert.equal(entries[0].status, "missing");
});

test("lock classification preserves missing upstream source evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-lock-source-root-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "harness-lock-source-"));
  const target = join(root, "agent.toml");
  await writeFile(target, "same", "utf8");
  const hash = await hashFile(target);

  const entries = await classifyLockEntries({
    root,
    sourceRoot,
    lock: {
      schema_version: 1,
      files: { "agent.toml": { installed_sha256: hash, upstream_sha256: hash, source_path: "agent.toml" } },
    },
  });

  assert.equal(entries[0].source_missing, true);
  assert.equal(entries[0].status, "unchanged");
});

test("lock validation rejects duplicate canonical paths", () => {
  const hash = "a".repeat(64);

  assert.throws(() => validateHarnessLock({
    schema_version: 1,
    files: {
      "foo/bar": { installed_sha256: hash, upstream_sha256: hash },
      "foo\\bar": { installed_sha256: hash, upstream_sha256: hash },
    },
  }), HarnessLockError);
});

test("lock classification rejects symlinks that resolve outside the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-lock-root-"));
  const outside = await mkdtemp(join(tmpdir(), "harness-lock-outside-"));
  const outsideFile = join(outside, "secret.txt");
  await writeFile(outsideFile, "outside", "utf8");
  await symlink(outsideFile, join(root, "linked.txt"));
  const hash = "b".repeat(64);

  await assert.rejects(() => classifyLockEntries({
    root,
    lock: { schema_version: 1, files: { "linked.txt": { installed_sha256: hash, upstream_sha256: hash } } },
  }), HarnessLockError);
});
