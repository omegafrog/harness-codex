#!/usr/bin/env node
import { resolve } from "node:path";

import { approveEvidenceSummary, importEvidence, publishEvidenceSummary, readStagedEvidence, rejectEvidenceSummary, stageEvidenceSummary } from "../../src/knowledge/evidence.mjs";
import { approvePrinciple, readClaim, readEvidence, readPrinciple, readSource, recordPrincipleReview, transitionPrinciple, writeClaim, writePrinciple, writeSource } from "../../src/knowledge/registry.mjs";
import { assessPrincipleEvidence, evaluateSource, synthesizePrinciple } from "../../src/knowledge/research.mjs";
import { validateClaim, validateEvidence, validatePrinciple, validateSource } from "../../src/knowledge/validation.mjs";

function usage() {
  return "Usage: harness-knowledge.mjs source|claim|principle|evidence <action> [--json JSON] [--id ID] [--root PATH]";
}

function parseArgs(args) {
  const result = { positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${arg}`);
      const key = arg.slice(2).replaceAll("-", "_");
      if (!new Set(["json", "id", "root", "actor", "actor_role", "at", "reason"]).has(key)) throw new TypeError(`Unsupported option: ${arg}`);
      result[key] = value;
      index += 1;
    } else result.positionals.push(arg);
  }
  return result;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [kind, action, ...rest] = options.positionals;
  if (rest.length || !["source", "claim", "principle", "evidence"].includes(kind) || !["validate", "evaluate", "save", "show", "review", "approve", "deprecate", "publish", "import", "stage", "reject"].includes(action)) throw new TypeError(usage());
  if (options.root) options.root = resolve(options.root);

  if (kind === "evidence") {
    if (action === "validate") {
      if (!options.json) throw new TypeError("validate requires --json");
      const result = validateEvidence(JSON.parse(options.json));
      emit(result);
      if (!result.valid) process.exitCode = 1;
      return;
    }
    if (action === "import") {
      if (!options.json) throw new TypeError("import requires --json");
      return emit(await importEvidence({ root: options.root, input: JSON.parse(options.json), at: options.at }));
    }
    if (action === "stage") {
      if (!options.id || !options.json) throw new TypeError("stage requires --id and --json");
      const summary = JSON.parse(options.json);
      return emit(await stageEvidenceSummary({ root: options.root, evidenceId: options.id, summary: summary.summary, actor: options.actor, at: options.at }));
    }
    if (!options.id) throw new TypeError(`${action} requires --id`);
    if (action === "show") {
      try {
        return emit(await readStagedEvidence({ root: options.root, evidenceId: options.id }));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return emit(await readEvidence({ root: options.root, evidenceId: options.id }));
      }
    }
    if (action === "approve") return emit(await approveEvidenceSummary({ root: options.root, evidenceId: options.id, actor: options.actor, actorRole: options.actor_role, at: options.at }));
    if (action === "reject") return emit(await rejectEvidenceSummary({ root: options.root, evidenceId: options.id, actor: options.actor, reason: options.reason, at: options.at }));
    if (action === "publish") return emit(await publishEvidenceSummary({ root: options.root, evidenceId: options.id }));
    throw new TypeError(`${action} is not supported for Evidence`);
  }

  if (action === "validate" || action === "evaluate") {
    if (!options.json) throw new TypeError(`${action} requires --json`);
    const object = JSON.parse(options.json);
    if (kind === "source" && action === "evaluate") return emit(evaluateSource(object));
    if (kind === "principle" && action === "evaluate") {
      const assessment = assessPrincipleEvidence({ principle: object.principle, claims: object.claims, sources: object.sources, minimum_independent_authorities: object.minimum_independent_authorities });
      emit(assessment);
      if (!assessment.approval_ready) process.exitCode = 1;
      return;
    }
    if (action === "evaluate") throw new TypeError(`${kind} evaluation is unsupported`);
    const result = kind === "source" ? validateSource(object) : kind === "claim" ? validateClaim(object) : validatePrinciple(object);
    emit(result);
    if (!result.valid) process.exitCode = 1;
    return;
  }

  if (action === "save") {
    if (!options.json) throw new TypeError("save requires --json");
    const object = JSON.parse(options.json);
    if (kind === "source") return emit(await writeSource({ root: options.root, source: object }));
    if (kind === "principle") return emit(await writePrinciple({ root: options.root, principle: synthesizePrinciple(object) }));
    const source = await readSource({ root: options.root, sourceId: object.source_id });
    return emit(await writeClaim({ root: options.root, claim: object, refs: { sourceIds: [source.id] } }));
  }

  if (!options.id && !options.json) throw new TypeError(`${action} requires --id`);
  if (kind === "principle" && action === "review") {
    const review = JSON.parse(options.json ?? "{}");
    return emit(await recordPrincipleReview({ root: options.root, principleId: options.id, review, at: options.at ?? new Date().toISOString() }));
  }
  if (kind === "principle" && action === "approve") return emit(await approvePrinciple({ root: options.root, principleId: options.id, actor: { role: options.actor_role, id: options.actor }, at: options.at }));
  if (kind === "principle" && action === "deprecate") return emit(await transitionPrinciple({ root: options.root, principleId: options.id, to: "deprecated", actor: options.actor, at: options.at, reason: options.reason }));
  if (kind === "principle" && (action === "show" || action === "publish")) {
    const principle = await readPrinciple({ root: options.root, principleId: options.id });
    if (action === "publish" && principle.status !== "approved") throw new TypeError("Only an approved, hash-valid Principle can be published.");
    return emit(principle);
  }
  if (kind === "principle") throw new TypeError(`${action} is not supported for Principle`);
  if (!options.id) throw new TypeError("show requires --id");
  if (kind === "source") return emit(await readSource({ root: options.root, sourceId: options.id }));
  return emit(await readClaim({ root: options.root, claimId: options.id }));
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.diagnostic ? JSON.stringify({ error: error.message, diagnostic: error.diagnostic }) : error.message}\n`);
  process.exitCode = 1;
}
