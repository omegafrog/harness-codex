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
  BEADS: 'beads',
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
  WORKTREE_STAGE.BOUNDED_CONTEXT,
  WORKTREE_STAGE.REQUIREMENTS_FIX,
]);

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

// The tactical design flow runs after requirements-fix, one stage per step. Every stage fills its own
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
// restarting requirements must never restore or remove application code.
export const TACTICAL_IMPLEMENTATION_STAGES = Object.freeze([
  WORKTREE_STAGE.TACTICAL_TECHNOLOGY,
  WORKTREE_STAGE.TACTICAL_UI,
  WORKTREE_STAGE.TACTICAL_API,
  WORKTREE_STAGE.TACTICAL_DATA,
  WORKTREE_STAGE.TACTICAL_CODE,
]);

export function tacticalImplementationOrderViolation(stages, stageId) {
  const index = TACTICAL_IMPLEMENTATION_STAGES.indexOf(stageId);
  if (index < 0) return null;
  const missingDesign = TACTICAL_DESIGN_STAGES.find((id) => stages?.[id]?.status !== 'completed' || stages[id].code !== 'OK');
  if (missingDesign) return `${stageId} requires completed/OK tactical design stage ${missingDesign}`;
  if (index === 0) {
    return null;
  }
  const required = TACTICAL_IMPLEMENTATION_STAGES.slice(0, index).find((id) => stages?.[id]?.status !== 'completed' || stages[id].code !== 'OK');
  return required ? `${stageId} cannot start before ${required}: complete it with completed/OK first` : null;
}

// Requirements and tactical design stages, in order: the one list that commit, restart, stored-input and result
// canonicalization wiring read. A new stage joins the flow by taking its place in one of the two lists above.
export const PRE_SPEC_STAGES = Object.freeze([...REQUIREMENTS_STAGES, ...TACTICAL_DESIGN_STAGES]);

const hasRecordedResult = (entry) => Boolean(entry?.result_ref || entry?.attempts?.some((attempt) => attempt?.result_ref));

// These stages run in order, so a stage starts only after every earlier stage completed with OK. Returns the
// first earlier stage that has not, or null when `stageId` may start. The check only reads the recorded stages: an
// orchestrator holding old instructions cannot skip a stage that a newer Harness inserted into the flow.
// - A legacy spec-me state is checked after the final tactical-design stage for migration safety.
// - A stage that already recorded a result is a resume, a user revision or a revision return of started work: it started
//   when the flow allowed it, so the answer, feedback and revision paths keep working for it.
export function nextRequiredPreSpecStage(stages, stageId) {
  const index = stageId === WORKTREE_STAGE.SPEC_ME ? PRE_SPEC_STAGES.length : PRE_SPEC_STAGES.indexOf(stageId);
  if (index < 0 || hasRecordedResult(stages?.[stageId])) return null;
  if (stageId === WORKTREE_STAGE.SPEC_ME && !PRE_SPEC_STAGES.some((id) => stages?.[id])) return null;
  return PRE_SPEC_STAGES.slice(0, index).find((id) => stages?.[id]?.status !== 'completed' || stages[id].code !== 'OK') ?? null;
}

// The refusal message names the stage the flow needs next. A stage that an earlier Harness started out of order is
// still recorded without a result, so the message also names the supported way to discard it.
export function preSpecOrderViolation(stages, stageId) {
  const required = nextRequiredPreSpecStage(stages, stageId);
  if (!required) return null;
  const status = stages?.[required]?.status;
  const recorded = stages?.[stageId];
  return `${stageId} cannot start before ${required}: the flow runs ${PRE_SPEC_STAGES.join(' → ')} in order, and ${required} is ${status ? `${status}${stages[required].code ? `/${stages[required].code}` : ''}, not completed/OK` : 'not started'}. Complete ${required} next.${recorded ? ` ${stageId} is already recorded as ${recorded.status} without a result, so it was started out of order. After its native run has ended and its Codex session is closed, discard it with: node .codex/scripts/harness-prepare-input.mjs --stage-id ${stageId} --discard-out-of-order true` : ''}`;
}
