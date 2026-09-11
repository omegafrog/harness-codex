import assert from "node:assert/strict";
import test from "node:test";

import {
  buildImplementationPrClosingBody,
  renderImplementationPr,
  renderPlanSetIssue,
  renderSplitPlanIssue,
  trackerLinkSubissue,
  trackerSetStatus,
  trackerVerifyPlanSet,
  validatePlanSet,
  validatePlanSetSource,
} from "../src/tracker/index.mjs";

const specs = { product_spec: "docs/specs/1/product-spec.md", architecture_spec: "docs/specs/1/architecture-spec.md" };

const planSet = {
  schema_version: 1,
  kind: "plan-set",
  id: "plan-1",
  title: "Eval foundation",
  parent_issue: 10,
  purpose: "Make execution evidence deterministic.",
  specs,
  children: [
    { issue: 11, plan_id: "journal", title: "Journal", summary: "Persist execution evidence.", depends_on: [] },
    { issue: 12, plan_id: "gates", title: "Gates", summary: "Validate lifecycle boundaries.", depends_on: [11] },
  ],
  execution_order: [11, 12],
  verification: ["npm test"],
};

test("tracker contracts validate plan sets and render deterministic issue bodies", () => {
  const validated = validatePlanSet(planSet);
  const body = renderPlanSetIssue(validated);

  assert.equal(validated.children.length, 2);
  assert.match(body, /## Plan Set/);
  assert.match(body, /1\. #11 — Persist execution evidence\./);
  assert.match(body, /#11 → #12/);
  assert.ok(!body.includes("[PURPOSE]"));
});

test("tracker contracts reject duplicate children and unknown nested fields", () => {
  assert.throws(() => validatePlanSet({
    ...planSet,
    specs: { ...specs, extra: "not allowed" },
  }), /plan_set\.specs\.extra/);
  assert.throws(() => validatePlanSet({
    ...planSet,
    children: [planSet.children[0], { ...planSet.children[1], issue: 11 }],
  }), /children.*duplicate/i);
});

test("split-plan and implementation PR renderers preserve one-plan and one-PR invariants", () => {
  const split = renderSplitPlanIssue({
    schema_version: 1,
    kind: "split-plan",
    plan_id: "journal",
    issue: 11,
    parent_issue: 10,
    status: "Planned",
    purpose: "Persist evidence.",
    scope: ["JSONL journal"],
    acceptance_criteria: ["Replay is contiguous."],
    test_contract: { unit_policy: "Node tests", ui_entity_e2e: "Not applicable." },
    dependencies: [],
    specs,
  });
  const pr = renderImplementationPr({
    schema_version: 1,
    kind: "implementation-pr",
    plan_set_id: "plan-1",
    title: "Implement eval foundation",
    parent_issue: 10,
    child_issues: [11, 12],
    summary: "Implement the complete plan set.",
    implemented_plans: [
      { plan_id: "journal", issue: 11, summary: "Persist evidence." },
      { plan_id: "gates", issue: 12, summary: "Validate lifecycle boundaries." },
    ],
    key_changes: ["Added deterministic evidence storage."],
    verification: ["npm test"],
    review: { standards: "passed", spec: "passed" },
    risks_follow_ups: [],
    specs,
  });

  assert.match(split, /## 상태[\s\S]*Planned/);
  for (const heading of ["Summary", "Plan Set", "Implemented Plans", "Key Changes", "Verification", "Review", "Risks \/ Follow-ups", "Plan-set Integrity"]) assert.match(pr, new RegExp(`## ${heading}`));
  assert.ok(pr.indexOf("## Summary") < pr.indexOf("## Plan Set"));
  assert.ok(pr.indexOf("## Plan Set") < pr.indexOf("## Implemented Plans"));
  assert.ok(pr.indexOf("## Implemented Plans") < pr.indexOf("## Key Changes"));
  assert.ok(pr.indexOf("## Key Changes") < pr.indexOf("## Verification"));
  assert.ok(pr.indexOf("## Verification") < pr.indexOf("## Review"));
  assert.ok(pr.indexOf("## Review") < pr.indexOf("## Risks / Follow-ups"));
  assert.ok(pr.indexOf("## Risks / Follow-ups") < pr.indexOf("## Plan-set Integrity"));
  assert.match(pr, /Single integration PR: required/);
  assert.equal((pr.match(/^Closes #/gm) || []).length, 3);
  assert.match(pr, /Closes #10[\s\S]*Closes #11[\s\S]*Closes #12/);
});

test("implementation PR contract requires complete plan-set authoring fields", () => {
  assert.throws(() => renderImplementationPr({
    schema_version: 1,
    kind: "implementation-pr",
    plan_set_id: "plan-1",
    title: "Implement eval foundation",
    parent_issue: 10,
    child_issues: [11],
    summary: "Implement the complete plan set.",
    verification: ["npm test"],
    specs,
  }), /implemented_plans/);
});

test("structured plan-set source uses the canonical parse and validation path", () => {
  const source = `schema_version: 1
kind: plan-set
id: plan-1
title: Eval foundation
parent_issue: 10
purpose: Make execution evidence deterministic.
specs:
  product_spec: docs/specs/1/product-spec.md
  architecture_spec: docs/specs/1/architecture-spec.md
children:
  - issue: 11
    plan_id: journal
    title: Journal
    summary: Persist execution evidence.
    depends_on: []
execution_order: [11]
verification: [npm test]
`;
  assert.equal(validatePlanSetSource(source).id, "plan-1");
  assert.throws(() => validatePlanSetSource(source.replace("execution_order: [11]", "execution_order: [12]")), /execution_order/);
});

test("tracker helpers send normalized mechanics through an injected port", async () => {
  const requests = [];
  const port = { execute: async (request) => { requests.push(request); return { ok: true }; } };

  await trackerLinkSubissue(port, { repository: "owner/repo", parentIssue: 10, childIssueId: 101 });
  await trackerSetStatus(port, { repository: "owner/repo", issue: 11, status: "Planned", project: 6 });

  assert.equal(requests[0].operation, "link_subissue");
  assert.equal(requests[0].intent, "tracker-link-subissue");
  assert.equal(requests[1].payload.status, "Planned");
  assert.equal(buildImplementationPrClosingBody({ parentIssue: 10, childIssues: [11, 12, 10] }), "Closes #10\nCloses #11\nCloses #12");
});

test("tracker verification deterministically checks parentage and complete child membership", async () => {
  const requests = [];
  const port = { execute: async (request) => {
    requests.push(request);
    return { parent_issue: 10, child_issues: [11, 12] };
  } };

  const result = await trackerVerifyPlanSet(port, { repository: "owner/repo", parentIssue: 10, childIssues: [11, 12] });

  assert.equal(result.verified, true);
  assert.deepEqual(result.missing_child_issues, []);
  assert.deepEqual(result.unexpected_child_issues, []);
  assert.equal(requests[0].payload.expected_child_issues.join(","), "11,12");
});

test("tracker verification reports deterministic mismatches without delegating the decision", async () => {
  const port = { execute: async () => ({ parent_issue: 99, child_issues: [11, 13] }) };

  const result = await trackerVerifyPlanSet(port, { repository: "owner/repo", parentIssue: 10, childIssues: [11, 12] });

  assert.equal(result.verified, false);
  assert.equal(result.parent_issue_matches, false);
  assert.deepEqual(result.missing_child_issues, [12]);
  assert.deepEqual(result.unexpected_child_issues, [13]);
});
