import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { parseYaml } from '../eval/yaml.mjs';
import { providerAgents } from './agent-config.mjs';
import { modelBelongsToProvider } from './providers/index.mjs';
import { sessionOutputPath } from './session-output.mjs';
import { REQUIREMENTS_STAGES, TACTICAL_DESIGN_STAGES, TACTICAL_DESIGN_DOCUMENT, LEGACY_TACTICAL_DESIGN_DOCUMENT } from './worktree-stages.mjs';

const digest = (content) => createHash('sha256').update(content).digest('hex');
const executionPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const planSetPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const stageWriterProfile = 'stage_document_writer';
const maxFileBytes = 4 * 1024 * 1024;
const maxBatchBytes = 16 * 1024 * 1024;
const maxFiles = 128;
const reviewSkills = new Set(['to-ticket', 'sync-contracts']);
const generatedContractPath = (path) => ['docs/contracts/manifest.json', 'docs/contracts/architecture.html'].includes(path);
const issueDraftPath = /^runtime\/to-ticket\/drafts\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

function draftRef(executionId) {
  if (!executionPattern.test(executionId || '')) throw new Error('Invalid document draft execution ID');
  return `runtime/executions/${executionId}/document-drafts`;
}

export function documentDraftRoot(root, executionId) {
  return join(root, '.io', draftRef(executionId), 'workspace');
}

export function contractDocumentOutputRoot(root, executionId) {
  return join(root, '.io', draftRef(executionId), 'generated');
}

const composedRef = (executionId) => `${draftRef(executionId)}/composition`;

function safeRelative(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || /[\u0000-\u001f]/.test(path)
      || path.split('/').some((part) => part === '' || part === '.' || part === '..')) throw new Error(`Invalid stage document path: ${path}`);
  return path;
}

async function fileInfo(path) {
  return lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
}

