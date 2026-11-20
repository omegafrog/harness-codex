import { execFile } from 'node:child_process';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { readClaim, readSource } from '../knowledge/registry.mjs';
import { readContextDesign, sections } from './domain-model-gate.mjs';
import { LEGACY_TACTICAL_DESIGN_DOCUMENT, PRE_SPEC_STAGES, TACTICAL_DESIGN_DOCUMENT, TACTICAL_DESIGN_STAGES } from './worktree-stages.mjs';

const git = async (root, ...args) => (await promisify(execFile)('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
const PROTECTED_PATH = /^(?:\.git|\.io)(?:\/|$)/;

function validPath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.startsWith(':')
    && !path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') && !PROTECTED_PATH.test(path);
}

// Codex sandbox는 어떤 설정으로도 .git 쓰기를 허용하지 않으므로 구현 커밋은 sandbox 밖의 실행기가 맡는다.
export async function commitStageRequest({ root, rawPath }) {
  const envelope = JSON.parse(await readFile(rawPath, 'utf8'));
  const result = envelope.result;
  const request = result?.commit_request;
  if (!request) return null;
  if (typeof request.message !== 'string' || !request.message.trim()) throw new Error('Commit request needs a message');
  if (!Array.isArray(request.paths) || !request.paths.length || !request.paths.every(validPath)) throw new Error('Commit request paths must be workspace-relative source paths');
  await git(root, 'add', '--', ...request.paths);
  const staged = (await git(root, 'diff', '--cached', '--name-only')).split('\n').filter(Boolean);
  const unrequested = staged.filter((path) => !request.paths.some((item) => path === item || path.startsWith(`${item}/`)));
  if (unrequested.length) throw new Error(`Index already holds files outside the commit request: ${unrequested.join(', ')}`);
  if (!staged.length) throw new Error('Commit request has no changes to commit');
  await git(root, 'commit', '-m', request.message);
  result.commit_sha = await git(root, 'rev-parse', 'HEAD');
  await writeFile(rawPath, JSON.stringify(envelope));
  return result.commit_sha;
}

// Specs and plans are the review basis of the implementation, so they are committed when the stage that owns them
// completes; reviewers then read them in the history like the code, and no stage or orchestrator stages them by hand.
// Other staged files are left as they are: the commit names only the stage's own paths.
// The requirements stages write the plan set's documents; bounded-context settles the map and glossary scope,
// and ubiquitous-language settles the glossary. The tactical design stages may add terms to the glossary.
const TACTICAL_PROJECT_DOCUMENTS = ['CONTEXT.md'];
const PROJECT_DOCUMENTS = {
  'bounded-context': ['CONTEXT-MAP.md', 'CONTEXT.md'],
  'ubiquitous-language': ['CONTEXT.md'],
  ...Object.fromEntries(TACTICAL_DESIGN_STAGES.map((skill) => [skill, [...TACTICAL_PROJECT_DOCUMENTS, ...(skill === 'context-boundary' ? ['CONTEXT-MAP.md'] : [])]])),
};
// Project documents a stage commits only when it names them as artifacts of its result. The project edits them for its
// own reasons too, so a stage that did not report touching one never sweeps its changes into a commit.
const LISTED_PROJECT_DOCUMENTS = {
  'bounded-context': ['CONTEXT.md'],
  ...Object.fromEntries(TACTICAL_DESIGN_STAGES.map((skill) => [skill, [...TACTICAL_PROJECT_DOCUMENTS, ...(skill === 'context-boundary' ? ['CONTEXT-MAP.md'] : [])]])),
};
const TACTICAL_IMPLEMENTATION_DOCUMENTS = {
  'tactical-technology': (id) => [`docs/implementation/${id}/technology.md`, '.harness/agents/EXEC.md'],
  'tactical-api': (id) => [`docs/implementation/${id}/api.md`],
  'tactical-data': (id) => [`docs/implementation/${id}/data.md`],
};
const DECISION_EVIDENCE_STAGES = new Set([...PRE_SPEC_STAGES, ...Object.keys(TACTICAL_IMPLEMENTATION_DOCUMENTS)]);
const KNOWLEDGE_ARTIFACT_PATHS = new Map([
  ['knowledge_source', /^knowledge\/sources\/([A-Za-z0-9][A-Za-z0-9._-]*)\.yaml$/],
  ['knowledge_claim', /^knowledge\/claims\/([A-Za-z0-9][A-Za-z0-9._-]*)\.yaml$/],
]);

async function decisionEvidencePaths(root, artifacts) {
  const sources = new Set();
  const claims = new Set();
  for (const { base, kind, path } of artifacts) {
    const pattern = KNOWLEDGE_ARTIFACT_PATHS.get(kind);
    if (base !== 'workspace' || !pattern) continue;
    const match = typeof path === 'string' && pattern.exec(path);
    if (!match || match[0] !== path) throw new Error(`Invalid ${kind} artifact path: ${path}`);
    (kind === 'knowledge_source' ? sources : claims).add(match[1]);
  }
  const paths = [
    ...[...sources].map((id) => `knowledge/sources/${id}.yaml`),
    ...[...claims].map((id) => `knowledge/claims/${id}.yaml`),
  ];
  if (!paths.length) return paths;
  if (await git(root, 'diff', '--cached', '--no-renames', '--name-only', '--', ...paths)) {
    throw new Error('Decision evidence paths already have staged changes');
  }
  const ignored = (await git(root, 'status', '--porcelain', '-z', '--ignored', '--untracked-files=all', '--', ...paths))
    .split('\0').find((entry) => entry.startsWith('!! '));
  if (ignored) throw new Error(`Decision evidence path is ignored by Git: ${ignored.slice(3)}`);

  for (const sourceId of sources) await readSource({ root, sourceId });
  for (const claimId of claims) {
    const claim = await readClaim({ root, claimId });
    if (sources.has(claim.source_id)) continue;
    const sourcePath = `knowledge/sources/${claim.source_id}.yaml`;
    const committed = /^(?:100644|100755) blob ([a-f0-9]+)\t/.exec(await git(root, 'ls-tree', 'HEAD', '--', sourcePath));
    if (!committed || committed[1] !== await git(root, 'hash-object', '--', sourcePath)) {
      throw new Error(`Claim ${claimId} requires ${sourcePath} in HEAD or as a knowledge_source artifact in the same commit`);
    }
  }
  return paths;
}

const stageDocuments = (skill, id) => TACTICAL_IMPLEMENTATION_DOCUMENTS[skill]?.(id) || [`docs/specs/${id}`, ...(PROJECT_DOCUMENTS[skill] || [])];
const WORKFLOW_DOCUMENTS = {
  ...Object.fromEntries(PRE_SPEC_STAGES.map((skill) => [skill, (id) => stageDocuments(skill, id)])),
  ...TACTICAL_IMPLEMENTATION_DOCUMENTS,
  'to-ticket': (id) => [`docs/plans/${id}`],
  'sync-contracts': () => ['docs/contracts'],
};

// The plan set's tactical design document under its current and its legacy name (see migrateLegacyTacticalDesign).
const tacticalDesignDocuments = (planSetId) => [`docs/specs/${planSetId}/${TACTICAL_DESIGN_DOCUMENT}`, `docs/specs/${planSetId}/${LEGACY_TACTICAL_DESIGN_DOCUMENT}`];
export const isTacticalClassDiagram = (path, planSetId) => {
  const scope = `docs/specs/${planSetId}/diagrams/`;
  return path.startsWith(scope) && /^[a-z0-9]+(?:-[a-z0-9]+)*\.class\.(?:puml|svg)$/.test(path.slice(scope.length));
};
const decisionDocument = /^docs\/adr\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

export async function assertTacticalRequirementsReadOnly(root, input) {
  const planSetId = input?.context?.plan_set_id;
  if (!TACTICAL_DESIGN_STAGES.includes(input?.skill) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planSetId || '')) return;
  const requirements = `docs/specs/${planSetId}/requirements.md`;
  if (!await git(root, 'status', '--porcelain', '--untracked-files=all', '--', requirements)) return;
  const documents = [];
  for (const path of tacticalDesignDocuments(planSetId)) {
    await assertWorkspaceTarget(root, path);
    documents.push(await git(root, 'show', `HEAD:${path}`).catch(() => ''),
      await readFile(join(root, path), 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error)));
  }
  // An already-started numbered design keeps the deepening behavior of its original workflow.
  if (!documents.some((text) => readContextDesign(text) !== null) && documents.some((text) => Object.keys(sections(text)).length)) return;
  throw new Error(`Tactical design reads ${requirements} as fixed input. Return the requirement change to requirements-fix; workspace changes were preserved.`);
}

