import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createReviewSession,
  recordMaterialApproval,
  canReviewerUseMaterial,
  transitionReviewMode,
  appendReviewHistory,
  resumeReviewSession,
} from "../src/decision/review.mjs";
import { evaluateStageCondition, evaluateWorkflowCondition } from "../src/workflow/stage-gates.mjs";
import { loadNamedWorkflow } from "../src/workflow/loader.mjs";
import { validateReviewRecord } from "../src/decision/validation.mjs";
import { parseYaml } from "../src/eval/yaml.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const material = {
  id: "new-material",
  source_ids: ["source-1"],
  claim_ids: ["claim-1"],
  context: "The claim applies to burst traffic after warm-up.",
  provenance: "User supplied from the cited performance report, section 4.",
};
const user = { role: "user", id: "human-1" };

 test("Learning is the default; explicit Normal selection is preserved as the initial mode", () => {
  assert.equal(createReviewSession({ session_id: "review-1" }).mode, "Learning");
  const normal = createReviewSession({ session_id: "review-2", mode: "Normal", actor: user, at: "2026-01-02T03:04:05.000Z" });
  assert.equal(normal.mode, "Normal");
  assert.equal(normal.history[0].actor, user.id);
  assert.throws(() => createReviewSession({ session_id: "review-4", mode: "Normal" }), /user choice/);
  assert.throws(() => createReviewSession({ session_id: "review-3", mode: "auto" }), /mode/);
});

test("only user-approved, unchanged presented material can be used by Reviewer", () => {
  const approval = recordMaterialApproval(material, user, "approved");
  assert.equal(approval.material_id, material.id);
  assert.equal(canReviewerUseMaterial(material, approval), true);
  assert.equal(canReviewerUseMaterial({ ...material, context: "Changed after presentation." }, approval), false);
  assert.equal(canReviewerUseMaterial(material, recordMaterialApproval(material, user, "rejected")), false);
  assert.throws(() => recordMaterialApproval(material, { role: "architecture_review_lead", id: "reviewer-1" }, "approved"), /user/);
  assert.throws(() => recordMaterialApproval(material, user, "pending"), /result/);
});

test("objections can trace user claims and the approval schema binds the displayed source, claim, and context", async () => {
  const review = {
    schema_version: 1, id: "review-1", decision_id: "decision-1", reviewer: "architecture_review_lead",
    assessment: "Challenge follows the supplied claim.", outcome: "NEEDS_DEFENSE", material_ids: [],
    checklist: { requirements: true, targets: true, alternatives: true, tradeoffs: true, evidence: true, boundary: true, answered_objections: false },
    objections: [{ id: "objection-1", statement: "Explain why the claim applies to peak load.", provenance: "User claim claim-1; target target-1", claim_ids: ["claim-1"], target_ids: ["target-1"], unavailable_refs: { principle_ids: "No approved Principle is available.", evidence_ids: "No project Evidence is currently linked." }, status: "open" }],
  };
  assert.equal(validateReviewRecord(review, { claimIds: ["claim-1"], targetIds: ["target-1"] }).valid, true);
  assert.equal(validateReviewRecord(review, { claimIds: ["other-claim"], targetIds: ["target-1"] }).errors[0].code, "unknown_claim_ref");
  const schema = parseYaml(await readFile(new URL("../.codex/schemas/decision/material-approval.schema.yaml", import.meta.url), "utf8"));
  assert.deepEqual(schema.required, ["schema_version", "id", "material_id", "source_ids", "claim_ids", "context", "provenance", "result", "decided_by_role", "decided_by", "decided_at", "subject_hash"]);
  assert.deepEqual(schema.properties.result.enum, ["approved", "rejected"]);
  assert.match(schema.properties.subject_hash.pattern, /64/);
});

