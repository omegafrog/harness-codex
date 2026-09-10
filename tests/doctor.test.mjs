import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { runDoctor } from "../src/doctor/index.mjs";
import { classifyLockEntries, hashFile } from "../src/installer/lock.mjs";

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
  const report = await runDoctor({ root, lockPath: null });

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