async function regularFile(base, path) {
  const parts = safeRelative(path).split('/');
  let target = base;
  for (const [index, part] of parts.entries()) {
    target = join(target, part);
    const info = await fileInfo(target);
    if (!info) return null;
    if (index < parts.length - 1) {
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe stage document directory: ${target}`);
    } else if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxFileBytes) {
      throw new Error(`Stage document must be a regular unshared file of at most ${maxFileBytes} bytes: ${target}`);
    }
  }
  return target;
}

export async function resolveStageDocument(root, path, executionId) {
  safeRelative(path);
  if (executionId) {
    const session = join(root, '.io');
    const ref = draftRef(executionId);
    sessionOutputPath(root, `${ref}/workspace`, { create: false });
    const generated = generatedContractPath(path) && await regularFile(session, `${ref}/generated/${path}`);
    const composed = await regularFile(session, `${composedRef(executionId)}/workspace/${path}`);
    const deleted = await regularFile(session, `${ref}/deleted/${path}`);
    const draft = await regularFile(session, `${ref}/workspace/${path}`);
    if (deleted && draft) throw new Error(`Stage document has both a draft and a deletion: ${path}`);
    if (deleted) {
      if ((await fileInfo(deleted)).size) throw new Error(`Stage document deletion marker must be empty: ${path}`);
      return null;
    }
    if (generated) return generated;
    if (draft) return composed && await fileInfo(join(session, ref, 'composed.json')) ? composed : draft;
  }
  return join(root, path);
}

export async function resolveStageSessionDocument(root, path, executionId) {
  safeRelative(path);
  const session = sessionOutputPath(root, path, { create: false });
  if (!executionId || !await readWriterComposition(root, executionId)) return session;
  const composed = await regularFile(join(root, '.io'), `${composedRef(executionId)}/session/${path}`);
  return composed || session;
}

export async function readStageDocument(root, path, executionId) {
  const effective = await resolveStageDocument(root, path, executionId);
  return effective === null ? null : readFile(effective).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
}

async function draftFiles(root, executionId, area) {
  const base = sessionOutputPath(root, `${draftRef(executionId)}/${area}`, { create: false });
  const files = [];
  const walk = async (directory, prefix) => {
    const items = await readdir(directory, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const item of items) {
      const path = safeRelative(posix.join(prefix, item.name));
      if (item.isDirectory()) await walk(join(directory, item.name), path);
      else {
        if (!item.isFile() || files.length >= maxFiles) throw new Error(`Invalid or excessive stage document drafts: ${path}`);
        files.push(path);
      }
    }
  };
  await walk(base, '');
  return files.sort();
}

export async function stageDocumentDrafts(root, executionId) {
  const [files, deletions] = await Promise.all(['workspace', 'deleted'].map((area) => draftFiles(root, executionId, area)));
  return [...files.map((path) => ({ path, deletion: false })), ...deletions.map((path) => ({ path, deletion: true }))];
}

// Canonical documentation authored by a workflow. Source, tests, and runner-owned state have their own lifecycles.
export function isStageDocumentTarget(skill, planSetId, path) {
  if (!planSetPattern.test(planSetId || '') || typeof path !== 'string') return false;
  const spec = `docs/specs/${planSetId}/`;
  const implementation = `docs/implementation/${planSetId}/`;
  if (REQUIREMENTS_STAGES.includes(skill)) {
    return path.startsWith(spec) || ['bounded-context', 'ubiquitous-language'].includes(skill) && path === 'CONTEXT.md'
      || skill === 'bounded-context' && path === 'CONTEXT-MAP.md';
  }
  if (TACTICAL_DESIGN_STAGES.includes(skill)) {
    return [`${spec}${TACTICAL_DESIGN_DOCUMENT}`, `${spec}${LEGACY_TACTICAL_DESIGN_DOCUMENT}`, 'CONTEXT.md', 'docs/architecture/domain-model.md'].includes(path)
      || skill === 'context-boundary' && path === 'CONTEXT-MAP.md'
      || path.startsWith(`${spec}diagrams/`)
      || /^docs\/adr\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(path);
  }
  if (skill === 'tactical-technology') return path === `${implementation}technology.md` || path === '.harness/agents/EXEC.md';
  if (skill === 'tactical-api' || skill === 'tactical-data') return path === `${implementation}${skill.slice(9)}.md`;
  if (skill === 'to-ticket') return path.startsWith(`docs/plans/${planSetId}/`);
  if (skill === 'sync-contracts') return path.startsWith('docs/contracts/');
  return false;
}

export function stageDocumentPolicy(skill, planSetId) {
  return isStageDocumentTarget(skill, planSetId, `docs/specs/${planSetId}/requirements.md`)
    || TACTICAL_DESIGN_STAGES.includes(skill)
    || ['tactical-technology', 'tactical-api', 'tactical-data', 'to-ticket', 'sync-contracts'].includes(skill);
}

export async function prepareStageDocumentDrafts(root, executionId) {
  const relative = draftRef(executionId);
  sessionOutputPath(root, `${relative}/workspace/.directory`);
  return documentDraftRoot(root, executionId);
}

const currentBuffer = async (base, path) => {
  const file = await regularFile(base, path);
  return file === null ? null : readFile(file);
};
const checksum = (content) => content === null ? null : digest(content);
const inlineName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function plannedDocuments({ root, input, envelope, planSetId, allowInline }) {
  const id = input.execution_id;
  const workspaceDrafts = await stageDocumentDrafts(root, id);
  const entries = [];
  for (const { path, deletion } of workspaceDrafts) {
    if (!isStageDocumentTarget(input.skill, planSetId, path)) throw new Error(`Stage ${input.skill} does not own draft document ${path}`);
    if (deletion && generatedContractPath(path)) throw new Error(`The contract sealer owns this generated document: ${path}`);
    const source = deletion ? `deleted/${path}` : `workspace/${path}`;
    const bytes = await currentBuffer(join(root, '.io'), `${draftRef(id)}/${source}`);
    if (!bytes || deletion && bytes.length !== 0) throw new Error(`Invalid staged document deletion or draft: ${path}`);
    const frozen = path === 'docs/contracts/architecture.html' || /\.(?:svg|puml)$/i.test(path);
    entries.push({ base: 'workspace', path, content: deletion ? null : bytes.toString('base64'), author: !deletion && !frozen });
  }
  for (const path of await draftFiles(root, id, 'session')) {
    if (input.skill !== 'to-ticket' || !issueDraftPath.test(path)) throw new Error(`Stage ${input.skill} does not own draft session document ${path}`);
    const content = (await currentBuffer(join(root, '.io'), `${draftRef(id)}/session/${path}`))?.toString('base64');
    if (!content) throw new Error(`Empty session document proposal: ${path}`);
    entries.push({ base: 'session', path, content, author: true });
  }
  const inline = envelope.result?.artifact_contents || [];
  if (!Array.isArray(inline) || inline.length > 32 || inline.length && !allowInline) throw new Error('Invalid inline stage documents');
  for (const item of inline) {
    if (!item || Object.keys(item).sort().join(',') !== 'content,kind,name' || !inlineName.test(item.name || '')
        || typeof item.kind !== 'string' || !item.kind.trim() || typeof item.content !== 'string' || Buffer.byteLength(item.content) > 1024 * 1024) throw new Error('Invalid inline artifact');
    entries.push({ base: 'session', path: `runtime/executions/${id}/artifacts/${item.name}`, content: Buffer.from(item.content).toString('base64'), author: true });
  }
  const targets = new Set(entries.map(({ base, path }) => `${base}:${path}`));
  if (targets.size !== entries.length || entries.length > maxFiles || entries.reduce((size, item) => size + (item.content?.length || 0), 0) > maxBatchBytes) {
    throw new Error('Stage document batch has duplicate targets or exceeds size limits');
  }
  return entries;
}

const json = (data) => `${JSON.stringify(data)}\n`;
const batchFile = (root, id, name, create = true) => sessionOutputPath(root, `${draftRef(id)}/${name}`, { create });
const readJson = (path) => readFile(path, 'utf8').then(JSON.parse, (error) => { if (error.code === 'ENOENT') return null; throw error; });
const writeJson = (path, data) => writeFile(path, json(data), { flag: 'wx', mode: 0o600 });

async function loadWriterBinding(root, provider) {
  const settings = providerAgents(parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8')), provider);
  const { low_performance_model: model, low_performance_reasoning_effort: reasoning_effort } = settings;
  if (typeof model !== 'string' || !model.trim() || model.startsWith('agents.') || !modelBelongsToProvider(provider, model)
      || typeof reasoning_effort !== 'string' || !reasoning_effort.trim() || reasoning_effort.startsWith('agents.')) {
    throw new Error(`Missing configured low_performance model or effort for the ${provider} stage document writer`);
  }
  return { provider, model_tier: 'low_performance', model, reasoning_effort };
}

async function changedDocuments(root, proposed) {
  const entries = [];
  for (const item of proposed) {
    const base = item.base === 'session' ? join(root, '.io') : root;
    const original = await currentBuffer(base, item.path);
    const content = item.content === null ? null : Buffer.from(item.content, 'base64');
    if (checksum(original) === checksum(content)) continue;
    if (item.base === 'session' && original !== null && !issueDraftPath.test(item.path)) throw new Error(`Session artifact already exists: ${item.path}`);
    entries.push({ ...item, before_sha256: checksum(original), after_sha256: checksum(content) });
  }
  return entries;
}

async function generatedContractDocuments(root, executionId) {
  const entries = [];
  for (const path of await draftFiles(root, executionId, 'generated')) {
    if (!generatedContractPath(path)) throw new Error(`Unexpected contract seal document: ${path}`);
    const content = (await currentBuffer(join(root, '.io'), `${draftRef(executionId)}/generated/${path}`))?.toString('base64');
    if (!content) throw new Error(`Empty contract seal document: ${path}`);
    entries.push({ base: 'workspace', path, content, author: false });
  }
  return entries;
}

// A stage whose documents are not reviewed before it finishes (every stage except to-ticket and sync-contracts) needs no
// separate writer: its worker authored the finished documents in the draft root, and the runner publishes those exact bytes
// after the gates, so the batch is built in memory from the drafts and records the worker as its author.
export const authorsOwnDocuments = (skill) => !reviewSkills.has(skill);

export async function stageDocumentBatch({ root, input, envelope, planSetId, binding, workerId = null, allowInline = false, beforeReview = false }) {
  const id = input.execution_id;
  const proposed = await plannedDocuments({ root, input, envelope, planSetId, allowInline });
  const existing = await readJson(batchFile(root, id, 'batch.json', false));
  if (!existing && !beforeReview && workerId && authorsOwnDocuments(input.skill)) {
    const entries = await changedDocuments(root, proposed);
    if (!entries.length) return null;
    const proposalHash = digest(json(proposed));
    const batchId = digest(`${id}:${proposalHash}`);
    return { schema_version: 1, mode: 'author', phase: 'finish', execution_id: id, skill: input.skill, plan_set_id: planSetId, batch_id: batchId, proposal_sha256: proposalHash, entries,
      composition: { execution_id: id, batch_id: batchId, agent_id: workerId, proposal_sha256: proposalHash } };
  }
  const late = input.skill === 'sync-contracts' ? await generatedContractDocuments(root, id) : [];
  if (!proposed.length && !existing && !late.length) return null;
  const proposalHash = digest(json(proposed));
  if (existing) {
    if (existing.proposal_sha256 !== proposalHash) throw new Error('Stage documents changed after their writer batch was prepared');
    return late.length ? { ...existing, late_entries: await changedDocuments(root, late) } : existing;
  }
  if (!beforeReview && reviewSkills.has(input.skill) && proposed.some(({ author }) => author)) throw new Error(`${input.skill} must prepare its document writer before independent review`);
  const writerBinding = await loadWriterBinding(root, binding.provider);
  const entries = await changedDocuments(root, beforeReview ? proposed : [...proposed, ...late]);
  if (!entries.length && !late.length && !beforeReview) return null;
  const batch = { schema_version: 1, phase: beforeReview ? 'review' : 'finish', execution_id: id, skill: input.skill, plan_set_id: planSetId, batch_id: randomUUID(), proposal_sha256: proposalHash, prepared_at: new Date().toISOString(), agent_profile: stageWriterProfile, binding: writerBinding, entries };
  try { await writeJson(batchFile(root, id, 'batch.json'), batch); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const concurrent = await readJson(batchFile(root, id, 'batch.json'));
    if (concurrent?.proposal_sha256 !== proposalHash) throw new Error('Concurrent document batches disagree');
    return concurrent;
  }
  return batch;
}

export async function prepareWriterBrief(root, batch) {
  const id = batch.execution_id;
  const composition = sessionOutputPath(root, composedRef(id));
  const files = batch.entries.filter(({ author }) => author).map(({ base, path, content }) => ({
    path, base, proposed_content: Buffer.from(content, 'base64').toString('utf8'), output: join(composition, base, path),
  }));
  const brief = batchFile(root, id, 'writer-brief.json');
  try { await writeJson(brief, { execution_id: id, files }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return files.length ? brief : null;
}

export async function readWriterBatch(root, id, { required = true } = {}) {
  const batch = await readJson(batchFile(root, id, 'batch.json', false));
  if (!batch && !required) return null;
  if (!batch || batch.execution_id !== id || batch.agent_profile !== stageWriterProfile) throw new Error('No pending stage document writer batch');
  return batch;
}

// harness-result runs in its own process after the publication, so the authored batch is handed to it on disk.
export async function persistAuthoredBatch(root, batch) {
  const path = batchFile(root, batch.execution_id, 'authored.json');
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, json(batch), { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

export async function readAuthoredBatch(root, id) {
  const batch = await readJson(batchFile(root, id, 'authored.json', false));
  if (batch && (batch.mode !== 'author' || batch.execution_id !== id)) throw new Error('Invalid authored stage document batch');
  return batch;
}

export async function readWriterAssignment(root, id) {
  return readJson(batchFile(root, id, 'writer.json', false));
}

export async function bindStageDocumentWriter({ root, id, agentId, workerId, parentSessionId, parentAgentPath }) {
  const batch = await readWriterBatch(root, id);
  const normalized = (id) => String(id || '').replace(/^\/root\//, '');
  if (!/^[A-Za-z0-9_/-]{1,200}$/.test(agentId) || normalized(agentId) === normalized(workerId)) throw new Error('Stage document writer must be a different native subagent');
  const assignment = { execution_id: id, batch_id: batch.batch_id, agent_id: agentId, parent_session_id: parentSessionId, ...(parentAgentPath ? { parent_agent_path: parentAgentPath } : {}) };
  try { await writeJson(batchFile(root, id, 'writer.json'), assignment); }
  catch (error) {
    if (error.code !== 'EEXIST' || JSON.stringify(await readWriterAssignment(root, id)) !== JSON.stringify(assignment)) throw error;
  }
  return assignment;
}

export async function readWriterComposition(root, id) {
  return readJson(batchFile(root, id, 'composed.json', false));
}

export async function admitClaudeDocumentWriterTool({ root, id, agentId, event }) {
  const batch = await readWriterBatch(root, id);
  if (batch.binding.provider !== 'claude-code') return null;
  const assignment = await readWriterAssignment(root, id);
  if (assignment?.agent_id !== agentId || event.agent_id !== agentId
      || assignment.parent_session_id !== event.session_id || event.agent_type !== batch.agent_profile) {
    throw new Error('This command belongs to the bound Claude stage document writer');
  }
  const admissionPath = batchFile(root, id, 'tool-admission.json');
  const admission = { ...assignment, proof: randomUUID() };
  try { await writeJson(admissionPath, admission); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await readJson(admissionPath);
    if (previous?.agent_id !== agentId || previous.batch_id !== batch.batch_id) throw new Error('Claude writer tool admission does not match its batch');
    return previous.proof;
  }
  return admission.proof;
}

export async function authenticateWriterCommand({ root, id, agentId, env = process.env }) {
  const batch = await readWriterBatch(root, id);
  const assignment = await readWriterAssignment(root, id);
  if (!assignment || assignment.agent_id !== agentId || assignment.batch_id !== batch.batch_id) throw new Error('Stage document writer binding mismatch');
  if (batch.binding.provider === 'codex') {
    const { verifyCodexDocumentWriter } = await import('./native-context.mjs');
    return verifyCodexDocumentWriter({ root, assignment, batch, threadId: env.CODEX_THREAD_ID });
  }
  const admission = await readJson(batchFile(root, id, 'tool-admission.json', false));
  if (!admission || admission.agent_id !== agentId || admission.batch_id !== batch.batch_id
      || admission.proof !== env.HARNESS_STAGE_WRITER_PROOF) throw new Error('The Claude write command requires authorization from the assigned writer tool event');
  return null;
}

export async function assertStageDocumentWriterCompleted(root, batch) {
  if (batch.mode === 'author') return;
  const assignment = batch.composition;
  if (batch.binding.provider === 'codex') {
    const { verifyCodexDocumentWriter } = await import('./native-context.mjs');
    await verifyCodexDocumentWriter({ root, assignment, batch, threadId: assignment.thread_id, completed: true });
    return;
  }
  const log = sessionOutputPath(root, `runtime/executions/${batch.execution_id}/subagents.jsonl`, { create: false });
  const entries = (await readFile(log, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; })).split('\n').filter(Boolean).map(JSON.parse);
  const events = entries.filter((event) => event.agent_type === batch.agent_profile && event.agent_id === assignment.agent_id
    && event.session_id === assignment.parent_session_id && Date.parse(event.recorded_at) >= Date.parse(batch.prepared_at));
  const start = events.findIndex(({ event }) => event === 'SubagentStart');
  if (start < 0 || !events.slice(start + 1).some(({ event }) => event === 'SubagentStop')) throw new Error('The assigned Claude stage document writer has no native completion evidence');
}

export async function archiveWriterComposition(root, batch) {
  const id = batch.execution_id;
  const backup = batchFile(root, id, `rejected-${batch.batch_id}`);
  await mkdir(backup);
  for (const name of ['batch.json', 'writer.json', 'writer-brief.json', 'composition', 'composed.json', 'tool-admission.json', 'generated']) {
    const source = batchFile(root, id, name, false);
    if (await fileInfo(source)) await rename(source, join(backup, name));
  }
}

export async function receiveWriterComposition({ root, id, agentId, threadId }) {
  const batch = await readWriterBatch(root, id);
  const assignment = await readWriterAssignment(root, id);
  if (!assignment || assignment.batch_id !== batch.batch_id || assignment.agent_id !== agentId) throw new Error('Stage document writer binding mismatch');
  const session = join(root, '.io');
  const entries = [];
  for (const entry of batch.entries) {
    if (!entry.author) { entries.push(entry); continue; }
    const { base, path } = entry;
    const bytes = await currentBuffer(session, `${composedRef(id)}/${base}/${path}`);
    if (bytes === null || !bytes.toString('utf8').trim()) throw new Error(`The stage document writer did not compose ${path}`);
    entries.push({ ...entry, content: bytes.toString('base64'), after_sha256: digest(bytes) });
  }
  if (entries.reduce((size, item) => size + (item.content?.length || 0), 0) > maxBatchBytes) throw new Error('Composed stage documents exceed size limit');
  const result = { ...assignment, thread_id: threadId || null, proposal_sha256: batch.proposal_sha256, entries };
  try { await writeJson(batchFile(root, id, 'composed.json'), result); }
  catch (error) {
    if (error.code !== 'EEXIST' || JSON.stringify(await readWriterComposition(root, id)) !== JSON.stringify(result)) throw error;
  }
  return result;
}

export async function finishedWriterBatch(root, batch) {
  if (batch.mode === 'author') return batch;
  const composition = await readWriterComposition(root, batch.execution_id);
  if (!composition) return null;
  const assignment = await readWriterAssignment(root, batch.execution_id);
  if (!assignment || batch.batch_id !== composition.batch_id || batch.proposal_sha256 !== composition.proposal_sha256
      || assignment.agent_id !== composition.agent_id || assignment.parent_session_id !== composition.parent_session_id) throw new Error('Stage document composition does not match its assignment');
  for (const entry of composition.entries.filter(({ author }) => author)) {
    const bytes = await currentBuffer(join(root, '.io'), `${composedRef(batch.execution_id)}/${entry.base}/${entry.path}`);
    if (checksum(bytes) !== entry.after_sha256) throw new Error(`Composed stage document changed after the writer submitted it: ${entry.path}`);
  }
  const entries = new Map([...composition.entries, ...(batch.late_entries || [])].map((entry) => [`${entry.base}:${entry.path}`, entry]));
  return { ...batch, entries: [...entries.values()], composition };
}

export async function assertReviewDraftComposed(root, executionId, skill) {
  if (!executionId || !reviewSkills.has(skill)) return;
  const candidates = await stageDocumentDrafts(root, executionId);
  const sessionCandidates = skill === 'to-ticket' ? await draftFiles(root, executionId, 'session') : [];
  const batch = await readWriterBatch(root, executionId, { required: false });
  if (!candidates.length && !sessionCandidates.length && !batch) return;
  if (batch?.phase !== 'review' || batch.skill !== skill) throw new Error('Independent review requires the assigned stage document writer first');
  const record = await readJson(sessionOutputPath(root, 'worktree.json', { create: false }));
  if (record && record.plan_set_id !== batch.plan_set_id) throw new Error('Review writer plan set does not match its workspace');
  const proposed = await plannedDocuments({ root, input: { skill, execution_id: executionId }, envelope: {}, planSetId: record?.plan_set_id ?? batch.plan_set_id, allowInline: false });
  if (digest(json(proposed)) !== batch.proposal_sha256) throw new Error('Review drafts changed after the assigned stage document writer composed them');
  const completed = await finishedWriterBatch(root, batch);
  if (!completed) throw new Error('Independent review must wait for the assigned stage document writer');
  await assertStageDocumentWriterCompleted(root, completed);
}

async function applyFile(root, path, bytes, stageDirectory, mode) {
  const target = join(root, path);
  if (bytes === null) {
    await rm(target, { force: true });
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(stageDirectory, `apply-${randomUUID()}`);
  await writeFile(temporary, bytes, { flag: 'wx', mode });
  try { await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

const currentHead = (root) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export async function rollbackStageDocumentWrite(root, id, { includeWritten = false } = {}) {
  const lock = batchFile(root, id, 'lock', false);
  const owner = await readJson(lock);
  if (owner && (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || processExists(owner.pid))) throw new Error('The stage document batch is being published');
  const receipt = batchFile(root, id, 'written.json', false);
  if (await fileInfo(receipt) && !includeWritten) return;
  const path = batchFile(root, id, 'rollback.json', false);
  const journal = await readJson(path);
  if (!journal) { if (owner) await rm(lock, { force: true }); return; }
  if (journal.head && journal.head !== currentHead(root)) throw new Error('The document workspace HEAD changed after publication; preserve it for inspection');
  // An interrupted publisher may have written a prefix of the batch. Restore only the exact changes it authored.
  for (const item of journal.entries) {
    const base = item.base === 'session' ? join(root, '.io') : root;
    const hash = checksum(await currentBuffer(base, item.path));
    if (hash !== item.before_sha256 && hash !== item.after_sha256) throw new Error(`Cannot restore interrupted stage document because another edit was made: ${item.path}`);
  }
  for (const item of journal.entries.slice().reverse()) {
    const base = item.base === 'session' ? join(root, '.io') : root;
    if (checksum(await currentBuffer(base, item.path)) === item.before_sha256) continue;
    await applyFile(base, item.path, item.before === null ? null : Buffer.from(item.before, 'base64'), dirname(path), item.mode);
  }
  await rm(receipt, { force: true });
  await rm(path, { force: true });
  if (owner) await rm(lock, { force: true });
}

export async function readDocumentWriterReceipt(root, batch) {
  const receipt = await readJson(batchFile(root, batch.execution_id, 'written.json', false));
  if (!receipt) return null;
  const assignment = batch.mode === 'author' ? batch.composition : await readWriterAssignment(root, batch.execution_id);
  if (!assignment || receipt.batch_id !== batch.batch_id || receipt.agent_id !== assignment.agent_id
      || receipt.execution_id !== batch.execution_id || receipt.proposal_sha256 !== batch.proposal_sha256) throw new Error('Stage document writer receipt does not match the assigned batch');
  for (const { base, path, after_sha256 } of batch.entries) {
    if (checksum(await currentBuffer(base === 'session' ? join(root, '.io') : root, path)) !== after_sha256) throw new Error(`Written stage document changed before finish: ${path}`);
  }
  return receipt;
}

export async function writeStageDocumentBatch({ root, batch, planSetId, skill }) {
  const id = batch.execution_id;
  const assignment = batch.composition;
  const lock = batchFile(root, id, 'lock');
  const written = await readDocumentWriterReceipt(root, batch);
  if (written) return written;
  await rollbackStageDocumentWrite(root, id);
  await writeJson(lock, { pid: process.pid });
  const changed = [];
  const rollback = batchFile(root, id, 'rollback.json');
  try {
    const planned = [];
    for (const entry of batch.entries) {
      const { base, path } = entry;
      if (base === 'session' ? !path.startsWith(`runtime/executions/${id}/artifacts/`) && !(skill === 'to-ticket' && issueDraftPath.test(path)) : base !== 'workspace' || !isStageDocumentTarget(skill, planSetId, path)) throw new Error(`Unowned stage document target: ${path}`);
      const directory = base === 'session' ? join(root, '.io') : root;
      const original = await currentBuffer(directory, path);
      const content = entry.content === null ? null : Buffer.from(entry.content, 'base64');
      if (checksum(original) !== entry.before_sha256) throw new Error(`Stage document changed after handoff: ${path}`);
      if (checksum(content) !== entry.after_sha256) throw new Error(`Corrupt stage document draft: ${path}`);
      const mode = ((await fileInfo(join(directory, path)))?.mode ?? (base === 'session' ? 0o600 : 0o644)) & 0o777;
      planned.push({ ...entry, directory, original, content, mode });
    }
    await writeJson(rollback, { batch_id: batch.batch_id, head: currentHead(root), entries: planned.map(({ base, path, original, before_sha256, after_sha256, mode }) => ({ base, path, before: original?.toString('base64') ?? null, before_sha256, after_sha256, mode })) });
    for (const item of planned) {
      await applyFile(item.directory, item.path, item.content, dirname(lock), item.mode);
      changed.push(item);
    }
    const { entries: _drafts, ...identity } = assignment;
    const receipt = { ...identity, proposal_sha256: batch.proposal_sha256, written_at: new Date().toISOString(), documents: planned.length };
    await writeJson(batchFile(root, id, 'written.json'), receipt);
    return receipt;
  } catch (error) {
    for (const item of changed.reverse()) await applyFile(item.directory, item.path, item.original, dirname(lock), item.mode);
    await rm(rollback, { force: true });
    throw error;
  } finally { await rm(lock, { force: true }); }
}
