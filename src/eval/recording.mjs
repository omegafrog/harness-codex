import { open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EvalInconclusiveError, EvalPolicyViolationError } from "./errors.mjs";
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
const READ_ONLY_OPERATIONS = new Set([
  "read_issue",
  "read_pull_request",
  "read_context",
  "read_file",
  "get_status",
  "list_issues",
  "list_pull_requests",
  "search_issues",
  "search_pull_requests",
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
  const inferredMutation = MUTATING_OPERATIONS.has(request.operation) || !READ_ONLY_OPERATIONS.has(request.operation);
  normalized.mutation = inferredMutation || request.mutation === true;
  if (typeof normalized.system !== "string" || typeof normalized.operation !== "string") throw new TypeError("External request needs system and operation");
  return redact(normalized);
}

function key(value) {
  return JSON.stringify(canonicalJson(value));
}

function isNormalizedJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isNormalizedJson);
  if (value && typeof value === "object") return Object.values(value).every(isNormalizedJson);
  return false;
}

function normalizeResponse(response, context) {
  if (!isNormalizedJson(response)) throw new EvalInconclusiveError("corrupted_external_response", `External response is not normalized JSON: ${context}`);
  return redact(response);
}

function matchesTarget(policyTarget, requestTarget) {
  if (!policyTarget || typeof policyTarget !== "object" || Array.isArray(policyTarget)
    || !requestTarget || typeof requestTarget !== "object" || Array.isArray(requestTarget)) return false;
  return Object.entries(policyTarget).every(([key, value]) => {
    if (!(key in requestTarget)) return false;
    if (value && typeof value === "object" && !Array.isArray(value)) return matchesTarget(value, requestTarget[key]);
    return requestTarget[key] === value;
  });
}

function isDedicatedIntegrationRequest(request, resource) {
  return resource?.dedicated === true
    && typeof resource.system === "string"
    && typeof resource.resource_id === "string"
    && resource.resource_id.length > 0
    && request.system === resource.system
    && matchesTarget(resource.target, request.target);
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
      let normalizedRequest;
      try {
        normalizedRequest = normalizeRequest(record.request);
      } catch (error) {
        throw new EvalInconclusiveError("corrupted_fixture", `Invalid recording request at line ${index + 1}`, { path, cause: error });
      }
      records.push({ request: normalizedRequest, response: normalizeResponse(record.response, `recording line ${index + 1}`) });
      expectedSeq += 1;
    }
  } catch (error) {
    if (error.code === "ENOENT") throw new EvalInconclusiveError("missing_external_recording", `Recording not found: ${path}`, { path });
    throw error;
  }
  return records;
}

export class ExternalSystemPort {
  constructor({ mode = "none", fixture = null, runtimePath = null, integration = false, integrationResource = null, liveAdapter = null, onEvent = () => {} } = {}) {
    if (!["none", "replay", "live"].includes(mode)) throw new TypeError(`Invalid recording mode: ${mode}`);
    if (mode === "live" && !integration) throw new EvalInconclusiveError("invalid_case_manifest", "Live external adapter requires explicit integration");
    if (mode === "live" && integration && (!integrationResource || integrationResource.dedicated !== true || typeof integrationResource.resource_id !== "string" || !integrationResource.resource_id || typeof integrationResource.system !== "string" || !integrationResource.system || !integrationResource.target || typeof integrationResource.target !== "object" || Array.isArray(integrationResource.target) || Object.keys(integrationResource.target).length === 0)) throw new EvalInconclusiveError("invalid_case_manifest", "Live integration requires a dedicated integration resource");
    this.mode = mode;
    this.fixture = fixture;
    this.runtimePath = runtimePath;
    this.integration = integration;
    this.integrationResource = integrationResource;
    this.liveAdapter = liveAdapter;
    this.onEvent = onEvent;
    this.records = null;
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.descriptor = { mode, fixture, mutation: "deny-by-default", integration, integration_resource: integrationResource };
  }

