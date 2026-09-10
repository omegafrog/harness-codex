import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

import { JsonlEventWriter, replayEventStream } from "../eval/journal.mjs";
import { planRuntimePaths } from "../eval/plan-journal.mjs";
import { SCHEMA_VERSION } from "../eval/contracts.mjs";
import { parseYaml } from "../eval/yaml.mjs";

const STATES = new Set(["running", "handoff-required", "conflict-paused", "priority-routed"]);
const REASONS = new Set(["context-threshold", "plan-boundary", "milestone", "retry"]);
const SMART_ZONE_PHASES = new Set(["dispatch", "before-next-action", "after-action"]);
const SMART_ZONE_STATES = new Set(["fits", "handoff-required", "unknown"]);
const FIELDS = [
  "plan_id",
  "orchestration_state",
  "attempt",
  "last_completed_step",
  "changed_files",
  "tests",
  "smart_zone",
  "blocker",
  "next_action",
  "handoff_reason",
  "updated_at",
];

function quote(value) {
  return JSON.stringify(value ?? null);
}

function normalizeState(planId, state = {}) {
  if (!planId) throw new TypeError("planId is required");
  const result = {
    plan_id: planId,
    orchestration_state: state.orchestration_state || "running",
    attempt: state.attempt === undefined ? 1 : state.attempt,
    last_completed_step: state.last_completed_step || "none",
    changed_files: Array.isArray(state.changed_files) ? state.changed_files : [],
    tests: state.tests ?? { status: "not-run" },
    smart_zone: state.smart_zone ?? { phase: "dispatch", state: "unknown", evidence: "not assessed" },
    blocker: state.blocker ?? null,
    next_action: state.next_action || "continue implementation",
    handoff_reason: state.handoff_reason ?? null,
    updated_at: state.updated_at || new Date().toISOString(),
  };
  if (!STATES.has(result.orchestration_state)) throw new TypeError(`Unsupported orchestration state: ${result.orchestration_state}`);
  if (!Number.isInteger(result.attempt) || result.attempt < 1) throw new TypeError("attempt must be a positive integer");
  if (!Array.isArray(result.changed_files) || result.changed_files.some((file) => typeof file !== "string")) throw new TypeError("changed_files must be a string list");
  if (!result.smart_zone || typeof result.smart_zone !== "object" || Array.isArray(result.smart_zone) || !SMART_ZONE_PHASES.has(result.smart_zone.phase) || !SMART_ZONE_STATES.has(result.smart_zone.state) || typeof result.smart_zone.evidence !== "string") throw new TypeError("smart_zone must contain a valid phase, state, and evidence");
  if (result.handoff_reason !== null && !REASONS.has(result.handoff_reason)) throw new TypeError(`Unsupported handoff reason: ${result.handoff_reason}`);
  return result;
}

function render(state) {
  return [
    "# Checkpoint",
    "",
    ...FIELDS.map((field) => `${field}: ${quote(state[field])}`),
    "",
    "## Resume Projection",
    "",
    "이 문서는 실행 history가 아니라 valid event replay에서 만든 resume projection입니다.",
    "",
  ].join("\n");
}