// What a restart of the stage restores. Requirement stages own the whole plan set. A tactical stage owns only the tactical
// design documents: the rules that its iterative deepening added to requirements.md are the user's decisions and stay.
// The legacy name is restored too: a checkpoint from before the runner renamed it holds the document under that name, and
// the rename itself is one of the changes between the checkpoint and HEAD.
export const restartDocuments = (stageId, planSetId) => TACTICAL_DESIGN_STAGES.includes(stageId)
  ? [...tacticalDesignDocuments(planSetId), ...TACTICAL_PROJECT_DOCUMENTS, 'CONTEXT-MAP.md']
  : [...new Set(PRE_SPEC_STAGES.flatMap((skill) => stageDocuments(skill, planSetId)))];

// A plan set that an earlier Harness started keeps its tactical design under the legacy name `domain-model.md`, which a
// user instruction about the `domain-model` stage can be mistaken for. The runner renames it to `tactical-design.md` with
// `git mv` when a tactical stage input is prepared and before the stage runs: the index records the rename, so history
// follows the file, and the next tactical stage commit takes it together with the stage's own edits. Nothing happens
// when the plan set has no legacy document or already has the current one.
export async function migrateLegacyTacticalDesign({ root, planSetId }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planSetId || '')) throw new Error('Invalid plan_set_id');
  const [current, legacy] = tacticalDesignDocuments(planSetId);
  for (const path of [legacy, current]) await assertWorkspaceTarget(root, path);
  const stat = (path) => lstat(join(root, path)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const legacyInfo = await stat(legacy);
  if (!legacyInfo || await stat(current)) return null;
  if (!legacyInfo.isFile() || legacyInfo.isSymbolicLink()) throw new Error(`${legacy} must be a regular file`);
  const indexed = async (path) => Boolean(await git(root, 'ls-files', '--', path));
  if (await indexed(legacy) && !await indexed(current)) await git(root, 'mv', '--', legacy, current);
  else {
    // The index does not hold the legacy document in this shape (a restart restored it into the working tree only), so the
    // file moves alone and the stage commit sees the difference from HEAD as it does for any document of the stage.
    await rename(join(root, legacy), join(root, current));
    if (await indexed(legacy)) await git(root, 'rm', '--cached', '--quiet', '--', legacy);
  }
  return { from: legacy, to: current };
}

