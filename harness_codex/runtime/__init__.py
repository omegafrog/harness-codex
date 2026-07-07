"""Core runtime model and execution abstractions."""

from harness_codex.runtime.serena_patch import apply_serena_mcp_patch

apply_serena_mcp_patch()

from harness_codex.runtime.completion import (
    ChangeSetCompletionBlocked,
    ChangeSetCompletionResult,
    PlanCompletionBlocked,
    PlanCompletionStatus,
    complete_change_set_if_ready,
    plan_completion_status,
    validate_plan_completion,
)
from harness_codex.runtime.contracts import (
    DEFAULT_CONTRACT_REGISTRY_PATH,
    DocumentContract,
    DocumentContractRegistry,
    DocumentContractRegistryError,
    DocumentProducer,
    load_document_contract_registry,
)
from harness_codex.runtime.engine import (
    ExecutionPlan,
    RunnerEngine,
    WorkflowValidationError,
)
from harness_codex.runtime.structured_verification_routing import (
    apply_structured_verification_routing,
)

apply_structured_verification_routing()

from harness_codex.runtime.gate_policy import (
    GateDecision,
    GatePolicy,
    GateRequirement,
    ImpactTag,
    derive_gate_policy,
    derive_gate_policy_for_scope,
    parse_impact_tags,
)

from harness_codex.runtime.models import (
    ContractValidationResult,
    ContractValidationSeverity,
    ContractValidationStatus,
    FailureKind,
    HARNESS_FULL_WORKFLOW,
    RunContext,
    RunMode,
    RunResult,
    RunStatus,
    Step,
    StepKind,
    StepResult,
    StepStatus,
    Workflow,
)
from harness_codex.runtime.policy import (
    CommandRequest,
    PolicyDecision,
    PolicyEffect,
    PolicyEngine,
)
from harness_codex.runtime.reports import (
    ArtifactManifest,
    ReportWriter,
    RunReport,
    UseCaseReport,
    WorkItemReport,
)
from harness_codex.runtime.runner import (
    AgentAdapter,
    AgentRunRequest,
    AgentRunResult,
    BasicStepRunner,
    CodexCliAgentAdapter,
    ConfigurableCliAgentAdapter,
    StepRunner,
)
from harness_codex.runtime.observability_patch import apply_observability_patch

apply_observability_patch()

from harness_codex.runtime.delivery_runner_patch import apply_delivery_runner_patch

apply_delivery_runner_patch()

from harness_codex.runtime.plan_transition_policy_patch import (
    apply_plan_transition_policy_patch,
)
from harness_codex.runtime.plan_completion_boundary_patch import (
    apply_plan_completion_boundary_patch,
)
from harness_codex.runtime.procedure_stage_compatibility_patch import (
    apply_procedure_stage_compatibility_patch,
)

apply_plan_transition_policy_patch()
apply_plan_completion_boundary_patch()
apply_procedure_stage_compatibility_patch()

from harness_codex.runtime.agent_context import (
    AGENT_CONTEXT_FILES,
    HARNESS_AGENT_CONTEXT_MARKER,
    AgentContextBootstrapResult,
    AgentContextFileResult,
    bootstrap_agent_context,
)
from harness_codex.runtime.repo_analyzer import (
    LlmRepoSummary,
    RepoAnalysis,
    RepoCommand,
    analyze_repository,
    summarize_repository_with_llm,
)
from harness_codex.runtime.state import (
    ArtifactDirtyState,
    MaintenanceStep,
    ResumeDisposition,
    ResumeTarget,
    RunFailureKind,
    RunState,
    RunStateStore,
    StageArtifactState,
    StageStateDrift,
    UseCaseLoopState,
    UseCaseStep,
    WorkItemLoopState,
    decide_resume_target,
    file_checksum,
    reconcile_procedure_stage_rows,
    runtime_stage_projection,
    stage_artifact_notes,
    stage_artifact_status,
)
from harness_codex.runtime.dashboard_runtime_state import apply_dashboard_runtime_state_patch
from harness_codex.runtime.dashboard_runtime_state_legacy_bridge import (
    apply_dashboard_runtime_state_legacy_bridge,
)
from harness_codex.runtime.dashboard_runtime_state_legacy_compat import (
    apply_dashboard_runtime_state_legacy_compat,
)

