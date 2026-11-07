import { inspectReviewHistory, updateReviewAttempt } from '../workflow/review-attempts.mjs';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { inspectPlanSet } from '../workflow/plan-review.mjs';
import { sessionOutputPath } from '../workflow/session-output.mjs';

const REPAIRABLE_KINDS = new Set([
  "implementation_defect",
  "test_defect",
  "in_scope_spec_mismatch",
  "verification_gap",
]);

const BLOCKER_KINDS = new Set([
  "requirement_ambiguity",
  "architecture_decision",
  "scope_expansion",
  "spec_conflict",
]);

// 승인되지 않은 동작과 근거 없는 수정 요구는 자동 수정도 Spec 변경도 아닌 사용자 범위 결정으로 보낸다.
const SCOPE_DECISION_KINDS = new Set([
  "unrequested_behavior",
  "unbacked_requirement",
]);

const REMOVE_DIRECTIVE = "remove_unrequested_behavior";
const MIN_BASIS_QUOTE_LENGTH = 6;
const BASIS_SOURCES = new Set(["product_spec", "architecture_spec", "canonical_plan", "repository_standard"]);
const REPOSITORY_STANDARD_PATHS = [
  ".codex/repository-conventions.md",
  ".codex/internal-skills/code-review/references/default-rules.md",
  ".codex/internal-skills/testing-guidance/GUIDE.md",
  "docs/agents/",
  "docs/architecture/",
  "docs/contracts/",
];
const SCOPE_OPTION_LABELS = {
  unrequested_behavior: { reject: "제거", adopt: "Spec에 추가" },
  unbacked_requirement: { reject: "지적 기각", adopt: "Spec에 추가" },
};

const KIND_ALIASES = new Map([
  ["implementation", "implementation_defect"],
  ["implementation_error", "implementation_defect"],
  ["test", "test_defect"],
  ["test_failure", "test_defect"],
  ["spec_mismatch", "in_scope_spec_mismatch"],
  ["in_scope_spec_mismatch", "in_scope_spec_mismatch"],
  ["ambiguity", "requirement_ambiguity"],
  ["architecture", "architecture_decision"],
  ["scope", "scope_expansion"],
  ["unrequested", "unrequested_behavior"],
  ["conflict", "spec_conflict"],
]);

function findingList(review) {
  const report = review?.report && typeof review.report === "object" ? review.report : review;
  return Array.isArray(report?.findings) ? report.findings : [];
}

function findingKind(finding) {
  const raw = finding?.kind || finding?.category || finding?.type;
  return typeof raw === "string" ? KIND_ALIASES.get(raw) || raw : null;
}

function normalizeFinding(finding, review, index) {
  const kind = findingKind(finding);
  return {
    ...finding,
    kind: kind || "unclassified_review_finding",
    reviewer_role: review?.role || null,
    finding_index: index,
  };
}

function hasSpecBasis(finding) {
  const basis = finding?.basis;
  return Boolean(basis && typeof basis === "object" && BASIS_SOURCES.has(basis.source)
    && typeof basis.quote === "string" && basis.quote.trim().length >= MIN_BASIS_QUOTE_LENGTH);
}

function scopeFindingId(finding) {
  return finding.id || `${finding.reviewer_role || "review"}:${finding.finding_index ?? 0}`;
}

function routeScopeFinding(finding, decisions, routes) {
  const decision = decisions.get(scopeFindingId(finding));
  if (!decision) routes.blockers.push(finding);
  else if (decision.choice === "adopt") routes.blockers.push({ ...finding, kind: "scope_expansion", original_kind: finding.kind, scope_decision: decision });
  else if (finding.kind === "unbacked_requirement") routes.dismissed.push({ ...finding, scope_decision: decision });
  else routes.repairable.push({ ...finding, repair_directive: REMOVE_DIRECTIVE, scope_decision: decision });
}

