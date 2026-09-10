import { validateImplementationPr, validatePlanSet, validateSplitPlan } from "./contracts.mjs";

function issueLink(number, url = null) {
  return url ? `[#${number}](${url})` : `#${number}`;
}

function diagramLines(diagrams) {
  if (!diagrams.length) return ["해당 없음 — 적용 가능한 ticket-scoped SVG가 없음"];
  return diagrams.map((diagram) => `- ${diagram.kind}: ${diagram.name} — ${diagram.url ? `![${diagram.name}](${diagram.url})` : diagram.path}`);
}

export function renderPlanSetIssue(raw) {
  const plan = validatePlanSet(raw);
  const execution = plan.execution_order.map((issue) => {
    const child = plan.children.find((candidate) => candidate.issue === issue);
    return `${issueLink(issue)} — ${child.summary}`;
  });
  const dependencies = plan.children.flatMap((child) => child.depends_on.map((dependency) => `${issueLink(dependency)} → ${issueLink(child.issue)}`));
  return [
    "## Plan Set",
    "",
    `- Parent Issue: ${issueLink(plan.parent_issue)}`,
    `- Child plans: ${plan.children.map((child) => issueLink(child.issue)).join(", ")}`,
    "",
    "## 목적",
    "",
    plan.purpose,
    "",
    "## 실행 순서",
    "",
    ...execution.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 명세와 다이어그램",
    "",
    `- Product Spec: ${plan.specs.product_spec}`,
    `- Architecture Spec: ${plan.specs.architecture_spec}`,
    "- Diagrams:",
    ...diagramLines(plan.diagrams),
    "",
    "## 의존성",
    "",
    dependencies.length ? dependencies.join("\n") : "없음",
    "",
    "## 검증",
    "",
    ...plan.verification.map((item) => `- ${item}`),
    "",
    "구현·검증 완료 전에는 이 Issue를 닫지 않는다.",
    "",
  ].join("\n");
}

export function renderSplitPlanIssue(raw) {
  const plan = validateSplitPlan(raw);
  return [
    "## 상태",
    "",
    plan.status,
    "",
    "## 의존성",
    "",
    plan.dependencies.length ? plan.dependencies.map((issue) => issueLink(issue)).join(", ") : "없음",
    "",
    "## 구현 목적",
    "",
    plan.purpose,
    "",
    "## 범위",
    "",
    ...plan.scope.map((item) => `- ${item}`),
    "",
    "## 수용 기준",
    "",
    ...plan.acceptance_criteria.map((item) => `- ${item}`),
    "",
    "## 테스트 계약",
    "",
    `- 단위/정책: ${plan.test_contract.unit_policy}`,
    `- \`ui ~ entity\` E2E: ${plan.test_contract.ui_entity_e2e}`,
    "",
    "## 관련 명세",
    "",
    `- Product Spec: ${plan.specs.product_spec}`,
    `- Architecture Spec: ${plan.specs.architecture_spec}`,
    "",
    "## 다이어그램",
    "",
    ...diagramLines(plan.diagrams),
    "",
  ].join("\n");
}

export function renderImplementationPr(raw) {
  const pr = validateImplementationPr(raw);
  return [
    "## Plan Set Implementation",
    "",
    `- Plan Set: ${pr.plan_set_id}`,
    `- Parent Issue: ${issueLink(pr.parent_issue)}`,
    `- Child Issues: ${pr.child_issues.map((issue) => issueLink(issue)).join(", ")}`,
    "",
    "## Summary",
    "",
    pr.summary,
    "",
    "## Related Specs",
    "",
    `- Product Spec: ${pr.specs.product_spec}`,
    `- Architecture Spec: ${pr.specs.architecture_spec}`,
    "",
    "## Verification",
    "",
    ...pr.verification.map((item) => `- ${item}`),
    "",
    "## Diagrams",
    "",
    ...diagramLines(pr.diagrams),
    "",
    `Closes #${pr.parent_issue}`,
    ...pr.child_issues.map((issue) => `Closes #${issue}`),
    "",
  ].join("\n");
}
