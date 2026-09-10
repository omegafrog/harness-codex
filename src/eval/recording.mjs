import { appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EvalInconclusiveError } from "./errors.mjs";
import { SCHEMA_VERSION } from "./contracts.mjs";
import { canonicalJson, ensureDir, redact } from "./util.mjs";

const MUTATING_OPERATIONS = new Set([
  "create_issue",
  "update_issue",
  "create_pull_request",
  "update_pull_request",
  "merge_pull_request",
  "close_issue",
  "set_status",
  "delete",
  "write",
  "send",
]);

export function normalizeRequest(request) {
  if (!request || typeof request !== "object") throw new TypeError("External request must be an object");
  const normalized = {
    system: request.system,
    operation: request.operation,
    target: request.target || {},
    intent: request.intent || request.operation,
    payload: request.payload || {},
  };
  if (request.mutation !== undefined) normalized.mutation = request.mutation === true;
  else normalized.mutation = MUTATING_OPERATIONS.has(request.operation) || /^(create|update|delete|write|merge|close|set_)/.test(request.operation || "");
  if (typeof normalized.system !== "string" || typeof normalized.operation !== "string") throw new TypeError("External request needs system and operation");
  return redact(normalized);
}

function key(value) {
  return JSON.stringify(canonicalJson(value));
}

function normalizeResponse(response, context) {
  if (response === undefined || typeof response === "function" || typeof response === "bigint") throw new EvalInconclusiveError("corrupted_external_response", `External response is not normalized JSON: ${context}`);
  try {
    JSON.stringify(response);
  } catch (error) {
    throw new EvalInconclusiveError("corrupted_external_response", `External response is not serializable: ${context}`, { cause: error });
  }
  return redact(response);
}

async function loadRecordings(path) {
  const records = [];
  try {
    const content = await readFile(path, "utf8");
    let expectedSeq = 1;
    let streamId = null;
    for (const [index, line] of content.split("\n").entries()) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw new EvalInconclusiveError("corrupted_fixture", `Malformed recording line ${index + 1}`, { path, cause: error });
      }
      if (record.schema_version !== SCHEMA_VERSION || !record.stream_id || !Number.isInteger(record.seq) || record.seq !== expectedSeq || !record.request || record.response === undefined) {
        const reason = record.seq === expectedSeq ? "corrupted_fixture" : "corrupted_recording_sequence";
        throw new EvalInconclusiveError(reason, `Invalid recording line ${index + 1}`, { path, expected_seq: expectedSeq, actual_seq: record.seq });
      }
      if (streamId && record.stream_id !== streamId) throw new EvalInconclusiveError("corrupted_recording_stream", `Recording stream mismatch at line ${index + 1}`, { path, stream_id: record.stream_id, expected_stream_id: streamId });
      streamId ||= record.stream_id;
      records.push({ request: normalizeRequest(record.request), response: normalizeResponse(record.response, `recording line ${index + 1}`) });
      expectedSeq += 1;
    }
  } catch (error) {
    if (error.code === "ENOENT") throw new EvalInconclusiveError("missing_external_recording", `Recording not found: ${path}`, { path });
    throw error;
  }
  return records;
}

export class ExternalSystemPort {
  constructor({ mode = "none", fixture = null, runtimePath = null, integration = false, liveAdapter = null, onEvent = () => {} } = {}) {
    if (!["none", "replay", "live"].includes(mode)) throw new TypeError(`Invalid recording mode: ${mode}`);
    if (mode === "live" && !integration) throw new EvalInconclusiveError("invalid_case_manifest", "Live external adapter requires explicit integration");
    this.mode = mode;
    this.fixture = fixture;
    this.runtimePath = runtimePath;
    this.integration = integration;
    this.liveAdapter = liveAdapter;
    this.onEvent = onEvent;
    this.records = null;
    this.sequence = 0;
    this.descriptor = { mode, fixture, mutation: "deny-by-default", integration };
  }

  async init() {
    if (this.mode === "replay") this.records = await loadRecordings(this.fixture);
    if (this.runtimePath) await ensureDir(dirname(this.runtimePath));
    return this;
  }

  async record(request, response) {
    const normalizedRequest = normalizeRequest(request);
    const record = { schema_version: SCHEMA_VERSION, stream_id: `recording-${normalizedRequest.system}`, seq: ++this.sequence, timestamp: new Date().toISOString(), request: normalizedRequest, response: normalizeResponse(response, `${normalizedRequest.system}.${normalizedRequest.operation}`) };
    if (this.runtimePath) await appendFile(this.runtimePath, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  async replay(request) {
    const normalizedRequest = normalizeRequest(request);
    const found = this.records?.find((record) => key(record.request) === key(normalizedRequest));
    if (!found) throw new EvalInconclusiveError("missing_external_recording", `Recording mismatch for ${normalizedRequest.system}.${normalizedRequest.operation}`, { request: normalizedRequest });
    await this.onEvent({ type: "external_replay", payload: { request: normalizedRequest, response: found.response } });
    await this.record(normalizedRequest, found.response);
    return found.response;
  }

  async execute(request) {
    const normalizedRequest = normalizeRequest(request);
    if (normalizedRequest.mutation) {
      await this.onEvent({ type: "unauthorized_external_mutation", payload: { request: normalizedRequest }, mode: "fail_fast" });
      throw new EvalInconclusiveError("unauthorized_external_mutation", `External mutation denied: ${normalizedRequest.system}.${normalizedRequest.operation}`, { request: normalizedRequest });
    }
    if (this.mode === "replay") return this.replay(normalizedRequest);
    if (this.mode === "live") {
      if (!this.integration || typeof this.liveAdapter !== "function") throw new EvalInconclusiveError("missing_external_recording", "Live adapter is not configured");
      const response = await this.liveAdapter(normalizedRequest);
      return this.record(normalizedRequest, response).then((record) => record.response);
    }
    const response = { ok: true, mode: "stub", system: normalizedRequest.system, operation: normalizedRequest.operation };
    await this.onEvent({ type: "external_stub", payload: { request: normalizedRequest, response } });
    return response;
  }
}

export class GitHubRecordingAdapter extends ExternalSystemPort {}
export class MCPRecordingAdapter extends ExternalSystemPort {}