function declaredAdditions(reviews) {
  const input = reviews.find((review) => review?.review_input)?.review_input;
  if (!input) return { additions: [], missing: false };
  if (!Array.isArray(input.unplanned_additions)) return { additions: [], missing: true };
  return {
    additions: input.unplanned_additions.map((addition, index) => ({
      ...addition,
      id: addition?.id || `ADD-${index + 1}`,
      kind: "unrequested_behavior",
      severity: "major",
      reviewer_role: "implementation_agent",
      finding_index: index,
    })),
    missing: false,
  };
}

export function buildScopeDecisionQuestions(findings = []) {
  return findings.filter((finding) => SCOPE_DECISION_KINDS.has(finding.kind)).map((finding) => {
    const id = scopeFindingId(finding);
    const unrequested = finding.kind === "unrequested_behavior";
    const labels = SCOPE_OPTION_LABELS[finding.kind];
    const tradeoff = [finding.benefit && `얻는 것: ${finding.benefit}`, finding.cost && `비용: ${finding.cost}`].filter(Boolean).join(" ");
    // question_id는 실행기가 부여하므로 stage 질문 본문과 대상 finding을 분리해 전달한다.
    return {
      finding_id: id,
      question: {
        title: unrequested
          ? `구현에 승인된 Spec에 없는 동작이 있습니다. 유지할까요? ${finding.summary || id}`
          : `리뷰가 승인된 Spec 근거 없이 수정을 요구했습니다. 반영할까요? ${finding.summary || id}`,
        options: [
          { id: "reject", label: labels.reject, consequence: unrequested ? "승인된 Spec대로 되돌립니다. Spec과 plan은 바뀌지 않고 수정 예산도 쓰지 않습니다." : "이 지적을 기각합니다. 코드와 Spec은 바뀌지 않습니다." },
          { id: "adopt", label: labels.adopt, consequence: "새 요구사항으로 다루어 spec-me에서 승인받고 영향 계획을 다시 리뷰합니다. 그동안 구현은 멈춥니다." },
        ],
        recommended_option_id: "reject",
        rationale: `요청하지 않은 동작은 기본적으로 넣지 않습니다.${tradeoff ? ` ${tradeoff}` : ""} 근거: ${finding.evidence || "제공되지 않음"}`,
      },
    };
  });
}

function validReviewInput(input, implementationCommitSha, expected = null) {
  if (!input || typeof input !== "object" || typeof input.repository !== "string" || !input.repository
    || typeof input.fixed_point !== "string" || !input.fixed_point
    || input.implementation_commit_sha !== implementationCommitSha
    || typeof input.diff !== "string" || !input.diff.trim()
    || !Array.isArray(input.commit_list) || !input.commit_list.includes(input.fixed_point) || !input.commit_list.includes(implementationCommitSha)
    || !input.diff_range || input.diff_range.from !== input.fixed_point || input.diff_range.to !== implementationCommitSha
    || typeof input.product_spec_path !== "string" || !input.product_spec_path
    || typeof input.architecture_spec_path !== "string" || !input.architecture_spec_path) return false;
  if ((input.plan_set_id || input.canonical_plan) && (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.plan_set_id || '') || !/^[a-f0-9]{64}$/.test(input.planning_snapshot_sha256 || ''))) return false;
  if (expected && (input.repository !== expected.repository
    || input.fixed_point !== expected.fixed_point
    || input.implementation_commit_sha !== expected.implementation_commit_sha
    || input.product_spec_path !== expected.product_spec_path
    || input.architecture_spec_path !== expected.architecture_spec_path
    || input.diff !== expected.diff
    || JSON.stringify(input.commit_list) !== JSON.stringify(expected.commit_list)
    || input.plan_set_id !== expected.plan_set_id || input.planning_snapshot_sha256 !== expected.planning_snapshot_sha256
    || JSON.stringify(input.diff_range) !== JSON.stringify(expected.diff_range))) return false;
  return true;
}

