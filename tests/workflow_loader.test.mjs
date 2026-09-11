import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  before_complete: []
  after_merge: []
stages:
  - id: product
    role: code_researcher
    skill: product-spec
    needs: []
    gates: [product_coverage, material_ambiguity_resolved]
  - id: architecture
    role: spec_document_writer
    skill: architecture-spec
    needs: [product]
    condition: architecture_diagram_required
    gates: [architecture_coverage]
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
  assert.deepEqual(workflow.hooks.after_merge, []);
  assert.deepEqual(workflow.stages.map((stage) => stage.id), ["product", "architecture"]);
  assert.deepEqual(workflow.stages[1].needs, ["product"]);
  assert.deepEqual(workflow.stages[0].gates, ["product_coverage", "material_ambiguity_resolved"]);
  assert.equal(workflow.stages[1].condition, "architecture_diagram_required");
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

  const unknownGate = VALID_WORKFLOW.replace("gates: [product_coverage, material_ambiguity_resolved]", "gates: [typo_gate]");
  assert.throws(() => loadWorkflowText(unknownGate), /Unknown stage gate/);

  const unknownCondition = VALID_WORKFLOW.replace("condition: architecture_diagram_required", "condition: typo_condition");
  assert.throws(() => loadWorkflowText(unknownCondition), /Unknown stage condition/);
});

test("workflow loader accepts workflow-specific hooks and registered check IDs", () => {
  const workflow = loadWorkflowText(VALID_WORKFLOW);
  assert.deepEqual(workflow.hooks.before_complete, []);
  assert.deepEqual(workflow.hooks.after_merge, []);

  const unknownCheck = VALID_WORKFLOW.replace("after_merge: [tracker_reconciliation]", "after_merge: [unknown_check]");
  assert.throws(() => loadWorkflowText(unknownCheck.replace("after_merge: []", "after_merge: [unknown_check]")), /Unknown lifecycle check/);

  const workflowSpecific = VALID_WORKFLOW.replace("before_complete: []", "before_complete: [required_outcome]");
  assert.deepEqual(loadWorkflowText(workflowSpecific).hooks.before_complete, ["required_outcome"]);

  const routingField = VALID_WORKFLOW.replace("id: spec-me", "id: spec-me\nrouting: automatic");
  assert.throws(() => loadWorkflowText(routingField), /routing is not supported/);
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

test("canonical workflow preflight rejects a symlink to another in-repository directory", async () => {
  const root = await makeProject();
  const outsideDirectory = join(root, "other-workflows");
  await mkdir(outsideDirectory, { recursive: true });
  await writeFile(join(outsideDirectory, "review.yaml"), VALID_WORKFLOW.replace("id: spec-me", "id: review"), "utf8");
  await symlink(join(outsideDirectory, "review.yaml"), join(root, ".codex", "workflows", "review.yaml"));

  await assert.rejects(() => loadNamedWorkflow("review", { root }), /resolves outside/);
});

test("canonical workflow preflight rejects a symlinked workflow directory", async () => {
  const root = await makeProject();
  const realDirectory = join(root, "other-workflows");
  await mkdir(realDirectory, { recursive: true });
  await writeFile(join(realDirectory, "review.yaml"), VALID_WORKFLOW.replace("id: spec-me", "id: review"), "utf8");
  await rm(join(root, ".codex", "workflows"), { recursive: true });
  await symlink(realDirectory, join(root, ".codex", "workflows"));

  await assert.rejects(() => loadNamedWorkflow("review", { root }), /cannot be a symlink/);
});
