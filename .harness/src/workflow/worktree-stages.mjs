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
  UBIQUITOUS_LANGUAGE: 'ubiquitous-language',
  VICTORIALOGS_LOCAL_SETUP: 'victorialogs-local-setup',
  WORKFLOW_COMPOSE: 'workflow-compose',
  WORKTREE_CREATE: 'worktree-create',
});

// The requirements flow that runs before spec-me, in order. Every stage fills the plan set's living requirements.md, so
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

// The tactical design flow runs after requirements-fix and before spec-me, one stage per step. Every stage fills its own
// section of the plan set's domain-model.md, so the runner commits and stores them alike.
export const TACTICAL_DESIGN_STAGES = Object.freeze([
  WORKTREE_STAGE.DOMAIN_MODEL,
  WORKTREE_STAGE.AGGREGATE_DESIGN,
  WORKTREE_STAGE.DOMAIN_SERVICE,
  WORKTREE_STAGE.APPLICATION_SERVICE,
  WORKTREE_STAGE.INTEGRATION_DESIGN,
]);

// Every stage that runs before spec-me, in order: the one list that the commit, restart, stored-input and result
// canonicalization wiring read. A new stage joins the flow by taking its place in one of the two lists above.
export const PRE_SPEC_STAGES = Object.freeze([...REQUIREMENTS_STAGES, ...TACTICAL_DESIGN_STAGES]);
