function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function changedFields(base, value) {
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(value ?? {})]);
  return [...keys].filter((key) => canonicalJson(base?.[key]) !== canonicalJson(value?.[key])).sort();
}

/** Report divergent same-ID three-way edits without choosing a side or exposing object content. */
export function compareKnowledgeMerge(base, ours, theirs) {
  for (const value of [base, ours, theirs]) {
    if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
      throw new TypeError("Knowledge merge versions must be objects or null.");
    }
  }
  const versions = [base, ours, theirs].filter((value) => value != null);
  if (versions.length === 0) return [];
  const ids = new Set(versions.map(({ id }) => id));
  if (ids.size !== 1 || typeof versions[0].id !== "string") throw new TypeError("Knowledge merge versions must have the same stable ID.");
  const baseJson = canonicalJson(base ?? null);
  const oursJson = canonicalJson(ours ?? null);
  const theirsJson = canonicalJson(theirs ?? null);
  if (oursJson === theirsJson || oursJson === baseJson || theirsJson === baseJson) return [];
  const fields = [...new Set([...changedFields(base ?? {}, ours ?? {}), ...changedFields(base ?? {}, theirs ?? {})])].sort();
  return [{ id: versions[0].id, code: "same_id_divergent_merge", fields }];
}