// True while HEAD holds the plan set's tactical design only under the legacy name: the rename is not committed yet.
async function legacyRenamePending(root, planSetId) {
  const [current, legacy] = tacticalDesignDocuments(planSetId);
  const inHead = async (path) => Boolean(await git(root, 'ls-tree', '--name-only', 'HEAD', '--', path));
  return await inHead(legacy) && !await inHead(current);
}

export async function commitWorkflowDocuments({ root, input, rawPath, domainPaths = [] }) {
  const owned = WORKFLOW_DOCUMENTS[input?.skill];
  const planSetId = input?.context?.plan_set_id;
  if (!owned || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planSetId || '')) return null;
  await assertTacticalRequirementsReadOnly(root, input);
  const envelope = JSON.parse(await readFile(rawPath, 'utf8'));
  // A tactical stage that stops because a rule it added to requirements.md invalidates an earlier stage keeps that rule
  // committed, so the tree is clean for the restart that reopens the earlier stage and the rule survives it.
  const tactical = TACTICAL_DESIGN_STAGES.includes(input.skill);
  const deepening = tactical && envelope.status === 'blocked' && envelope.code === 'DEPENDENCY_INCOMPLETE';
  const decisionStage = DECISION_EVIDENCE_STAGES.has(input.skill);
  const decisionQuestion = decisionStage && envelope.status === 'action_required' && envelope.code === 'USER_DECISION_REQUIRED';
  if (envelope.status !== 'completed' && !deepening && !decisionQuestion) return null;
  // The rename the runner made before this stage ran is part of the same clean-tree guarantee: the restart needs it committed.
  const renamed = deepening && await legacyRenamePending(root, planSetId) ? tacticalDesignDocuments(planSetId) : [];
  const requirements = `docs/specs/${planSetId}/requirements.md`;
  const reportedArtifacts = envelope.result?.artifacts || [];
  const artifacts = new Set(reportedArtifacts.filter((item) => item.base === 'workspace' && typeof item.path === 'string').map((item) => item.path));
  const evidencePaths = !deepening && decisionStage ? await decisionEvidencePaths(root, reportedArtifacts) : [];
  // A question may cite registry entries before the user settles the decision. Only the registry entries are ready to commit.
  if (decisionQuestion && !evidencePaths.length) return null;
  const syncPaths = decisionQuestion ? [] : domainPaths;
  const paths = (decisionQuestion ? [] : deepening ? [requirements, ...renamed]
    : tactical ? [requirements, ...tacticalDesignDocuments(planSetId), ...PROJECT_DOCUMENTS[input.skill]]
      : owned(planSetId)).filter((path) => !LISTED_PROJECT_DOCUMENTS[input.skill]?.includes(path) || artifacts.has(path));
  if (tactical && envelope.status === 'completed') {
    for (const path of artifacts) {
      if (!decisionDocument.test(path) && !(input.skill === 'aggregate-design' && isTacticalClassDiagram(path, planSetId))) continue;
      await assertWorkspaceTarget(root, path);
      if (!(await lstat(join(root, path))).isFile()) throw new Error(`Tactical artifact must be a regular file: ${path}`);
      paths.push(path);
    }
  }
  if (syncPaths.length && await git(root, 'diff', '--cached', '--name-only', '--', ...syncPaths)) {
    throw new Error('Domain sync paths already have staged changes');
  }
  paths.push(...syncPaths, ...evidencePaths);
  const changed = (await git(root, 'status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths)).split('\0').filter(Boolean);
  if (!changed.length) return null;
  // `present` is staged as the working tree has it. A document that already left both the working tree and the index (the
  // legacy name after the runner renamed it) is only in HEAD: it is not staged again but still belongs to the commit.
  const present = [];
  const departed = [];
  for (const path of paths) {
    if (existsSync(join(root, path)) || await git(root, 'ls-files', '--', path)) present.push(path);
    else if (await git(root, 'ls-tree', '--name-only', 'HEAD', '--', path)) departed.push(path);
  }
  try {
    if (present.length) await git(root, 'add', '-A', '--', ...present);
    // A pathspec commit takes only these documents; anything else in the index stays staged for its owner.
    await git(root, 'commit', '-m', `${input.skill}: ${planSetId}`, '--', ...present, ...departed);
  } catch (error) {
    if (syncPaths.length || evidencePaths.length) await git(root, 'reset', '-q', 'HEAD', '--', ...syncPaths, ...evidencePaths);
    throw error;
  }
  return git(root, 'rev-parse', 'HEAD');
}