export function validReviewProvenance(reviews, implementationCommitSha = null, expectedReviewInput = null) {
  if (!Array.isArray(reviews) || reviews.length !== 2) return false;
  const roles = new Set(reviews.map((review) => review?.role));
  if (roles.size !== 2 || !roles.has("standards") || !roles.has("spec")) return false;
  return reviews.every((review) => review?.independent === true
    && review?.fresh_context === true
    && typeof review.context_id === "string"
    && review.context_id.length > 0
    && typeof review.implementation_commit_sha === "string"
    && review.implementation_commit_sha.length > 0
    && (implementationCommitSha === null || review.implementation_commit_sha === implementationCommitSha)
    && new Set(reviews.map((review) => review.context_id)).size === reviews.length
    && (!expectedReviewInput || validReviewInput(review.review_input, implementationCommitSha, expectedReviewInput)));
}

export function classifyReviewFindings(reviews = [], { scopeDecisions = [], unverifiedBasis = new Set() } = {}) {
  if (!Array.isArray(reviews)) throw new TypeError("reviews must be an array");
  const repairable = [];
  const blockers = [];
  const deferred = [];
  const advisory = [];
  const dismissed = [];
  const routes = { repairable, blockers, dismissed };
  const decisions = new Map(scopeDecisions.map((decision) => [decision.finding_id, decision]));
  if (!validReviewProvenance(reviews)) blockers.push({ kind: "reviewer_isolation_violation", summary: "both reviewers must provide independent fresh-context provenance for one implementation commit" });
  const declared = declaredAdditions(reviews);
  if (declared.missing) blockers.push({ kind: "unplanned_additions_missing", summary: "review_input must carry the implementer's unplanned_additions declaration; use an empty array when there are none" });
  for (const addition of declared.additions) routeScopeFinding(addition, decisions, routes);
  for (const review of reviews) {
    const findings = findingList(review);
    if (review?.state === "error" || review?.state === "unknown") {
      blockers.push({ kind: "review_unavailable", reviewer_role: review.role || null, summary: review.error?.message || "review result is unavailable" });
      continue;
    }
    if (review?.state !== "passed" && findings.length === 0) {
      blockers.push({ kind: "unclassified_review_finding", reviewer_role: review?.role || null, summary: "non-passing review has no structured finding" });
      continue;
    }
    findings.forEach((rawFinding, index) => {
      const finding = normalizeFinding(rawFinding, review, index);
      const hasEvidence = typeof finding.evidence === 'string' && finding.evidence.trim();
      if (finding.kind === 'contract_sync' && finding.disposition === 'integration_deferred' && finding.severity === 'minor' && finding.completion_kind === 'feature_implemented' && hasEvidence) deferred.push(finding);
      else if (finding.kind === 'advisory' && finding.severity === 'minor' && finding.blocking === false && hasEvidence) advisory.push(finding);
      else if (SCOPE_DECISION_KINDS.has(finding.kind)) routeScopeFinding(finding, decisions, routes);
      else if (REPAIRABLE_KINDS.has(finding.kind) && finding.repairable !== false && (finding.kind !== "in_scope_spec_mismatch" || finding.in_scope === true)) {
        if (hasSpecBasis(finding) && !unverifiedBasis.has(`${review?.role}:${index}`)) repairable.push(finding);
        else routeScopeFinding({ ...finding, kind: "unbacked_requirement", original_kind: finding.kind }, decisions, routes);
      }
      else if (finding.kind === "in_scope_spec_mismatch" && finding.in_scope !== true) blockers.push({ ...finding, kind: "in_scope_required" });
      else if (BLOCKER_KINDS.has(finding.kind) || finding.kind === "unclassified_review_finding" || finding.repairable === false || finding.in_scope === false) blockers.push(finding);
      else blockers.push({ ...finding, kind: "unclassified_review_finding", original_kind: finding.kind });
    });
  }
  return { repairable, blockers, deferred, advisory, dismissed, has_findings: repairable.length > 0 || blockers.length > 0 };
}

