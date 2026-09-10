import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION } from "./contracts.mjs";
import { redact } from "./util.mjs";

const activeWriters = new Set();
const activeTrajectoryWriters = new Set();
const TRAJECTORY_ACTORS = new Set(["codex", "harness", "external"]);
const TRAJECTORY_KINDS = new Set(["message", "tool_call", "tool_result", "process_event"]);
const TRAJECTORY_STATUSES = new Set(["success", "error", "denied", "cancelled"]);
const TRAJECTORY_SOURCES = new Set(["structured_event", "stdout_fallback"]);

export class JournalCorruptionError extends Error {
  constructor(kind, message, { events = [], line = null, fragment = null } = {}) {
    super(message);
    this.name = "JournalCorruptionError";
    this.kind = kind;
    this.events = events;
    this.line = line;
    this.fragment = fragment;
  }
}

function validateEnvelope(value, { streamId, kind = "event", expectedSeq }) {
  if (!value || typeof value !== "object" || value.schema_version !== SCHEMA_VERSION) return "schema_mismatch";
  if (streamId && value.stream_id !== streamId) return "stream_mismatch";
  if (!Number.isInteger(value.seq)) return "invalid_sequence";
  if (expectedSeq !== undefined && value.seq !== expectedSeq) return value.seq < expectedSeq ? "duplicate_sequence" : "sequence_gap";
  if (kind === "event" && (typeof value.type !== "string" || value.payload === undefined)) return "schema_mismatch";
  if (kind === "trajectory" && (!TRAJECTORY_ACTORS.has(value.actor) || !TRAJECTORY_KINDS.has(value.kind) || value.payload === undefined || (value.status !== undefined && !TRAJECTORY_STATUSES.has(value.status)) || !TRAJECTORY_SOURCES.has(value.source))) return "schema_mismatch";
  return null;
}

