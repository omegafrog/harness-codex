const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class TrackerContractError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TrackerContractError";
    this.details = details;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TrackerContractError(`${label} must be an object`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TrackerContractError(`${label} must be a non-empty string`);
  return value;
}

function id(value, label) {
  const result = string(value, label);
  if (!SAFE_ID.test(result)) throw new TrackerContractError(`${label} must be a safe identifier`);
  return result;
}

function issueNumber(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new TrackerContractError(`${label} must be a positive issue number`);
  return value;
}

function list(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new TrackerContractError(`${label} must be a ${allowEmpty ? "list" : "non-empty list"}`);
  if (value.some((item) => typeof item !== "string" || !item.trim())) throw new TrackerContractError(`${label} must contain non-empty strings`);
  return [...value];
}

function issueList(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new TrackerContractError(`${label} must be a ${allowEmpty ? "list" : "non-empty list"}`);
  const result = value.map((item, index) => issueNumber(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new TrackerContractError(`${label} must not contain duplicate issue numbers`);
  return result;
}

function specs(value, label) {
  const result = object(value, label);
  return {
    product_spec: string(result.product_spec, `${label}.product_spec`),
    architecture_spec: string(result.architecture_spec, `${label}.architecture_spec`),
  };
}

function diagrams(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TrackerContractError(`${label} must be a list`);
  return value.map((item, index) => {
    const diagram = object(item, `${label}[${index}]`);
    return {
      name: string(diagram.name, `${label}[${index}].name`),
      kind: string(diagram.kind, `${label}[${index}].kind`),
      path: string(diagram.path, `${label}[${index}].path`),
      ...(diagram.url === undefined ? {} : { url: string(diagram.url, `${label}[${index}].url`) }),
    };
  });
}

function objectList(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TrackerContractError(`${label} must be a non-empty list`);
  return value;
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new TrackerContractError(`${label}.${unknown} is not supported by the tracker contract`);
}

export function validatePlanSet(raw) {
  const value = object(raw, "plan_set");
  rejectUnknown(value, new Set(["schema_version", "kind", "id", "title", "parent_issue", "purpose", "specs", "children", "execution_order", "verification", "diagrams"]), "plan_set");
  if (value.schema_version !== 1 || value.kind !== "plan-set") throw new TrackerContractError("plan_set must use schema_version 1 and kind plan-set");
  const children = objectList(value.children, "plan_set.children").map((item, index) => {
    const child = object(item, `plan_set.children[${index}]`);
    rejectUnknown(child, new Set(["issue", "plan_id", "title", "summary", "depends_on"]), `plan_set.children[${index}]`);
    return {
      issue: issueNumber(child.issue, `plan_set.children[${index}].issue`),
      plan_id: id(child.plan_id, `plan_set.children[${index}].plan_id`),
      title: string(child.title, `plan_set.children[${index}].title`),
      summary: string(child.summary, `plan_set.children[${index}].summary`),
      depends_on: issueList(child.depends_on || [], `plan_set.children[${index}].depends_on`),
    };
  });
  const childIssues = new Set(children.map((child) => child.issue));
  const executionOrder = issueList(value.execution_order, "plan_set.execution_order", { allowEmpty: false });
  if (executionOrder.length !== children.length || executionOrder.some((issue) => !childIssues.has(issue))) throw new TrackerContractError("plan_set.execution_order must contain every child issue exactly once");
  for (const child of children) if (child.depends_on.some((dependency) => !childIssues.has(dependency))) throw new TrackerContractError(`Unknown child dependency for issue ${child.issue}`);
  return {
    schema_version: 1,
    kind: "plan-set",
    id: id(value.id, "plan_set.id"),
    title: string(value.title, "plan_set.title"),
    parent_issue: issueNumber(value.parent_issue, "plan_set.parent_issue"),
    purpose: string(value.purpose, "plan_set.purpose"),
    specs: specs(value.specs, "plan_set.specs"),
    children,
    execution_order: executionOrder,
    verification: list(value.verification, "plan_set.verification"),
    diagrams: diagrams(value.diagrams, "plan_set.diagrams"),
  };
}

export function validateSplitPlan(raw) {
  const value = object(raw, "split_plan");
  rejectUnknown(value, new Set(["schema_version", "kind", "plan_id", "issue", "parent_issue", "status", "purpose", "scope", "acceptance_criteria", "test_contract", "dependencies", "specs", "diagrams"]), "split_plan");
  if (value.schema_version !== 1 || value.kind !== "split-plan") throw new TrackerContractError("split_plan must use schema_version 1 and kind split-plan");
  const testContract = object(value.test_contract, "split_plan.test_contract");
  rejectUnknown(testContract, new Set(["unit_policy", "ui_entity_e2e"]), "split_plan.test_contract");
  return {
    schema_version: 1,
    kind: "split-plan",
    plan_id: id(value.plan_id, "split_plan.plan_id"),
    issue: issueNumber(value.issue, "split_plan.issue"),
    parent_issue: issueNumber(value.parent_issue, "split_plan.parent_issue"),
    status: value.status === "Planned" ? "Planned" : (() => { throw new TrackerContractError("split_plan.status must be Planned"); })(),
    purpose: string(value.purpose, "split_plan.purpose"),
    scope: list(value.scope, "split_plan.scope"),
    acceptance_criteria: list(value.acceptance_criteria, "split_plan.acceptance_criteria"),
    test_contract: {
      unit_policy: string(testContract.unit_policy, "split_plan.test_contract.unit_policy"),
      ui_entity_e2e: string(testContract.ui_entity_e2e, "split_plan.test_contract.ui_entity_e2e"),
    },
    dependencies: issueList(value.dependencies || [], "split_plan.dependencies"),
    specs: specs(value.specs, "split_plan.specs"),
    diagrams: diagrams(value.diagrams, "split_plan.diagrams"),
  };
}

export function validateImplementationPr(raw) {
  const value = object(raw, "implementation_pr");
  rejectUnknown(value, new Set(["schema_version", "kind", "plan_set_id", "title", "parent_issue", "child_issues", "summary", "verification", "specs", "diagrams"]), "implementation_pr");
  if (value.schema_version !== 1 || value.kind !== "implementation-pr") throw new TrackerContractError("implementation_pr must use schema_version 1 and kind implementation-pr");
  return {
    schema_version: 1,
    kind: "implementation-pr",
    plan_set_id: id(value.plan_set_id, "implementation_pr.plan_set_id"),
    title: string(value.title, "implementation_pr.title"),
    parent_issue: issueNumber(value.parent_issue, "implementation_pr.parent_issue"),
    child_issues: issueList(value.child_issues, "implementation_pr.child_issues", { allowEmpty: false }),
    summary: string(value.summary, "implementation_pr.summary"),
    verification: list(value.verification, "implementation_pr.verification"),
    specs: specs(value.specs, "implementation_pr.specs"),
    diagrams: diagrams(value.diagrams, "implementation_pr.diagrams"),
  };
}
