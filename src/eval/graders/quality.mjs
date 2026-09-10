import { redact } from "../util.mjs";

export const QUALITY_WEIGHTS = Object.freeze({ task_quality: 0.65, trajectory_quality: 0.35 });

function countAction(trajectory, action) {
  return trajectory.filter((record) => record.action === action || record.payload?.action === action).length;
}

export class QualityGrader {
  constructor({ model = "deterministic-v1", rubricVersion = "1" } = {}) {
    this.model = model;
    this.rubricVersion = rubricVersion;
  }

  grade({ caseSpec, artifactBundle }) {
    if (!artifactBundle || !artifactBundle.case_spec || !Array.isArray(artifactBundle.normalized_trajectory)) throw new Error("QualityGrader requires a versioned artifact bundle");
    const outcome = artifactBundle.outcome_evidence?.passed === true;
    const trajectory = artifactBundle.normalized_trajectory;
    const finalOutput = artifactBundle.final_output;
    const coverage = caseSpec.required_outcome.length === 0 ? 0 : (caseSpec.required_outcome.length - (artifactBundle.outcome_evidence?.missing?.length || 0)) / caseSpec.required_outcome.length;
    const outputClarity = typeof finalOutput === "string" && finalOutput.trim().length > 0 ? 1 : 0;
    const taskQuality = Math.max(0, Math.min(1, 0.65 * coverage + 0.2 * (outcome ? 1 : 0) + 0.15 * outputClarity));
    const duplicateActions = trajectory.length - new Set(trajectory.filter((record) => record.action).map((record) => `${record.action}:${JSON.stringify(record.target || "")}`)).size;
    const backtracking = countAction(trajectory, "stage_backtrack") + countAction(trajectory, "retry");
    const trajectoryQuality = Math.max(0, Math.min(1, 1 - Math.min(0.6, duplicateActions * 0.08) - Math.min(0.4, backtracking * 0.2)));
    const quality = QUALITY_WEIGHTS.task_quality * taskQuality + QUALITY_WEIGHTS.trajectory_quality * trajectoryQuality;
    return {
      task_quality: Number(taskQuality.toFixed(4)),
      trajectory_quality: Number(trajectoryQuality.toFixed(4)),
      quality: Number(quality.toFixed(4)),
      dimensions: {
        requirement_coverage: Number(coverage.toFixed(4)),
        ambiguity_resolution: caseSpec.required_outcome.includes("ambiguity_resolved") ? Number((artifactBundle.outcome_evidence?.results?.ambiguity_resolved ? 1 : 0).toFixed(4)) : 1,
        action_relevance: Number((trajectory.length ? Math.min(1, trajectory.filter((record) => record.kind !== "message").length / trajectory.length + 0.5) : 0).toFixed(4)),
        unnecessary_backtracking: Number(Math.max(0, 1 - backtracking * 0.2).toFixed(4)),
      },
      rationale: "Versioned artifact bundle 기반 deterministic rubric 평가.",
      evaluator_snapshot: { model: this.model, rubric_version: this.rubricVersion },
    };
  }
}

export function collectEfficiency({ trajectory = [], execution = {}, startedAt = null, finishedAt = null }) {
  const toolCalls = trajectory.filter((record) => record.kind === "tool_call").length;
  const turns = trajectory.filter((record) => record.kind === "message" && record.actor === "codex").length;
  const handoffs = trajectory.filter((record) => record.action === "handoff").length;
  const tokens = Number(execution.tokens ?? trajectory.reduce((sum, record) => sum + Number(record.payload?.tokens || 0), 0));
  return {
    tokens,
    latency_ms: Number(execution.durationMs ?? (startedAt && finishedAt ? finishedAt - startedAt : 0)),
    tool_calls: toolCalls,
    turns,
    handoffs,
  };
}
