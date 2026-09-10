import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  WorkflowManifestError,
  loadNamedWorkflow,
  loadWorkflowFile,
  loadWorkflowText,
} from "../src/workflow/index.mjs";

const VALID_WORKFLOW = `
schema_version: 1
id: spec-me
roles: [code_researcher, spec_document_writer]
skills: [product-spec, architecture-spec]
hooks:
  before_dispatch: [dependency, resource_conflict, workspace, permission_preflight]
  before_handoff: [checkpoint_completeness, evidence_flush]
  before_complete: [required_outcome, tests, review, evidence]
  after_merge: [tracker_reconciliation]
stages:
  - id: product
    role: code_researcher
    skill: product-spec
    needs: []
  - id: architecture
    role: spec_document_writer
    skill: architecture-spec
    needs: [product]
`;
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), "harness-workflow-"));
  await mkdir(join(root, ".codex", "workflows"), { recursive: true });
  await mkdir(join(root, ".codex", "agents"), { recursive: true });
  await mkdir(join(root, ".agents", "skills", "product-spec"), { recursive: true });
  await mkdir(join(root, ".agents", "skills", "architecture-spec"), { recursive: true });
  await writeFile(join(root, ".codex", "agents", "code_researcher.toml"), "name = 'code_researcher'\n", "utf8");
  await writeFile(join(root, ".codex", "agents", "spec_document_writer.toml"), "name = 'spec_document_writer'\n", "utf8");
  await writeFile(join(root, ".agents", "skills", "product-spec", "SKILL.md"), "# product-spec\n", "utf8");
  await writeFile(join(root, ".agents", "skills", "architecture-spec", "SKILL.md"), "# architecture-spec\n", "utf8");
  return root;
}

test("workflow loader normalizes role, skill, hook, and dependency contracts", async () => {
  const workflow = loadWorkflowText(VALID_WORKFLOW);

  assert.equal(workflow.schema_version, 1);
  assert.equal(workflow.id, "spec-me");
  assert.deepEqual(workflow.roles, ["code_researcher", "spec_document_writer"]);
  assert.deepEqual(workflow.skills, ["product-spec", "architecture-spec"]);
  assert.deepEqual(workflow.hooks.after_merge, ["tracker_reconciliation"]);
  assert.deepEqual(workflow.stages.map((stage) => stage.id), ["product", "architecture"]);
  assert.deepEqual(workflow.stages[1].needs, ["product"]);
});

test("workflow file preflight verifies physical role and skill references", async () => {
  const root = await makeProject();
  await writeFile(join(root, ".codex", "workflows", "spec-me.yaml"), VALID_WORKFLOW, "utf8");

  const workflow = await loadNamedWorkflow("spec-me", { root });

  assert.equal(workflow.references.roles.code_researcher, join(root, ".codex", "agents", "code_researcher.toml"));
  assert.equal(workflow.references.skills["product-spec"], join(root, ".agents", "skills", "product-spec", "SKILL.md"));
});

test("the checked-in code-review workflow resolves project-local roles and legacy source skills", async () => {
  const workflow = await loadNamedWorkflow("code-review", { root: REPOSITORY_ROOT });

  assert.equal(workflow.id, "code-review");
  assert.deepEqual(workflow.stages.map((stage) => stage.role), ["standards_reviewer", "spec_reviewer"]);
  assert.match(workflow.references.skills["code-review"], /\.codex[\\/]skills[\\/]code-review[\\/]SKILL\.md$/);
});

test("workflow loader rejects duplicate, unknown, and cyclic stages", () => {
  const duplicate = VALID_WORKFLOW.replace("  - id: architecture", "  - id: product\n    role: spec_document_writer\n    skill: architecture-spec\n    needs: [product]\n  - id: architecture");
  assert.throws(() => loadWorkflowText(duplicate), WorkflowManifestError);

  const unknown = VALID_WORKFLOW.replace("needs: [product]", "needs: [missing]");
  assert.throws(() => loadWorkflowText(unknown), /Unknown stage dependency/);

  const cyclic = VALID_WORKFLOW.replace("needs: []", "needs: [architecture]");
  assert.throws(() => loadWorkflowText(cyclic), /cyclic stage dependency/);
});

test("workflow loader requires all fixed lifecycle hooks and registered check IDs", () => {
  const missingHook = VALID_WORKFLOW.replace("  after_merge: [tracker_reconciliation]\n", "");
  assert.throws(() => loadWorkflowText(missingHook), /all supported lifecycle hooks/);

  const unknownCheck = VALID_WORKFLOW.replace("after_merge: [tracker_reconciliation]", "after_merge: [unknown_check]");
  assert.throws(() => loadWorkflowText(unknownCheck), /Unknown lifecycle check/);

  const wrongMapping = VALID_WORKFLOW.replace("after_merge: [tracker_reconciliation]", "after_merge: [dependency]");
  assert.throws(() => loadWorkflowText(wrongMapping), /must include default check/);
});

test("workflow file rejects missing references and path escapes", async () => {
  const root = await makeProject();
  const missingRole = VALID_WORKFLOW.replaceAll("code_researcher", "missing_role");
  await writeFile(join(root, ".codex", "workflows", "missing.yaml"), missingRole, "utf8");
  await assert.rejects(() => loadNamedWorkflow("missing", { root }), /Missing role profile/);

  await assert.rejects(() => loadWorkflowFile(join(root, "..", "outside.yaml"), { root }), WorkflowManifestError);
  await assert.rejects(() => loadNamedWorkflow("../outside", { root }), WorkflowManifestError);
  await assert.rejects(() => loadNamedWorkflow("code-review", { root, workflowDir: "workflows" }), /Canonical workflow directory/);
});

test("workflow reference preflight rejects symlinks that resolve outside the repository", async () => {
  const root = await makeProject();
  const outside = await mkdtemp(join(tmpdir(), "harness-workflow-outside-"));
  await writeFile(join(outside, "external.toml"), "name = 'external'\n", "utf8");
  await symlink(join(outside, "external.toml"), join(root, ".codex", "agents", "external.toml"));
  const escaped = VALID_WORKFLOW.replaceAll("code_researcher", "external");
  await writeFile(join(root, ".codex", "workflows", "escaped.yaml"), escaped, "utf8");

  await assert.rejects(() => loadNamedWorkflow("escaped", { root }), /escapes repository root/);
});
