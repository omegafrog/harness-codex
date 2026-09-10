import assert from "node:assert/strict";
import test from "node:test";

import {
  buildImplementationPrClosingBody,
  renderImplementationPr,
  renderPlanSetIssue,
  renderSplitPlanIssue,
  trackerLinkSubissue,
  trackerSetStatus,
  validatePlanSet,
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
    verification: ["npm test"],
    specs,
  });

  assert.match(split, /## 상태[\s\S]*Planned/);
  assert.equal((pr.match(/^Closes #/gm) || []).length, 3);
  assert.match(pr, /Closes #10[\s\S]*Closes #11[\s\S]*Closes #12/);
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