export async function implementationReviewRoot(root) {
  const primary = (await promisify(execFile)('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root, encoding: 'utf8' })).stdout.split('\0')[0];
  if (!primary.startsWith('worktree ')) throw new Error('Cannot resolve the primary review workspace');
  return primary.slice(9);
}

export async function assertPlanningReviewSnapshot({ root, planId, reviewInput, trackerPort = null }) {
  if (!reviewInput.plan_set_id) return;
  const current = await inspectPlanSet({ root, planSetId: reviewInput.plan_set_id, planId, phase: 'dispatch', trackerPort });
  if (current.status !== 'pass' || current.details.review_snapshot_sha256 !== reviewInput.planning_snapshot_sha256) throw Object.assign(new Error('Review planning snapshot changed; collect all findings, reconcile the affected documents and admit a fresh review'), { code: 'review_snapshot_changed' });
}

async function verifiedScopeDecisions(root, scopeDecisions) {
  if (!Array.isArray(scopeDecisions)) throw new TypeError("scope_decisions must be an array");
  for (const decision of scopeDecisions) {
    if (typeof decision?.finding_id !== "string" || !decision.finding_id || !["reject", "adopt"].includes(decision.choice) || typeof decision.question_id !== "string" || !decision.question_id || typeof decision.answers_ref !== "string" || !decision.answers_ref) throw new TypeError("Each scope decision needs finding_id, choice, question_id and answers_ref");
    const answers = JSON.parse(await readFile(sessionOutputPath(root, decision.answers_ref, { create: false }), "utf8"));
    const answer = Array.isArray(answers) ? answers.find((item) => item?.question_id === decision.question_id)?.answer : undefined;
    const labels = [decision.choice, SCOPE_OPTION_LABELS.unrequested_behavior[decision.choice], SCOPE_OPTION_LABELS.unbacked_requirement[decision.choice]];
    if (typeof answer !== "string" || !labels.some((label) => answer === label || answer.includes(label))) throw Object.assign(new Error(`Scope decision ${decision.finding_id} has no matching recorded user answer`), { code: "scope_decision_unverified" });
  }
  return scopeDecisions;
}

function basisPath(reviewInput, basis) {
  if (basis.source === "product_spec") return reviewInput.product_spec_path;
  if (basis.source === "architecture_spec") return reviewInput.architecture_spec_path;
  if (basis.source === "canonical_plan") return reviewInput.canonical_plan?.reference || null;
  const path = typeof basis.path === "string" ? basis.path : "";
  const safe = path && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
  return safe && REPOSITORY_STANDARD_PATHS.some((allowed) => allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed) ? path : null;
}

// 인용문이 실제 승인 문서에 없으면 reviewer가 만든 요구로 취급한다.
async function unverifiedFindingBasis(root, reviewInput, reviews) {
  const unverified = new Set();
  const compact = (text) => text.replace(/\s+/g, " ").trim();
  for (const review of reviews) {
    const findings = findingList(review);
    for (const [index, rawFinding] of findings.entries()) {
      const finding = normalizeFinding(rawFinding, review, index);
      if (!REPAIRABLE_KINDS.has(finding.kind) || !hasSpecBasis(finding)) continue;
      const path = basisPath(reviewInput, finding.basis);
      const text = path ? await readFile(resolve(root, path), "utf8").catch(() => "") : "";
      if (!compact(text).includes(compact(finding.basis.quote))) unverified.add(`${review.role}:${index}`);
    }
  }
  return unverified;
}

export async function reserveImplementationRepair({ root, planId, reviewInput, reviews, maxRounds = 1, resolution, trackerPort = null, scopeDecisions = [] }) {
  const scope = { root, scope: `implementation-${planId}` };
  if (resolution !== undefined) {
    const prior = await inspectReviewHistory(scope);
    if (!prior.plan_set_id || !prior.planning_snapshot_sha256) throw new Error('Repair budget reset requires a reviewed plan-set snapshot; a general continue instruction cannot reset it');
    const current = await inspectPlanSet({ root, planSetId: prior.plan_set_id, phase: 'dispatch', planId, trackerPort });
    if (current.status !== 'pass') throw Object.assign(new Error(`Repair budget reset requires a passing updated plan review: ${current.reason}`), { code: 'repair_resolution_review_required' });
    const currentSnapshot = current.details.review_snapshot_sha256;
    if (currentSnapshot === prior.planning_snapshot_sha256) throw new Error('Repair budget reset requires an approved scope/spec change and a new planning snapshot; continue alone is not a scope resolution');
    return updateReviewAttempt({ ...scope, action: 'resolve-repair', resolution: { reason: resolution, previous_snapshot_sha256: prior.planning_snapshot_sha256, current_snapshot_sha256: currentSnapshot } });
  }
  if (resolve(reviewInput?.repository || '') !== resolve(root)) throw new TypeError('Review input must belong to the active implementation workspace');
  if (!validReviewInput(reviewInput, reviewInput?.implementation_commit_sha) || !validReviewProvenance(reviews, reviewInput.implementation_commit_sha, reviewInput)) throw new TypeError('Repair requires both fresh reviewers for the fixed-point input');
  const decisions = await verifiedScopeDecisions(root, scopeDecisions);
  const unverifiedBasis = await unverifiedFindingBasis(root, reviewInput, reviews);
  const decision = planRepairRound({ reviews, maxRounds, scopeDecisions: decisions, unverifiedBasis });
  if (decision.action !== 'repair') return decision;
  await assertPlanningReviewSnapshot({ root, planId, reviewInput, trackerPort });
  const inputs = { ...reviewInput, reviewer_ids: reviews.map((item) => item.context_id) };
  const removals = decision.classification.repairable.filter((finding) => finding.repair_directive === REMOVE_DIRECTIVE);
  const reserveRemoval = () => updateReviewAttempt({ ...scope, action: 'scope-removal', inputs, findings: removals });
  if (decision.repair.scope_removal_only) return reserveRemoval();
  try {
    return await updateReviewAttempt({ ...scope, action: 'repair', inputs, maxRounds, findings: decision.classification.repairable });
  } catch (error) {
    // 사용자가 제거를 결정한 동작은 수리 예산이 소진돼도 되돌릴 수 있어야 한다.
    if (error.code === 'max_repair_rounds_exceeded' && removals.length) return reserveRemoval();
    throw error;
  }
}

export function planRepairRound({ reviews = [], round = 0, maxRounds = 1, scopeDecisions = [], unverifiedBasis = new Set() } = {}) {
  if (!Number.isInteger(round) || round < 0) throw new TypeError("round must be a non-negative integer");
  if (!Number.isInteger(maxRounds) || maxRounds < 0) throw new TypeError("maxRounds must be a non-negative integer");
  const classification = classifyReviewFindings(reviews, { scopeDecisions, unverifiedBasis });
  if (!classification.has_findings) return { action: "complete", state: "passed", round, classification };
  if (classification.blockers.length > 0) {
    const pendingScope = classification.blockers.filter((finding) => SCOPE_DECISION_KINDS.has(finding.kind));
    return {
      action: "block",
      state: "blocked",
      reason: (pendingScope[0] || classification.blockers[0]).kind,
      round,
      classification,
      ...(pendingScope.length ? {
        next_action: "user-decision",
        resume_condition: "Ask the user to keep or reject each listed scope item, record the answers, then resume with scope_decisions",
        user_questions: buildScopeDecisionQuestions(pendingScope),
      } : classification.blockers.some((finding) => BLOCKER_KINDS.has(finding.kind)) ? { next_action: "spec-me", resume_condition: "Approve the changed Specs and refresh the affected plans before implementation resumes" } : {}),
    };
  }
  const removals = classification.repairable.filter((finding) => finding.repair_directive === REMOVE_DIRECTIVE);
  if (round >= maxRounds && !removals.length) return {
    action: "block",
    state: "blocked",
    reason: "max_repair_rounds_exceeded",
    round,
    classification,
  };
  // 제거만 남았거나 예산이 없으면 제거 항목만 처리해 사용자 결정이 예산에 막히지 않게 한다.
  const scopeRemovalOnly = removals.length === classification.repairable.length || round >= maxRounds;
  const repairRound = scopeRemovalOnly ? round : round + 1;
  return {
    action: "repair",
    state: "repair-required",
    round: repairRound,
    classification,
    repair: {
      fresh_context: true,
      empty_context: true,
      same_plan: true,
      repair_round: repairRound,
      scope_removal_only: scopeRemovalOnly,
      findings: scopeRemovalOnly ? removals : classification.repairable,
    },
  };
}

// 사용자가 기각한 지적만 남은 리뷰는 재검토 대상이 아니므로 완료 gate에 통과로 전달한다.
function reviewsAfterDismissal(reviews, classification) {
  if (!classification.dismissed.length) return reviews;
  return reviews.map((review) => {
    const remaining = findingList(review).filter((rawFinding, index) => {
      const finding = normalizeFinding(rawFinding, review, index);
      return !classification.dismissed.some((item) => item.reviewer_role === review.role && item.finding_index === index)
        && finding.kind !== "advisory" && finding.kind !== "contract_sync";
    });
    return review.state === "failed" && remaining.length === 0
      ? { ...review, state: "passed", original_state: review.state, dismissed_by_user: classification.dismissed.filter((item) => item.reviewer_role === review.role) }
      : review;
  });
}

function validRepairImplementation(implementation, previous, plan) {
  return implementation
    && typeof implementation === "object"
    && implementation.commit_sha
    && implementation.commit_sha !== previous.commit_sha
    && typeof plan?.id === "string"
    && implementation.plan_id === plan.id
    && typeof implementation.diff === "string"
    && implementation.diff.trim().length > 0
    && Array.isArray(implementation.commit_list)
    && implementation.commit_list.includes(previous.commit_sha)
    && implementation.commit_list.includes(implementation.commit_sha)
    && implementation.fresh_context === true
    && implementation.empty_context === true;
}

function validFreshReviews(reviews, implementation, expectedReviewInput = null) {
  const requiredRoles = new Set(["standards", "spec"]);
  const roles = new Set((reviews || []).map((review) => review?.role));
  return Array.isArray(reviews)
    && roles.size === requiredRoles.size
    && [...requiredRoles].every((role) => roles.has(role))
    && reviews.every((review) => review?.independent === true && review?.fresh_context === true && review?.context_id && review.implementation_commit_sha === implementation.commit_sha)
    && new Set(reviews.map((review) => review.context_id)).size === reviews.length
    && (!expectedReviewInput || validReviewProvenance(reviews, implementation.commit_sha, expectedReviewInput));
}

export async function runBoundedReviewRepair({ plan = null, scopeDecisions = [], initialImplementation, initialReviews = [], reviewInput = null, maxRounds = 1, dispatchRepair = null, runReviewers = null, reserveRepair = null } = {}) {
  if (!initialImplementation?.commit_sha) throw new TypeError("initialImplementation.commit_sha is required");
  const expectedReviewInput = reviewInput || initialReviews.find((review) => review?.review_input)?.review_input || null;
  if (!expectedReviewInput || !validReviewInput(expectedReviewInput, initialImplementation.commit_sha)) return {
    state: "blocked",
    reason: "review_input_invalid",
    rounds: 0,
    implementation: initialImplementation,
    reviews: initialReviews,
    history: [],
    blocker: { kind: "review_input_invalid", summary: "bounded repair requires the complete fixed-point review input" },
  };
  if (!validReviewProvenance(initialReviews, initialImplementation.commit_sha, expectedReviewInput)) return {
    state: "blocked",
    reason: "reviewer_isolation_violation",
    rounds: 0,
    implementation: initialImplementation,
    reviews: initialReviews,
    history: [],
    blocker: { kind: "reviewer_isolation_violation", summary: "both reviewers must provide independent fresh-context provenance for the initial implementation commit" },
  };
  let implementation = initialImplementation;
  let reviews = initialReviews;
  const reviewContexts = new Set(initialReviews.map((item) => item.context_id));
  let round = 0;
  const history = [];
  while (true) {
    const decision = planRepairRound({ reviews, round, maxRounds, scopeDecisions });
    history.push(decision);
    if (decision.action === "complete") return { state: "passed", reason: null, rounds: round, implementation, reviews: reviewsAfterDismissal(reviews, decision.classification), history };
    const blockedDecision = (blocked) => ({ state: "blocked", reason: blocked.reason, rounds: round, implementation, reviews, history, blocker: blocked.classification.blockers[0] || null, ...(blocked.next_action ? { next_action: blocked.next_action, resume_condition: blocked.resume_condition } : {}), ...(blocked.user_questions ? { user_questions: blocked.user_questions } : {}) });
    if (decision.action === "block") return blockedDecision(decision);
    if (typeof dispatchRepair !== "function" || typeof runReviewers !== "function") return {
      state: "blocked",
      reason: "repair_adapter_unavailable",
      rounds: round,
      implementation,
      reviews,
      history,
      blocker: { kind: "repair_adapter_unavailable", summary: "bounded repair requires injected repair and reviewer adapters" },
    };
    let repaired;
    if (reserveRepair) {
      try {
        const reservation = await reserveRepair({ reviewInput: reviews[0].review_input, reviews, maxRounds, scopeDecisions });
        if (reservation.action === 'block') return blockedDecision(reservation);
        if (reservation.status !== 'pass') throw new Error(reservation.reason || 'Repair reservation failed');
        decision.round = reservation.round;
        round = reservation.round;
      } catch (error) {
        return { state: 'blocked', reason: error.code || 'repair_admission_failed', rounds: error.rounds ?? round, implementation, reviews, history, blocker: { kind: 'review-repair-admission', summary: error.message } };
      }
    }
    try {
      repaired = await dispatchRepair({
        plan,
        implementation,
        findings: decision.repair.findings,
        repair_round: decision.round,
        fresh_context: true,
        empty_context: true,
        same_plan: true,
      });
    } catch (error) {
      return { state: "blocked", reason: "repair_execution_failed", rounds: round, implementation, reviews, history, blocker: { kind: "repair_execution_failed", summary: error.message } };
    }
    if (!validRepairImplementation(repaired, implementation, plan)) return {
      state: "blocked",
      reason: "invalid_repair_result",
      rounds: round,
      implementation,
      reviews,
      history,
      blocker: { kind: "invalid_repair_result", summary: "repair must return a new commit from a fresh empty context for the same plan" },
    };
    const nextReviewInput = expectedReviewInput ? {
      ...expectedReviewInput,
      implementation_commit_sha: repaired.commit_sha,
      commit_list: repaired.commit_list,
      diff: repaired.diff,
      unplanned_additions: repaired.unplanned_additions,
      diff_range: { from: expectedReviewInput.fixed_point, to: repaired.commit_sha },
    } : null;
    let nextReviews;
    try {
      nextReviews = await runReviewers({
        plan,
        implementation: repaired,
        previous_implementation: implementation,
        repair_round: decision.round,
        fresh_context: true,
        empty_context: true,
        review_input: nextReviewInput,
      });
    } catch (error) {
      return { state: "blocked", reason: "repair_review_failed", rounds: round, implementation: repaired, reviews, history, blocker: { kind: "repair_review_failed", summary: error.message } };
    }
    if (!validFreshReviews(nextReviews, repaired, nextReviewInput) || nextReviews.some((item) => reviewContexts.has(item.context_id))) return {
      state: "blocked",
      reason: "reviewer_isolation_violation",
      rounds: round,
      implementation: repaired,
      reviews: Array.isArray(nextReviews) ? nextReviews : [],
      history,
      blocker: { kind: "reviewer_isolation_violation", summary: "repair must be followed by independent fresh reviewers for the new commit" },
    };
    implementation = repaired;
    nextReviews.forEach((item) => reviewContexts.add(item.context_id));
    reviews = nextReviews;
    round = decision.round;
  }
}

export { BLOCKER_KINDS, REPAIRABLE_KINDS, SCOPE_DECISION_KINDS };