apply_dashboard_runtime_state_patch()
apply_dashboard_runtime_state_legacy_bridge()
apply_dashboard_runtime_state_legacy_compat()

from harness_codex.runtime.changeset_deletion_runtime_patch import (
    apply_changeset_deletion_runtime_cleanup_patch,
)

apply_changeset_deletion_runtime_cleanup_patch()

from harness_codex.runtime.verifier import (
    CommandCheck,
    RequiredStageCheck,
    UseCaseVerificationInput,
    UseCaseVerificationResult,
    UseCaseVerifier,
    VerificationStatus,
    VerificationTier,
)

__all__ = [
    "ArtifactDirtyState",
    "AGENT_CONTEXT_FILES",
    "AgentAdapter",
    "AgentContextBootstrapResult",
    "AgentContextFileResult",
    "AgentRunRequest",
    "AgentRunResult",
    "ChangeSetCompletionBlocked",
    "ChangeSetCompletionResult",
    "PlanCompletionBlocked",
    "PlanCompletionStatus",
    "CommandRequest",
    "BasicStepRunner",
    "CodexCliAgentAdapter",
    "ConfigurableCliAgentAdapter",
    "ContractValidationResult",
    "ContractValidationSeverity",
    "ContractValidationStatus",
    "DEFAULT_CONTRACT_REGISTRY_PATH",
    "DocumentContract",
    "DocumentContractRegistry",
    "DocumentContractRegistryError",
    "DocumentProducer",
    "ExecutionPlan",
    "FailureKind",
    "GateDecision",
    "GatePolicy",
    "GateRequirement",
    "ImpactTag",
    "HARNESS_FULL_WORKFLOW",
    "HARNESS_AGENT_CONTEXT_MARKER",
    "LlmRepoSummary",
    "MaintenanceStep",
    "ArtifactManifest",
    "ReportWriter",
    "PolicyDecision",
    "PolicyEffect",
    "PolicyEngine",
    "RunContext",
    "RunMode",
    "RunResult",
    "RunReport",
    "RunFailureKind",
    "RunStatus",
    "RunState",
    "RunStateStore",
    "RunnerEngine",
    "RepoAnalysis",
    "RepoCommand",
    "ResumeDisposition",
    "ResumeTarget",
    "Step",
    "StepKind",
    "StepResult",
    "StepRunner",
    "StepStatus",
    "StageArtifactState",
    "StageStateDrift",
    "UseCaseLoopState",
    "UseCaseReport",
    "WorkItemLoopState",
    "WorkItemReport",
    "UseCaseStep",
    "CommandCheck",
    "RequiredStageCheck",
    "UseCaseVerificationInput",
    "UseCaseVerificationResult",
    "UseCaseVerifier",
    "VerificationStatus",
    "VerificationTier",
    "Workflow",
    "WorkflowValidationError",
    "analyze_repository",
    "bootstrap_agent_context",
    "complete_change_set_if_ready",
    "decide_resume_target",
    "derive_gate_policy",
    "derive_gate_policy_for_scope",
    "file_checksum",
    "reconcile_procedure_stage_rows",
    "runtime_stage_projection",
    "plan_completion_status",
    "validate_plan_completion",
    "stage_artifact_notes",
    "stage_artifact_status",
    "load_document_contract_registry",
    "parse_impact_tags",
    "summarize_repository_with_llm",
]

from harness_codex.runtime.dashboard_ddd_integration_patch import (
    apply_dashboard_ddd_integration_patch,
)

apply_dashboard_ddd_integration_patch()

from harness_codex.runtime.grill_me_question_batch_patch import (
    apply_grill_me_question_batch_patch,
)

apply_grill_me_question_batch_patch()