async function writeAtomicDurable(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class PlanCheckpointStore {
  constructor({ root = process.cwd(), planId, runtimeRoot = "docs/plans/.runtime" } = {}) {
    this.paths = planRuntimePaths({ root, planId, runtimeRoot });
    this.planId = planId;
    this.streamId = `plan-${planId}`;
    this.writer = null;
  }

  async eventWriter() {
    if (!this.writer) this.writer = await new JsonlEventWriter(this.paths.events_path, { streamId: this.streamId }).init();
    return this.writer;
  }

  async #writeProjection(state = {}) {
    const normalized = normalizeState(this.planId, state);
    await writeAtomicDurable(this.paths.checkpoint_path, render(normalized));
    return normalized;
  }

  async write(state = {}) {
    const previous = await this.read();
    const normalized = normalizeState(this.planId, { ...(previous || {}), ...state });
    await (await this.eventWriter()).append("checkpoint_updated", normalized, { critical: true });
    const replay = await replayEventStream(this.paths.events_path, { streamId: this.streamId });
    if (!replay.valid) throw new Error(`Cannot project invalid plan event stream: ${replay.corruption?.kind || "unknown"}`);
    return this.projectFromEvents(replay.events);
  }

  async read() {
    const replay = await replayEventStream(this.paths.events_path, { streamId: this.streamId });
    if (replay.events.length && replay.valid) return stateFromEvents(this.planId, replay.events);
    let source;
    try {
      source = await readFile(this.paths.checkpoint_path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const parsed = parseYaml(source.replace(/^# Checkpoint\s*/m, "").replace(/\n## Resume Projection[\s\S]*$/m, ""));
    return normalizeState(this.planId, parsed);
  }

  async projectFromEvents(events, { corruption = null, ...overrides } = {}) {
    if (!Array.isArray(events)) throw new TypeError("events must be an array");
    validateReplayEvents(events, this.streamId);
    const state = events.reduce((projection, event) => {
      const payload = event?.payload;
      return payload && typeof payload === "object" && !Array.isArray(payload) ? { ...projection, ...payload } : projection;
    }, {});
    return this.#writeProjection({ ...state, ...overrides, ...(corruption ? { blocker: { kind: "journal-corruption", summary: corruption.kind, unblock_condition: "repair and replay the event stream" } } : {}) });
  }

  async close() {
    if (this.writer) {
      await this.writer.close();
      this.writer = null;
    }
  }
}

function validateReplayEvents(events, streamId) {
  let expected = 1;
  for (const event of events) {
    if (!event || event.schema_version !== SCHEMA_VERSION || event.stream_id !== streamId || event.seq !== expected || typeof event.type !== "string" || event.payload === undefined) throw new TypeError("events must be a valid contiguous replay");
    expected += 1;
  }
  return true;
}

function stateFromEvents(planId, events) {
  const state = events.reduce((projection, event) => {
    const payload = event?.payload;
    return payload && typeof payload === "object" && !Array.isArray(payload) ? { ...projection, ...payload } : projection;
  }, {});
  return normalizeState(planId, state);
}

export function reconcileCheckpoint(checkpoint, actual = {}) {
  if (!checkpoint || typeof checkpoint !== "object") throw new TypeError("checkpoint is required");
  const result = { ...checkpoint };
  for (const key of ["last_completed_step", "changed_files", "tests", "smart_zone", "blocker", "next_action"]) {
    if (actual[key] !== undefined) result[key] = Array.isArray(actual[key]) ? [...actual[key]] : actual[key];
  }
  return result;
}

export function assessSmartZone({ remaining, required, threshold = 0, phase = "before-next-action" } = {}) {
  if (![remaining, required, threshold].every((value) => Number.isFinite(Number(value)))) throw new TypeError("remaining, required, and threshold must be finite numbers");
  const available = Number(remaining);
  const needed = Number(required) + Number(threshold);
  if (!SMART_ZONE_PHASES.has(phase)) throw new TypeError(`Unsupported Smart Zone phase: ${phase}`);
  const state = available >= needed ? "fits" : "handoff-required";
  return { phase, state, evidence: `${available} remaining ${state === "fits" ? ">=" : "<"} ${needed} required` };
}

export function checkpointStateFromAction({ planId, action, attempt = 1, actual = {}, handoffReason = null } = {}) {
  const base = { plan_id: planId, orchestration_state: handoffReason ? "handoff-required" : "running", attempt, handoff_reason: handoffReason };
  return normalizeState(planId, reconcileCheckpoint(base, {
    ...actual,
    last_completed_step: action,
  }));
}

export async function reconcileCheckpointFromSources(checkpoint, { readGitState, readTestState } = {}) {
  if (typeof readGitState !== "function" || typeof readTestState !== "function") throw new TypeError("readGitState and readTestState are required");
  const [git, tests] = await Promise.all([readGitState(), readTestState()]);
  return reconcileCheckpoint(checkpoint, {
    ...(git || {}),
    tests: tests ?? checkpoint.tests,
  });
}

export { normalizeState };
