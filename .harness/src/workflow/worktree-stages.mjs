// Stage ids that a worktree record or an execution state may name. `spec-me`, `architecture-spec` and `architecture-review`
// are retired: no workflow runs them and their guides are removed. Their ids stay valid only so that the record of a
// worktree created by an older Harness still parses; nothing can start them (`spec-me` is refused by name, the others have no
// skill document any more).
export const WORKTREE_STAGE = Object.freeze({
  AGGREGATE_DESIGN: 'aggregate-design',
  APPLICATION_SERVICE: 'application-service',
  ARCHITECTURE_REVIEW: 'architecture-review',
  ARCHITECTURE_SPEC: 'architecture-spec',
  ATTENTION_SPAN: 'attention-span',
  BOUNDED_CONTEXT: 'bounded-context',
  CODE_RESEARCH: 'code-research',
  CODE_REVIEW: 'code-review',
  CODEBASE_DESIGN: 'codebase-design',
  CONTEXT_BOUNDARY: 'context-boundary',
  CORRECT: 'correct',
  DDD_DESIGN: 'ddd-design',
  DIAGNOSING_BUGS: 'diagnosing-bugs',
  DOMAIN_MODEL: 'domain-model',
  DOMAIN_MODELING: 'domain-modeling',
  DOMAIN_SERVICE: 'domain-service',
  E2E_TEST: 'e2e-test',
  ELI5: 'eli5',
  EVALUATE_HARNESS: 'evaluate-harness',
  EVENT_STORMING: 'event-storming',
  FRONTEND_DESIGN: 'frontend-design',
  FRONTEND_DESIGN_BRIEF: 'frontend-design-brief',
  FRONTEND_IMPLEMENTATION: 'frontend-implementation',
  FRONTEND_FIGMA: 'frontend-figma',
  FRONTEND_IMPLEMENT: 'frontend-implement',
  FRONTEND_VISUAL_REVIEW: 'frontend-visual-review',
  GH_OPEN_PR: 'gh-open-pr',
  GRILL_WITH_DOCS: 'grill-with-docs',
  GRILLING: 'grilling',
  HARNESS_MAINTENANCE: 'harness-maintenance',
  HARNESS_RECOVER: 'harness-recover',
  IMPLEMENT: 'implement',
  IMPLEMENT_WRAPPER: 'implement-wrapper',
  INTEGRATION_DESIGN: 'integration-design',
  KNOWLEDGE_HARVEST: 'knowledge-harvest',
  MAINTAIN_VERIFICATION: 'maintain-verification',
  PLAN_REVIEW: 'plan-review',
  PLANTUML_DIAGRAMS: 'plantuml-diagrams',
  PRODUCT_SPEC: 'product-spec',
  REQUIREMENTS_FIX: 'requirements-fix',
  SESSION_WORKTREE: 'session-worktree',
  SETUP: 'setup',
  SPEC_ME: 'spec-me',
  SPEC_REVIEW: 'spec-review',
  STAKEHOLDER_ANALYSIS: 'stakeholder-analysis',
  SUBDOMAIN_CANDIDATES: 'subdomain-candidates',
  SUBDOMAIN_CLASSIFICATION: 'subdomain-classification',
  SYNC_CONTRACTS: 'sync-contracts',
  TO_TICKET: 'to-ticket',
  TRACKER_PUBLISH: 'tracker-publish',
  TACTICAL_CODE: 'tactical-code',
  TACTICAL_API: 'tactical-api',
  TACTICAL_DATA: 'tactical-data',
  TACTICAL_UI: 'tactical-ui',
  TACTICAL_TECHNOLOGY: 'tactical-technology',
  UBIQUITOUS_LANGUAGE: 'ubiquitous-language',
  VICTORIALOGS_LOCAL_SETUP: 'victorialogs-local-setup',
  WORKFLOW_COMPOSE: 'workflow-compose',
  WORKTREE_CREATE: 'worktree-create',
});

// The requirements flow runs first, in order. Every stage fills the plan set's living requirements.md, so
// the runner commits, stores and canonicalizes them alike. A new stage joins the flow by taking its place in this list.
export const REQUIREMENTS_STAGES = Object.freeze([
  WORKTREE_STAGE.STAKEHOLDER_ANALYSIS,
  WORKTREE_STAGE.SUBDOMAIN_CANDIDATES,
  WORKTREE_STAGE.UBIQUITOUS_LANGUAGE,
  WORKTREE_STAGE.EVENT_STORMING,
  WORKTREE_STAGE.SUBDOMAIN_CLASSIFICATION,
  WORKTREE_STAGE.REQUIREMENTS_FIX,
  WORKTREE_STAGE.BOUNDED_CONTEXT,
]);
export const REQUIREMENTS_REVISION_STAGES = Object.freeze(REQUIREMENTS_STAGES.filter((id) => ![WORKTREE_STAGE.UBIQUITOUS_LANGUAGE, WORKTREE_STAGE.EVENT_STORMING].includes(id)));

