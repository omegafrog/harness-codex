import { TrackerContractError } from "./contracts.mjs";

function trackerPort(port) {
  if (!port || typeof port.execute !== "function") throw new TypeError("tracker port with execute(request) is required");
  return port;
}

function positiveIssue(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new TrackerContractError(`${label} must be a positive issue number`);
  return value;
}

function expectedIssues(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((issue) => !Number.isInteger(issue) || issue <= 0)) {
    throw new TypeError(`childIssues must contain ${allowEmpty ? "issue numbers" : "positive issue numbers"}`);
  }
  const result = [...value];
  if (new Set(result).size !== result.length) throw new TypeError("childIssues must not contain duplicate issue numbers");
  return result;
}

/**
 * Verify the normalized tracker snapshot locally. The external port only
 * reads; it does not get to decide whether the plan set is complete.
 */
export function verifyPlanSetSnapshot(snapshot, { parentIssue, childIssues } = {}) {
  const expectedParent = positiveIssue(parentIssue, "parentIssue");
  const expected = expectedIssues(childIssues);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new TrackerContractError("tracker plan-set snapshot must be an object");
  const actualParent = positiveIssue(snapshot.parent_issue, "snapshot.parent_issue");
  const actual = expectedIssues(snapshot.child_issues || [], { allowEmpty: true });
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((issue) => !actualSet.has(issue));
  const unexpected = actual.filter((issue) => !expectedSet.has(issue));
  return {
    verified: actualParent === expectedParent && missing.length === 0 && unexpected.length === 0,
    parent_issue: actualParent,
    parent_issue_matches: actualParent === expectedParent,
    expected_child_issues: expected,
    actual_child_issues: actual,
    missing_child_issues: missing,
    unexpected_child_issues: unexpected,
  };
}

async function execute(port, operation, target, intent, payload = {}) {
  return trackerPort(port).execute({
    system: "github",
    operation,
    target,
    intent,
    payload,
  });
}

export function buildImplementationPrClosingBody({ parentIssue, childIssues } = {}) {
  if (!Number.isInteger(parentIssue) || parentIssue <= 0) throw new TypeError("parentIssue must be a positive issue number");
  if (!Array.isArray(childIssues) || childIssues.some((issue) => !Number.isInteger(issue) || issue <= 0)) throw new TypeError("childIssues must contain positive issue numbers");
  const issues = [...new Set([parentIssue, ...childIssues])];
  return issues.map((issue) => `Closes #${issue}`).join("\n");
}

export function trackerReadPlanSet(port, { repository, parentIssue } = {}) {
  if (!repository || !Number.isInteger(parentIssue) || parentIssue <= 0) throw new TypeError("repository and parentIssue are required");
  return execute(port, "read_issue", { repository, issue: parentIssue }, "tracker-read-plan-set", { include_subissues: true });
}

export function trackerLinkSubissue(port, { repository, parentIssue, childIssueId, replaceParent = false } = {}) {
  if (!repository || !Number.isInteger(parentIssue) || parentIssue <= 0 || !Number.isInteger(childIssueId) || childIssueId <= 0) throw new TypeError("repository, parentIssue, and childIssueId are required");
  return execute(port, "link_subissue", { repository, parent_issue: parentIssue }, "tracker-link-subissue", { child_issue_id: childIssueId, replace_parent: replaceParent === true });
}

export function trackerSetStatus(port, { repository, issue, status, project } = {}) {
  if (!repository || !Number.isInteger(issue) || issue <= 0 || typeof status !== "string" || !status.trim()) throw new TypeError("repository, issue, and status are required");
  return execute(port, "set_status", { repository, issue, project: project || null }, "tracker-set-status", { status });
}

export function trackerVerifyPlanSet(port, { repository, parentIssue, childIssues } = {}) {
  if (!repository || !Number.isInteger(parentIssue) || parentIssue <= 0 || !Array.isArray(childIssues) || childIssues.some((issue) => !Number.isInteger(issue) || issue <= 0)) throw new TypeError("repository, parentIssue, and childIssues are required");
  const expected = expectedIssues(childIssues);
  return execute(port, "read_issue", { repository, issue: parentIssue }, "tracker-verify-plan-set", { expected_child_issues: expected })
    .then((snapshot) => verifyPlanSetSnapshot(snapshot, { parentIssue, childIssues: expected }));
}
