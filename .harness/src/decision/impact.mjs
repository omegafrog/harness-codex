import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { readArchitectureDecision, readSystemTargets, writeArchitectureDecision } from "./artifacts.mjs";
import { readPrinciple } from "../knowledge/registry.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Mark every existing decision that cites a deprecated Principle; keep its decision history intact. */
export async function markDeprecatedPrincipleImpacts({ root = process.cwd(), principleId } = {}) {
  if (typeof principleId !== "string" || !SAFE_ID.test(principleId)) throw new TypeError("Principle ID must be a safe identifier.");
  const principle = await readPrinciple({ root, principleId });
  if (principle.status !== "deprecated") throw new TypeError(`Only a deprecated Principle can trigger Decision impact marking; ${principleId} is ${principle.status}.`);
  const specsRoot = resolve(root, "docs", "specs");
  const tickets = await readdir(specsRoot, { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const affected = [];
  for (const ticket of tickets.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const targets = await readSystemTargets({ root, ticketId: ticket.name }).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!targets) continue;
    const targetIds = [...targets.initial, ...targets.expected_growth, ...targets.architecture_boundary].map(({ id }) => id);
    const decisionDirectory = resolve(specsRoot, ticket.name, "architecture-decisions");
    const entries = await readdir(decisionDirectory, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
    for (const entry of entries.filter((value) => value.isFile() && value.name.endsWith(".yaml")).sort((a, b) => a.name.localeCompare(b.name))) {
      const decisionId = entry.name.slice(0, -5);
      if (!SAFE_ID.test(decisionId)) throw new TypeError(`Unsafe Decision filename in ${ticket.name}: ${entry.name}`);
      const decision = await readArchitectureDecision({ root, ticketId: ticket.name, decisionId, refs: { targetIds } });
      if (!(decision.principle_ids ?? []).includes(principleId)) continue;
      const flag = `deprecated-principle:${principleId}`;
      const flags = [...new Set([...(decision.review_flags ?? []), flag])];
      affected.push({ ticketId: ticket.name, decisionId, decision: { ...decision, review_required: true, review_flags: flags } });
    }
  }
  const results = [];
  for (const { ticketId, decisionId, decision } of affected) {
    await writeArchitectureDecision({ root, ticketId, decision });
    results.push({ ticketId, decisionId, review_required: true });
  }
  return results;
}