// The plan set document that the tactical design stages fill, one section each. It is named for the flow, not for the first
// stage: a user instruction about the `domain-model` stage then cannot read as an instruction about a file.
export const TACTICAL_DESIGN_DOCUMENT = 'tactical-design.md';
// What an earlier Harness called it. A plan set that still holds it is renamed by the runner when a tactical stage input is
// prepared (migrateLegacyTacticalDesign). `docs/architecture/domain-model.md` is the project's model index and is never renamed.
export const LEGACY_TACTICAL_DESIGN_DOCUMENT = 'domain-model.md';
// The current path of a plan set document that an earlier Harness recorded under the legacy name (an artifact of a finished
// stage), or the path itself. Records of finished stages are never rewritten; a read of one follows the rename instead.
export const currentTacticalDesignPath = (path) => typeof path === 'string'
  ? path.replace(/^(docs\/specs\/[A-Za-z0-9][A-Za-z0-9._-]*\/)domain-model\.md$/, `$1${TACTICAL_DESIGN_DOCUMENT}`)
  : path;

// The tactical design flow runs after the requirements flow (bounded-context fixes requirements.md), one stage per step. Every stage fills its own
// section of the plan set's tactical-design.md, so the runner commits and stores them alike.
export const TACTICAL_DESIGN_STAGES = Object.freeze([
  WORKTREE_STAGE.DOMAIN_MODEL,
  WORKTREE_STAGE.AGGREGATE_DESIGN,
  WORKTREE_STAGE.DOMAIN_SERVICE,
  WORKTREE_STAGE.APPLICATION_SERVICE,
  WORKTREE_STAGE.INTEGRATION_DESIGN,
  WORKTREE_STAGE.CONTEXT_BOUNDARY,
]);

// This independent flow follows completed tactical design. It is deliberately not part of PRE_SPEC_STAGES:
// restarting requirements must never restore or remove application code. The settled decisions (technology, UI handoff,
// API, data) feed the ticket split (`to-ticket`), the user approves the plan set before `tracker-publish` publishes it,
// and `tactical-code` then implements the published tickets one by one.
export const TACTICAL_IMPLEMENTATION_STAGES = Object.freeze([
  WORKTREE_STAGE.TACTICAL_TECHNOLOGY,
  WORKTREE_STAGE.TACTICAL_UI,
  WORKTREE_STAGE.TACTICAL_API,
  WORKTREE_STAGE.TACTICAL_DATA,
  WORKTREE_STAGE.TO_TICKET,
  WORKTREE_STAGE.TRACKER_PUBLISH,
  WORKTREE_STAGE.TACTICAL_CODE,
]);

// A stage result counts only while it is completed/OK and no upstream rewind marked it stale (`entry.stale`, see stage-reopen.mjs).
export const isCurrentStage = (entry) => entry?.status === 'completed' && entry.code === 'OK' && !entry.stale;

// Starting the stage after a tactical design stage needs the user's approval of that stage's current result.
export const DESIGN_APPROVAL_CHAIN = Object.freeze([...TACTICAL_DESIGN_STAGES, WORKTREE_STAGE.TACTICAL_TECHNOLOGY]);

export const designApprovalSource = (stageId) => DESIGN_APPROVAL_CHAIN[DESIGN_APPROVAL_CHAIN.indexOf(stageId) - 1] ?? null;

// True when the stage already holds approval of its predecessor's current execution. A start recorded before approvals
// existed has no receipt and counts when it began after the predecessor finished.
export function designApprovalCovers(stages, stageId) {
  const entry = stages?.[stageId];
  const source = stages?.[designApprovalSource(stageId)];
  if (!entry?.execution_id || !source?.execution_id) return false;
  if (entry.design_approval) return entry.design_approval.execution_id === source.execution_id;
  return !entry.stale && Date.parse(entry.started_at || entry.finished_at) >= Date.parse(source.finished_at);
}

// The stage that waits for the user's approval of `sourceId`, or null.
export function designApprovalTarget(stages, sourceId) {
  if (!TACTICAL_DESIGN_STAGES.includes(sourceId) || !isCurrentStage(stages?.[sourceId])) return null;
  const target = DESIGN_APPROVAL_CHAIN[DESIGN_APPROVAL_CHAIN.indexOf(sourceId) + 1];
  return isCurrentStage(stages?.[target]) || designApprovalCovers(stages, target) ? null : target;
}

export const pendingDesignApproval = (stages) => TACTICAL_DESIGN_STAGES.map((id) => designApprovalTarget(stages, id)).find(Boolean) ?? null;

