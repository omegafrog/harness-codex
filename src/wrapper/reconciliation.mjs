const REQUIRED_REVIEW_ROLES = ["spec", "standards"];
const TERMINAL_STATUSES = new Set(["done", "completed"]);

function expectedDoneStatus(trackerMode) {
  return trackerMode === "local-markdown" ? "completed" : "Done";
}

function trackerIsReconciled(snapshot, trackerMode) {
  if (!snapshot) return false;
  if (trackerMode === "local-markdown") return snapshot.status === "completed";
  const expected = expectedDoneStatus(trackerMode);
  return snapshot.status === expected
    && snapshot.project_status === expected
    && snapshot.all_issues_closed === true;
}

function unresolvedReviewRoles(reviews, implementation) {
  const byRole = new Map((reviews || []).map((review) => [review.role, review]));
  return REQUIRED_REVIEW_ROLES
    .filter((role) => {
      const review = byRole.get(role);
      return review?.state !== "passed"
        || review.independent !== true
        || review.fresh_context !== true
        || review.implementation_commit_sha !== implementation?.commit_sha;
    })
    .map((role) => `review:${role}`);
}

export function evaluateCompletion({ implementation, reviews = [], blocker = null, pr = {} } = {}) {
  const unresolved = [];
  if (implementation?.state !== "completed" || !implementation.commit_sha) unresolved.push("implementation:incomplete");
  unresolved.push(...unresolvedReviewRoles(reviews, implementation));
  if (!pr.merged) unresolved.push("pr:not-merged");
  if (blocker) unresolved.push(`blocker:${blocker.kind || "unknown"}`);
  return {
    can_complete: unresolved.length === 0,
    state: unresolved.length === 0 ? "completed" : blocker ? "blocked" : "in-progress",
    unresolved,
    evidence: {
      implementation_commit: implementation?.commit_sha || null,
      reviews: reviews.map(({ role, state }) => ({ role, state })),
      pr_merged: pr.merged === true,
    },
  };
}

export function recalculateDependents(plans, { completedPlanIds = [] } = {}) {
  if (!Array.isArray(plans)) throw new TypeError("plans must be an array");
  const completed = new Set(completedPlanIds);
  for (const plan of plans) if (TERMINAL_STATUSES.has(plan.status)) completed.add(plan.id);
  const ready = [];
  const waiting = [];
  for (const plan of plans) {
    if (TERMINAL_STATUSES.has(plan.status) || completed.has(plan.id)) continue;
    const reasons = (plan.dependencies || []).filter((dependency) => !completed.has(dependency)).map((dependency) => `dependency:${dependency}`);
    if (plan.status === "blocked") reasons.push("status:blocked");
    if (!reasons.length && ["planned", "in-progress", undefined].includes(plan.status)) ready.push(plan.id);
    else waiting.push({ plan_id: plan.id, reasons: reasons.length ? reasons : [`status:${plan.status}`] });
  }
  return { ready, waiting };
}

export function reconcileCompletion({ plan, implementation, reviews = [], blocker = null, pr = {}, trackerSnapshot = null, trackerMode = "github", dependents = [] } = {}) {
  if (!plan?.id) throw new TypeError("plan.id is required");
  const completion = evaluateCompletion({ implementation, reviews, blocker, pr });
  if (completion.can_complete && !trackerIsReconciled(trackerSnapshot, trackerMode)) {
    completion.can_complete = false;
    completion.state = "in-progress";
    completion.unresolved.push("tracker:not-reconciled");
  }
  const currentStatus = trackerSnapshot?.status || null;
  const requestedStatus = completion.can_complete ? expectedDoneStatus(trackerMode) : completion.state === "blocked" ? (trackerMode === "local-markdown" ? "blocked" : "Blocked") : (trackerMode === "local-markdown" ? "in-progress" : "In Progress");
  return {
    plan_id: plan.id,
    state: completion.state,
    can_complete: completion.can_complete,
    unresolved: completion.unresolved,
    completion,
    tracker_reconciliation: {
      mode: trackerMode,
      current_status: currentStatus,
      requested_status: requestedStatus,
      mutated: false,
      reason: "wrapper computes reconciliation; selected tracker remains the source of truth",
    },
    dependents: recalculateDependents(dependents, { completedPlanIds: completion.can_complete ? [plan.id] : [] }),
  };
}
