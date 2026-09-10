function trackerPort(port) {
  if (!port || typeof port.execute !== "function") throw new TypeError("tracker port with execute(request) is required");
  return port;
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
  return execute(port, "read_issue", { repository, issue: parentIssue }, "tracker-verify-plan-set", { expected_child_issues: [...new Set(childIssues)] });
}