export function tacticalImplementationOrderViolation(stages, stageId) {
  const index = TACTICAL_IMPLEMENTATION_STAGES.indexOf(stageId);
  if (index < 0) return null;
  const missingDesign = TACTICAL_DESIGN_STAGES.find((id) => !isCurrentStage(stages?.[id]));
  if (missingDesign) return `${stageId} requires completed/OK tactical design stage ${missingDesign}`;
  if (index === 0) {
    return null;
  }
  const required = TACTICAL_IMPLEMENTATION_STAGES.slice(0, index).find((id) => !isCurrentStage(stages?.[id]));
  if (!required) return null;
  const stale = stages?.[required]?.stale;
  return stale
    ? `${stageId} cannot start before ${required}: its result is stale because ${stale.owner_stage} was reopened for ${stale.blocked_stage}. Re-run the stale stages in order: ${stale.rerun_order.join(' → ')}`
    : `${stageId} cannot start before ${required}: complete it with completed/OK first`;
}


// Requirements and tactical design stages, in order: the one list that commit, restart, stored-input and result
// canonicalization wiring read. A new stage joins the flow by taking its place in one of the two lists above.
export const PRE_SPEC_STAGES = Object.freeze([...REQUIREMENTS_STAGES, ...TACTICAL_DESIGN_STAGES]);

// The order a forward rewind walks: the owner of a gap is re-run, then every stage after it up to the blocked one. Only stages
// that precede the publication of tickets can be rewound; tracker-publish and tactical-code never rewind.
export const REWIND_STAGES = Object.freeze([
  ...PRE_SPEC_STAGES,
  ...TACTICAL_IMPLEMENTATION_STAGES.slice(0, TACTICAL_IMPLEMENTATION_STAGES.indexOf(WORKTREE_STAGE.TO_TICKET) + 1),
]);

const hasRecordedResult = (entry) => Boolean(entry?.result_ref || entry?.attempts?.some((attempt) => attempt?.result_ref));

// These stages run in order, so a stage starts only after every earlier stage completed with OK. Returns the
// first earlier stage that has not, or null when `stageId` may start. The check only reads the recorded stages: an
// orchestrator holding old instructions cannot skip a stage that a newer Harness inserted into the flow.
// - A legacy spec-me state is checked after the final tactical-design stage for migration safety.
// - A stage that already recorded a result is a resume, a user revision or a revision return of started work: it started
//   when the flow allowed it, so the answer, feedback and revision paths keep working for it.
export function nextRequiredPreSpecStage(stages, stageId) {
  const index = stageId === WORKTREE_STAGE.SPEC_ME ? PRE_SPEC_STAGES.length : PRE_SPEC_STAGES.indexOf(stageId);
  // A stale stage is re-run in order: the resume exemption does not apply to it.
  if (index < 0) return null;
  if (hasRecordedResult(stages?.[stageId]) && !stages[stageId].stale && !PRE_SPEC_STAGES.slice(0, index).some((id) => stages?.[id]?.stale)) return null;
  if (stageId === WORKTREE_STAGE.SPEC_ME && !PRE_SPEC_STAGES.some((id) => stages?.[id])) return null;
  return PRE_SPEC_STAGES.slice(0, index).find((id) => !isCurrentStage(stages?.[id])) ?? null;
}

// The refusal message names the stage the flow needs next. A stage that an earlier Harness started out of order is
// still recorded without a result, so the message also names the supported way to discard it.
export function preSpecOrderViolation(stages, stageId) {
  const required = nextRequiredPreSpecStage(stages, stageId);
  if (!required) return null;
  const recorded = stages?.[stageId];
  if (recorded?.stale || stages?.[required]?.stale) {
    const { owner_stage: owner, blocked_stage: blocked, rerun_order: order } = (recorded?.stale || stages[required].stale);
    return `${stageId} cannot start before ${required}: ${required} is ${stages[required]?.stale ? 'stale' : stages?.[required]?.status || 'not started'}${stages[required]?.stale ? `, because ${owner} was reopened for ${blocked}` : ''}. Re-run the stale stages in order (${(order || []).join(' → ')}); ${required} is next.`;
  }
  const status = stages?.[required]?.status;
  return `${stageId} cannot start before ${required}: the flow runs ${PRE_SPEC_STAGES.join(' → ')} in order, and ${required} is ${status ? `${status}${stages[required].code ? `/${stages[required].code}` : ''}, not completed/OK` : 'not started'}. Complete ${required} next.${recorded ? ` ${stageId} is already recorded as ${recorded.status} without a result, so it was started out of order. After its native run has ended and its Codex session is closed, discard it with: node .harness/scripts/harness-prepare-input.mjs --stage-id ${stageId} --discard-out-of-order true` : ''}`;
}
