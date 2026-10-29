const DECISIONS = new Set(["allowed", "denied"]);

function normalizeNativePermission(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Native permission result must be an object");
  const decision = value.decision || value.status;
  if (!DECISIONS.has(decision)) throw new TypeError("Native permission result must have an allowed or denied decision");
  if (value.action !== undefined && typeof value.action !== "string") throw new TypeError("Native permission action must be a string");
  if (value.target !== undefined && typeof value.target !== "string") throw new TypeError("Native permission target must be a string");
  if (value.evidence_path !== undefined && value.evidence_path !== null && typeof value.evidence_path !== "string") throw new TypeError("Native permission evidence_path must be a string");
  return {
    decision,
    action: value.action || null,
    target: value.target || null,
    evidence_path: value.evidence_path || null,
  };
}

/** Persist native permission evidence independently from workflow gate verdicts. */
export async function recordNativePermissionResult({ result, eventWriter } = {}) {
  const normalized = normalizeNativePermission(result);
  if (!eventWriter || typeof eventWriter.append !== "function") throw new TypeError("eventWriter with append() is required for native permission evidence");
  const type = normalized.decision === "denied" ? "native_permission_denied" : "native_permission_result";
  const event = await eventWriter.append(type, normalized, { critical: true });
  return {
    ...normalized,
    recorded: true,
    ...(Number.isInteger(event?.seq) ? { event_seq: event.seq } : {}),
  };
}