async function quarantine(path, raw, { line, kind }) {
  const quarantineDir = `${path}.corrupt`;
  await mkdir(quarantineDir, { recursive: true });
  const name = `${String(line).padStart(6, "0")}.jsonl`;
  const fragmentPath = join(quarantineDir, name);
  await writeFile(fragmentPath, raw, "utf8");
  await writeFile(join(quarantineDir, `${name}.json`), `${JSON.stringify({ path, line, kind, quarantined_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return fragmentPath;
}

export async function replayJsonlStream(path, { streamId = null, kind = "event", quarantineMalformedFinal = true } = {}) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { events: [], valid: true, corruption: null, recovered: false };
    throw error;
  }
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const events = [];
  let expectedSeq = 1;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      const isFinal = index === lines.length - 1;
      if (isFinal && quarantineMalformedFinal) {
        const fragment = await quarantine(path, raw, { line: index + 1, kind: "malformed_final_line" });
        return { events, valid: false, recovered: true, corruption: { kind: "malformed_final_line", line: index + 1, fragment, message: error.message } };
      }
      return { events, valid: false, recovered: false, corruption: { kind: "malformed_line", line: index + 1, message: error.message } };
    }
    const errorKind = validateEnvelope(value, { streamId, kind, expectedSeq });
    if (errorKind) return { events, valid: false, recovered: false, corruption: { kind: errorKind, line: index + 1, event: value } };
    events.push(value);
    expectedSeq += 1;
  }
  return { events, valid: true, recovered: false, corruption: null };
}

export const replayEventStream = (path, options = {}) => replayJsonlStream(path, { ...options, kind: "event" });
export const replayTrajectoryStream = (path, options = {}) => replayJsonlStream(path, { ...options, kind: "trajectory" });

export async function recoverEventStream(path, { streamId, checkpointPath = null } = {}) {
  const replay = await replayEventStream(path, { streamId });
  let events = replay.events;
  if (replay.corruption?.kind === "malformed_final_line") {
    const temporary = `${path}.recovered-${process.pid}-${Date.now()}`;
    await writeFile(temporary, events.length ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "", "utf8");
    await rename(temporary, path);
    const writer = await new JsonlEventWriter(path, { streamId }).init();
    await writer.append("journal_recovered", { corruption: replay.corruption }, { critical: true });
    await writer.close();
    const repaired = await replayEventStream(path, { streamId });
    events = repaired.events;
  }
  if (checkpointPath) await projectCheckpoint(events, checkpointPath, { streamId, corruption: replay.corruption });
  return { ...replay, events };
}

export async function projectCheckpoint(events, checkpointPath, { streamId = null, corruption = null } = {}) {
  const last = events.at(-1);
  const body = [
    "# Checkpoint",
    "",
    `- stream_id: ${streamId || last?.stream_id || "unknown"}`,
    `- last_seq: ${last?.seq || 0}`,
    `- last_event: ${last?.type || "none"}`,
    `- recovery: ${corruption ? corruption.kind : "none"}`,
    "",
    "## Resume Projection",
    "",
    last ? `\`payload\`: ${JSON.stringify(redact(last.payload))}` : "아직 기록된 event가 없습니다.",
    "",
  ].join("\n");
  await mkdir(dirname(checkpointPath), { recursive: true });
  const temporary = `${checkpointPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, body, "utf8");
  await rename(temporary, checkpointPath);
  return checkpointPath;
}

export class JsonlEventWriter {
  constructor(path, { streamId, schemaVersion = SCHEMA_VERSION, clock = () => new Date().toISOString() } = {}) {
    if (!streamId) throw new TypeError("streamId is required");
    if (activeWriters.has(path)) throw new Error(`A writer is already active for ${path}`);
    activeWriters.add(path);
    this.path = path;
    this.streamId = streamId;
    this.schemaVersion = schemaVersion;
    this.clock = clock;
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.closed = false;
    this.needsSeparator = false;
  }

  async init() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      let content = "";
      try {
        content = await readFile(this.path, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      this.needsSeparator = content.length > 0 && !content.endsWith("\n");
      const replay = await replayEventStream(this.path, { streamId: this.streamId });
      if (replay.corruption?.kind === "malformed_final_line") {
        const temporary = `${this.path}.recovered-${process.pid}-${Date.now()}`;
        await writeFile(temporary, replay.events.length ? `${replay.events.map((event) => JSON.stringify(event)).join("\n")}\n` : "", "utf8");
        await rename(temporary, this.path);
        this.needsSeparator = false;
      } else if (replay.corruption) {
        throw new JournalCorruptionError(replay.corruption.kind, `Cannot append to corrupt journal: ${this.path}`, { events: replay.events, line: replay.corruption.line });
      }
      this.sequence = replay.events.at(-1)?.seq || 0;
      if (replay.corruption?.kind === "malformed_final_line") await this.append("journal_recovered", { corruption: replay.corruption }, { critical: true });
    } catch (error) {
      activeWriters.delete(this.path);
      throw error;
    }
    return this;
  }

  append(type, payload = {}, { critical = false, extra = {} } = {}) {
    if (this.closed) return Promise.reject(new Error("Event writer is closed"));
    this.queue = this.queue.then(async () => {
      this.sequence += 1;
      const event = { schema_version: this.schemaVersion, stream_id: this.streamId, seq: this.sequence, timestamp: this.clock(), type, payload: redact(payload), ...extra };
      const line = `${JSON.stringify(event)}\n`;
      const handle = await open(this.path, "a");
      try {
        if (this.needsSeparator) {
          await handle.write("\n", "utf8");
          this.needsSeparator = false;
        }
        await handle.write(line, "utf8");
        if (critical) await handle.sync();
      } finally {
        await handle.close();
      }
      return event;
    });
    return this.queue;
  }

  async close() {
    try {
      await this.queue;
    } finally {
      this.closed = true;
      activeWriters.delete(this.path);
    }
  }
}

export function normalizeTrajectoryRecord(record, { streamId, seq, timestamp = new Date().toISOString() } = {}) {
  if (!streamId) throw new TypeError("streamId is required");
  const normalized = { schema_version: SCHEMA_VERSION, stream_id: streamId, seq, timestamp, actor: record.actor || "codex", kind: record.kind || "message" };
  for (const key of ["correlation_id", "action", "target", "status"]) if (record[key] !== undefined) normalized[key] = redact(record[key]);
  normalized.payload = redact(record.payload ?? {});
  normalized.source = record.source || "structured_event";
  const error = validateEnvelope(normalized, { streamId, kind: "trajectory", expectedSeq: seq });
  if (error) throw new JournalCorruptionError(error, `Invalid trajectory record: ${error}`);
  return normalized;
}

export class TrajectoryWriter {
  constructor(path, { streamId, clock = () => new Date().toISOString() } = {}) {
    if (activeTrajectoryWriters.has(path)) throw new Error(`A trajectory writer is already active for ${path}`);
    activeTrajectoryWriters.add(path);
    this.path = path;
    this.streamId = streamId;
    this.clock = clock;
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.closed = false;
    this.needsSeparator = false;
  }

  async init() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      let content = "";
      try {
        content = await readFile(this.path, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      this.needsSeparator = content.length > 0 && !content.endsWith("\n");
      const replay = await replayTrajectoryStream(this.path, { streamId: this.streamId });
      if (replay.corruption?.kind === "malformed_final_line") {
        const temporary = `${this.path}.recovered-${process.pid}-${Date.now()}`;
        await writeFile(temporary, replay.events.length ? `${replay.events.map((event) => JSON.stringify(event)).join("\n")}\n` : "", "utf8");
        await rename(temporary, this.path);
        this.needsSeparator = false;
      } else if (replay.corruption) {
        throw new JournalCorruptionError(replay.corruption.kind, `Cannot append to corrupt trajectory: ${this.path}`, { events: replay.events, line: replay.corruption.line });
      }
      this.sequence = replay.events.at(-1)?.seq || 0;
    } catch (error) {
      activeTrajectoryWriters.delete(this.path);
      throw error;
    }
    return this;
  }

  append(record) {
    if (this.closed) return Promise.reject(new Error("Trajectory writer is closed"));
    this.queue = this.queue.then(async () => {
      this.sequence += 1;
      const normalized = normalizeTrajectoryRecord(record, { streamId: this.streamId, seq: this.sequence, timestamp: this.clock() });
      await appendFile(this.path, `${this.needsSeparator ? "\n" : ""}${JSON.stringify(normalized)}\n`, "utf8");
      this.needsSeparator = false;
      return normalized;
    });
    return this.queue;
  }

  async close() {
    try {
      await this.queue;
    } finally {
      this.closed = true;
      activeTrajectoryWriters.delete(this.path);
    }
  }
}