  async init() {
    if (this.mode === "replay") this.records = await loadRecordings(this.fixture);
    if (this.runtimePath) await ensureDir(dirname(this.runtimePath));
    return this;
  }

  record(request, response) {
    this.queue = this.queue.then(async () => {
      const normalizedRequest = normalizeRequest(request);
      const record = { schema_version: SCHEMA_VERSION, stream_id: "recording", seq: ++this.sequence, timestamp: new Date().toISOString(), request: normalizedRequest, response: normalizeResponse(response, `${normalizedRequest.system}.${normalizedRequest.operation}`) };
      if (this.runtimePath) {
        const handle = await open(this.runtimePath, "a");
        try {
          await handle.write(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        const directory = await open(dirname(this.runtimePath), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      return record;
    });
    return this.queue;
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
    const liveResourceRequest = this.mode !== "live"
      || !this.integration
      || isDedicatedIntegrationRequest(normalizedRequest, this.integrationResource);
    if (!liveResourceRequest) {
      const reason = normalizedRequest.mutation ? "unauthorized_external_mutation" : "security_boundary_violation";
      await this.onEvent({ type: "unauthorized_external_access", payload: { request: normalizedRequest, reason }, mode: "fail_fast" });
      throw new EvalPolicyViolationError(reason, `External request is outside the dedicated integration resource: ${normalizedRequest.system}.${normalizedRequest.operation}`, { request: normalizedRequest });
    }
    if (normalizedRequest.mutation && !(this.mode === "live" && this.integration)) {
      await this.onEvent({ type: "unauthorized_external_mutation", payload: { request: normalizedRequest }, mode: "fail_fast" });
      throw new EvalPolicyViolationError("unauthorized_external_mutation", `External mutation denied: ${normalizedRequest.system}.${normalizedRequest.operation}`, { request: normalizedRequest });
    }
    if (this.mode === "replay") return this.replay(normalizedRequest);
    if (this.mode === "live") {
      if (!this.integration || typeof this.liveAdapter !== "function") throw new EvalInconclusiveError("missing_external_recording", "Live adapter is not configured");
      const response = await this.liveAdapter(normalizedRequest);
      return this.record(normalizedRequest, response).then((record) => record.response);
    }
    const response = { ok: true, mode: "stub", system: normalizedRequest.system, operation: normalizedRequest.operation };
    await this.onEvent({ type: "external_stub", payload: { request: normalizedRequest, response } });
    const record = await this.record(normalizedRequest, response);
    return record.response;
  }
}

class SystemScopedAdapter extends ExternalSystemPort {
  constructor(system, options = {}) {
    super(options);
    this.system = system;
  }

  normalizeSystemRequest(request) {
    const normalized = normalizeRequest(request);
    if (normalized.system !== this.system) throw new EvalInconclusiveError("external_system_mismatch", `Adapter ${this.system} cannot handle ${normalized.system}`);
    return normalized;
  }

  async execute(request) {
    return super.execute(this.normalizeSystemRequest(request));
  }

  async record(request, response) {
    return super.record(this.normalizeSystemRequest(request), response);
  }

  async replay(request) {
    return super.replay(this.normalizeSystemRequest(request));
  }
}

export class GitHubStub extends SystemScopedAdapter {
  constructor(options = {}) {
    super("github", { ...options, mode: "none" });
  }
}

export class MCPStub extends SystemScopedAdapter {
  constructor(options = {}) {
    super("mcp", { ...options, mode: "none" });
  }
}

export class GitHubRecordingAdapter extends SystemScopedAdapter {
  constructor(options = {}) {
    super("github", options);
  }
}

export class MCPRecordingAdapter extends SystemScopedAdapter {
  constructor(options = {}) {
    super("mcp", options);
  }
}

export class ExplicitIntegrationAdapter extends SystemScopedAdapter {
  constructor(options = {}) {
    const system = options.system || options.integrationResource?.system;
    if (typeof system !== "string" || !system) throw new TypeError("Explicit integration adapter requires a system");
    super(system, { ...options, mode: "live", integration: true });
  }
}
