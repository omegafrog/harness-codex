import { spawn } from "node:child_process";
import { redact, expandCommand } from "./util.mjs";

const STRUCTURED_KINDS = new Set(["message", "tool_call", "tool_result", "process_event"]);
const STATUSES = new Set(["success", "error", "denied", "cancelled"]);

function normalizeStructured(value) {
  const kind = STRUCTURED_KINDS.has(value.kind) ? value.kind : STRUCTURED_KINDS.has(value.type) ? value.type : "message";
  const status = STATUSES.has(value.status) ? value.status : undefined;
  const record = {
    actor: ["codex", "harness", "external"].includes(value.actor) ? value.actor : "codex",
    kind,
    payload: redact(value.payload ?? value.data ?? value.message ?? {}),
    source: "structured_event",
  };
  for (const key of ["correlation_id", "action", "target"]) if (value[key] !== undefined) record[key] = redact(value[key]);
  if (status) record.status = status;
  if (kind === "message" && typeof record.payload === "string") record.payload = { text: record.payload };
  return record;
}

function splitLines(buffer) {
  const lines = buffer.split(/\r?\n/);
  return { lines: lines.slice(0, -1), remainder: lines.at(-1) || "" };
}

export class CodexProcessAdapter {
  constructor({ clock = () => new Date().toISOString(), killGraceMs = 500 } = {}) {
    this.clock = clock;
    this.killGraceMs = killGraceMs;
  }

  async run({ command, cwd, env = {}, stdin = null, timeoutMs = null, trajectory, onRecord = async () => {}, onEvent = async () => {}, caseId = "unknown", externalPort = null, permissionProfile = null, environmentProfile = null }) {
    const expandedCommand = expandCommand(command, { case_id: caseId });
    const startedAt = Date.now();
    const child = spawn(expandedCommand[0], expandedCommand.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let timedOut = false;
    let settled = false;
    let outputQueue = Promise.resolve();
    const records = [];
    const recordLine = async (line, source, stream) => {
      if (!line) return;
      let record;
      try {
        const parsed = JSON.parse(line);
        record = normalizeStructured(parsed);
      } catch {
        record = { actor: "codex", kind: "message", payload: { text: redact(line), stream }, source: "stdout_fallback" };
      }
      const normalized = await trajectory.append(record);
      records.push(normalized);
      await onRecord(normalized, { terminate });
    };
    const processOutput = async (chunk, source, stream) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") stdout += text;
      else stderr += text;
      const split = splitLines(source === "stdout" ? stdoutBuffer + text : stderrBuffer + text);
      if (source === "stdout") stdoutBuffer = split.remainder;
      else stderrBuffer = split.remainder;
      for (const line of split.lines) await recordLine(line, source, stream);
    };
    const terminate = () => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, this.killGraceMs).unref();
    };
    const emitProcessEvent = async (event) => {
      await trajectory.append({ actor: "harness", kind: "process_event", action: event.type, payload: event.payload, source: "structured_event" });
      await onEvent(event);
    };
    await emitProcessEvent({ type: "process_started", payload: { command: expandedCommand, cwd }, timestamp: this.clock() });
    child.stdout.on("data", (chunk) => { outputQueue = outputQueue.then(() => processOutput(chunk, "stdout", "stdout")).catch(() => terminate()); });
    child.stderr.on("data", (chunk) => { outputQueue = outputQueue.then(() => processOutput(chunk, "stderr", "stderr")).catch(() => terminate()); });
    if (stdin !== null && stdin !== undefined) child.stdin.write(`${stdin}\n`);
    child.stdin.end();
    let timeout;
    if (timeoutMs) timeout = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const result = await new Promise((resolve) => {
      let processError = null;
      child.once("error", (error) => { processError = error; });
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal, processError }));
    });
    settled = true;
    if (timeout) clearTimeout(timeout);
    await outputQueue;
    if (stdoutBuffer) await recordLine(stdoutBuffer, "stdout", "stdout");
    if (stderrBuffer) await recordLine(stderrBuffer, "stderr", "stderr");
    const durationMs = Date.now() - startedAt;
    const status = timedOut ? "cancelled" : result.processError ? "error" : result.exitCode === 0 ? "success" : "error";
    await emitProcessEvent({ type: "process_exited", payload: { exit_code: result.exitCode, signal: result.signal, status, duration_ms: durationMs }, timestamp: this.clock() });
    return {
      command: expandedCommand,
      cwd,
      exitCode: result.exitCode,
      signal: result.signal,
      processError: result.processError,
      timedOut,
      durationMs,
      stdout: redact(stdout),
      stderr: redact(stderr),
      finalOutput: redact(records.filter((record) => record.kind === "message").map((record) => record.payload?.text || record.payload).join("\n") || stdout),
      records,
      snapshot: {
        command: expandedCommand,
        cwd,
        model: env.HARNESS_EVAL_MODEL || null,
        model_config: env.HARNESS_EVAL_MODEL_CONFIG || null,
        permission_profile: permissionProfile || env.HARNESS_EVAL_PERMISSION_PROFILE || null,
        environment_profile: environmentProfile || env.HARNESS_EVAL_ENVIRONMENT_PROFILE || null,
        external_port: externalPort?.descriptor || null,
      },
    };
  }
}

export function resolveCodexCommand({ caseSpec, config, commandOverride = null }) {
  if (commandOverride) return commandOverride;
  return caseSpec.environment?.codex?.command || config.eval.codex?.command || ["codex", "exec", "--json"];
}