test("explicit mode transitions preserve history and unresolved gates", () => {
  const initial = createReviewSession({ session_id: "review-1", unresolved_gates: ["material_use", "decision_review_complete"] });
  const next = transitionReviewMode(initial, { to: "Normal", actor: user, at: "2026-01-02T03:04:05.000Z" });
  assert.equal(next.mode, "Normal");
  assert.deepEqual(next.unresolved_gates, initial.unresolved_gates);
  assert.equal(next.history.length, 1);
  assert.deepEqual(next.history[0], {
    type: "mode_changed", from: "Learning", to: "Normal", actor: "human-1", at: "2026-01-02T03:04:05.000Z",
  });
  assert.throws(() => transitionReviewMode(next, { to: "Learning", actor: { role: "reviewer", id: "reviewer-1" } }), /user/);
  assert.throws(() => transitionReviewMode(next, { to: "Learning", actor: user, explicit: false }), /explicit/);
});

test("local review journal resumes mode, approval wait, history, and unresolved gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-review-"));
  try {
    const initial = createReviewSession({ session_id: "review-1", unresolved_gates: ["decision_review_complete"] });
    await appendReviewHistory({ root, session: initial, type: "session_started" });
    const waiting = { ...initial, unresolved_gates: ["material_use", ...initial.unresolved_gates] };
    await appendReviewHistory({ root, session: waiting, type: "material_approval_requested", approval_id: "material-approval-1", subject_hash: "a".repeat(64) });
    const normal = transitionReviewMode(waiting, { to: "Normal", actor: user, at: "2026-01-02T03:04:05.000Z" });
    await appendReviewHistory({ root, session: normal, type: "mode_changed", event: normal.history.at(-1) });

    const resumed = await resumeReviewSession({ root, sessionId: "review-1" });
    assert.equal(resumed.mode, "Normal");
    assert.deepEqual(resumed.unresolved_gates, ["material_use", "decision_review_complete"]);
    assert.equal(resumed.pending_material_approval.approval_id, "material-approval-1");
    assert.equal(resumed.history.length, 3);
    await appendReviewHistory({ root, session: normal, type: "material_use_decided", event: { approval_id: "material-approval-1", result: "rejected" } });
    assert.equal((await resumeReviewSession({ root, sessionId: "review-1" })).pending_material_approval, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local review journal rejects a symlinked stream file", async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-review-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "decision-review-outside-"));
  try {
    const directory = join(root, "docs", "specs", ".runtime", "506", "review-1");
    await mkdir(directory, { recursive: true });
    const externalFile = join(outside, "events.jsonl");
    await writeFile(externalFile, "", "utf8");
    await symlink(externalFile, join(directory, "events.jsonl"));
    await assert.rejects(
      () => appendReviewHistory({ root, session: createReviewSession({ session_id: "review-1" }), type: "session_started" }),
      /regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("spec-me registers Learning-only review stage and condition contract", async () => {
  const workflow = await loadNamedWorkflow("spec-me", { root: ROOT });
  const reviewStage = workflow.stages.find((stage) => stage.id === "review-architecture-decisions");
  assert.ok(reviewStage, "Learning review stage is declared");
  assert.equal(reviewStage.role, "architecture_review_lead");
  assert.equal(reviewStage.condition, "learning_mode");
  assert.equal(evaluateWorkflowCondition("learning_mode", {}).applies, true, "mode omission defaults to Learning");
  const normalSession = createReviewSession({ session_id: "explicit-normal", mode: "Normal", actor: user });
  const learningSession = createReviewSession({ session_id: "learning-default" });
  assert.equal(evaluateWorkflowCondition("learning_mode", { review_session: normalSession }).applies, false);
  assert.equal(evaluateWorkflowCondition("learning_mode", { review_session: learningSession }).applies, true);
  assert.throws(() => evaluateWorkflowCondition("learning_mode", { mode: "auto" }), /mode/);
  assert.throws(() => evaluateWorkflowCondition("learning_mode", { mode: "Normal" }), /explicit user selection/);
  assert.equal(evaluateStageCondition({ workflow, stageId: reviewStage.id, input: { review_session: normalSession } }).applies, false);
  assert.equal(evaluateStageCondition({ workflow, stageId: reviewStage.id, input: { review_session: learningSession } }).applies, true);
  assert.ok(workflow.references.roles.architecture_review_lead);
  assert.ok(workflow.references.skills["architecture-review"]);
});
