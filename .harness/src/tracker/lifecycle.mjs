import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, lstat, rename, unlink, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseYaml } from '../eval/yaml.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { sessionOutputPath } from '../workflow/session-output.mjs';
import { JsonlEventWriter } from '../eval/journal.mjs';

const exec = promisify(execFile);
export const TRACKER_STATES = Object.freeze({ planned: ['Planned'], 'in-progress': ['In Progress'], blocked: ['Blocked'], completed: ['Done'] });
const githubBoardStatus = Object.freeze({ planned: 'Todo', 'in-progress': 'In Progress', blocked: 'In Progress' });
const canonical = (value) => Object.keys(TRACKER_STATES).find((key) => key === value || TRACKER_STATES[key][0] === value);
const defaultRun = async (command, args, cwd) => (await exec(command, args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })).stdout;
const json = async (run, command, args, root) => JSON.parse(await run(command, args, root));
const single = (items, label) => { if (!Array.isArray(items) || items.length !== 1) throw new Error(`${label}: expected exactly one match`); return items[0]; };

async function projectConfig(root) {
  if (!isAbsolute(root || '')) throw new Error('Absolute workspace_root is required');
  return parseYaml(await readFile(resolve(root, '.harness/harness.yaml'), 'utf8')).tracker;
}
async function localTicket(root, config, ref) {
  if (isAbsolute(ref) || ref.split(/[\\/]/).includes('..') || !/^docs\/plans\/[^/]+\/[^/]+\.md$/.test(ref)) throw new Error('Invalid local plan path');
  const directory = resolve(root, 'docs/plans'), path = resolve(root, ref);
  const rel = relative(directory, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Ticket must be inside configured local directory');
  await assertWorkspaceTarget(root, ref);
  if (!(await lstat(path)).isFile()) throw new Error('Ticket must be a regular file');
  const content = await readFile(path, 'utf8');
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error('Local ticket requires YAML frontmatter');
  const lines = [...frontmatter[1].matchAll(/^status:[ \t]*([^\r\n]+)$/gm)];
  if (lines.length !== 1) throw new Error('Local ticket requires exactly one status field');
  const status = parseYaml(frontmatter[1]).status;
  if (!Object.hasOwn(TRACKER_STATES, status)) throw new Error(`Unsupported local status: ${status}`);
  return { path, content, frontmatter: frontmatter[0], status };
}
async function writeLocalPlanStatus(root, planSetId, planId, status) {
  const local = await localTicket(root, {}, `docs/plans/${planSetId}/${planId}.md`);
  if (local.status === status) return false;
  const updated = local.frontmatter.replace(/^status:[ \t]*[^\r\n]+/m, `status: ${status}`);
  if (await readFile(local.path, 'utf8') !== local.content) throw new Error('Local ticket changed concurrently; retry from the latest state');
  const temp = `${local.path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, local.content.replace(local.frontmatter, updated), { flag: 'wx', mode: (await lstat(local.path)).mode }); await rename(temp, local.path); }
  finally { await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  return true;
}
async function localIssueLinks(root, planSetId, repository = null) {
  const path = sessionOutputPath(root, `runtime/to-ticket/${planSetId}-issues.json`, { create: false });
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(saved.tickets) || (repository && saved.repository !== repository)) throw new Error('Invalid Issue links');
    for (const ticket of saved.tickets) if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ticket.plan_id || '') || typeof ticket.ticket_ref !== 'string') throw new Error('Invalid Issue links');
    return new Map(saved.tickets.map((ticket) => [ticket.plan_id, ticket.ticket_ref]));
  } catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
}
async function localPlanIds(root, planSetId) {
  const directory = resolve(root, 'docs/plans', planSetId);
  try { return (await readdir(directory)).filter((name) => name.endsWith('.md') && name !== 'plans.md').map((name) => name.slice(0, -3)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function localPlanStatus(root, planSetId, planId) {
  const path = `docs/plans/${planSetId}/${planId}.md`;
  return (await localTicket(root, {}, path)).status;
}
async function localTicketIdentity(root, ref, expectedPlanId = null) {
  let planSetId = null, planId = null;
  if (expectedPlanId) {
    const separator = expectedPlanId.lastIndexOf(':');
    if (separator <= 0) throw new Error('Invalid expected plan identity');
    planSetId = expectedPlanId.slice(0, separator); planId = expectedPlanId.slice(separator + 1);
  } else {
    const local = /^docs\/plans\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/.exec(ref);
    if (local) [, planSetId, planId] = local;
    else {
      try { planSetId = JSON.parse(await readFile(resolve(root, '.io/worktree.json'), 'utf8')).plan_set_id; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (planSetId) planId = [...await localIssueLinks(root, planSetId)].find(([, ticketRef]) => ticketRef === ref)?.[0] || null;
      if (!planId) {
        const directory = sessionOutputPath(root, 'runtime/to-ticket', { create: false });
        try {
          for (const name of await readdir(directory)) {
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]*-issues\.json$/.test(name)) continue;
            const candidateSet = name.slice(0, -'-issues.json'.length);
            const links = await localIssueLinks(root, candidateSet);
            const candidatePlan = [...links].find(([, ticketRef]) => ticketRef === ref)?.[0];
            if (candidatePlan) { planSetId = candidateSet; planId = candidatePlan; break; }
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  if (!planSetId || !planId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planSetId) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planId)) throw new Error(`No local plan ticket is linked to ${ref}`);
  if (ref.startsWith('docs/plans/')) {
    const expectedRef = `docs/plans/${planSetId}/${planId}.md`;
    if (ref !== expectedRef) throw new Error('Local ticket does not match expected plan identity');
  } else {
    const linked = (await localIssueLinks(root, planSetId)).get(planId);
    if (linked && linked !== ref) throw new Error('Issue reference does not match the local plan link');
  }
  return { plan_set_id: planSetId, plan_id: planId, local_ref: `docs/plans/${planSetId}/${planId}.md` };
}
const PROJECT_METADATA_TTL_MS = 60 * 60 * 1000;
const nonemptyId = (value) => typeof value === 'string' && value.length > 0;
function validCachedMetadata(value, settings) {
  const validField = (field, name, options) => nonemptyId(field?.id) && field.name === name &&
    Array.isArray(field.options) && options.every((option) => field.options.filter((item) => item?.name === option && nonemptyId(item.id)).length === 1);
  return nonemptyId(value?.project?.id) &&
    validField(value.field, settings.status_field, Object.values(TRACKER_STATES).flat()) &&
    (value.statusField === null || validField(value.statusField, 'Status', ['Todo', 'In Progress', 'Done']));
}

async function forgetProjectMetadata(context) {
  if (context.projectMetadataPath) await unlink(context.projectMetadataPath).catch(() => {});
}

async function githubProjectMetadata(root, settings, run, context) {
  if (!context.githubProjectMetadata) context.githubProjectMetadata = (async () => {
    const key = createHash('sha256').update(JSON.stringify([process.env.GH_HOST || 'github.com', settings.repository, settings.project_owner, settings.project_number, settings.status_field])).digest('hex');
    const path = sessionOutputPath(root, `runtime/tracker-cache/project-v1-${key}.json`);
    context.projectMetadataPath = path;
    try {
      const { saved_at: saved, metadata } = JSON.parse(await readFile(path, 'utf8'));
      const age = Date.now() - saved;
      if (Number.isFinite(saved) && age >= 0 && age < PROJECT_METADATA_TTL_MS && validCachedMetadata(metadata, settings)) return metadata;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    }
    let project, fields;
    try { project = await json(run, 'gh', ['project', 'view', String(settings.project_number), '--owner', settings.project_owner, '--format', 'json'], root); }
    catch (error) { throw new Error(`GitHub configured project view failed (${settings.project_owner}/${settings.project_number}): ${error.message}`); }
    try { fields = await json(run, 'gh', ['project', 'field-list', String(settings.project_number), '--owner', settings.project_owner, '--format', 'json', '--limit', '100'], root); }
    catch (error) { throw new Error(`GitHub configured project field-list failed (${settings.project_owner}/${settings.project_number}, ${settings.status_field}): ${error.message}`); }
    if (fields.totalCount > fields.fields.length) throw new Error('Incomplete project field list');
    const field = single(fields.fields.filter((f) => f.name === settings.status_field && f.type === 'ProjectV2SingleSelectField'), 'Configured status field');
    for (const [name] of Object.values(TRACKER_STATES)) single(field.options.filter((o) => o.name === name), `Status option ${name}`);
    const statusField = settings.status_field === 'Status' ? null : fields.fields.find((f) => f.name === 'Status' && f.type === 'ProjectV2SingleSelectField') || null;
    if (statusField) for (const name of ['Todo', 'In Progress', 'Done']) single(statusField.options.filter((o) => o.name === name), `Status option ${name}`);
    const metadata = { project, field, statusField };
    if (validCachedMetadata(metadata, settings)) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ saved_at: Date.now(), metadata }), { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => {}); }
    }
    return metadata;
  })();
  return context.githubProjectMetadata;
}
function githubIssueStatus(issue, ref, project, field, statusField) {
  if (!issue || issue.projectItems.pageInfo.hasNextPage) throw new Error(`Missing issue or incomplete project item pagination: ${ref}`);
  const item = single(issue.projectItems.nodes.filter((i) => i.project.id === project.id), 'Configured project item');
  if (item.fieldValues.pageInfo.hasNextPage) throw new Error('Incomplete project field pagination');
  const value = single(item.fieldValues.nodes.filter((v) => v.field?.id === field.id), 'Configured status value');
  const status = canonical(value.name);
  if (!status) throw new Error(`Unsupported Workflow Status: ${value.name}`);
  const defaultStatus = statusField ? single(item.fieldValues.nodes.filter((v) => v.field?.id === statusField.id), 'Project Status value').name : null;
  if (issue.state !== 'OPEN' && status !== 'completed') throw new Error('A closed GitHub issue cannot have an unfinished Workflow Status');
  return { status, default_status: defaultStatus, project, field, statusField, item, issue_state: issue.state };
}

function githubReference(config, ref) {
  const settings = config.github;
  if (!settings || !/^[\w.-]+\/[\w.-]+$/.test(settings.repository || '') || !/^[\w-]+$/.test(settings.project_owner || '') || !Number.isInteger(settings.project_number) || settings.project_number <= 0 || !settings.status_field || settings.status_field === 'Status') throw new Error('Invalid configured GitHub Workflow Status project');
  const match = ref.match(/^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/);
  if (!match || match[1] !== settings.repository) throw new Error('Ticket reference must match configured repository');
  return { settings, owner: match[1].split('/')[0], repo: match[1].split('/')[1], number: Number(match[2]) };
}
async function githubTickets(root, config, refs, run, context) {
  const { settings } = githubReference(config, refs[0]);
  const { project, field, statusField } = await githubProjectMetadata(root, settings, run, context);
  const parsed = refs.map((ref) => ({ ref, ...githubReference(config, ref) }));
  const results = new Map();
  for (let offset = 0; offset < parsed.length; offset += 10) {
    const batch = parsed.slice(offset, offset + 10), first = batch[0];
    const issues = batch.map(({ number }, index) => `issue_${index}:issue(number:${number}){state projectItems(first:20){pageInfo{hasNextPage} nodes{id project{id} fieldValues(first:20){pageInfo{hasNextPage} nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2SingleSelectField{id}}}}}}}}`).join(' ');
    const query = `query{repository(owner:${JSON.stringify(first.owner)},name:${JSON.stringify(first.repo)}){${issues}}}`;
    let response;
    try { response = await json(run, 'gh', ['api', 'graphql', '-f', `query=${query}`], root); }
    catch (error) { throw new Error(`GitHub batched issue query failed (${batch.map((item) => item.ref).join(', ')}): ${error.message}`); }
    if (response.errors?.length) throw new Error(`GitHub batched issue query failed: ${response.errors.map((error) => error.message).filter(Boolean).join('; ') || 'API returned errors'}`);
    const repository = response.data?.repository;
    if (!repository) throw new Error('GitHub batched issue query returned no repository');
    try {
      batch.forEach((item, index) => results.set(item.ref, githubIssueStatus(repository[`issue_${index}`], item.ref, project, field, statusField)));
    } catch (error) {
      if (/^(Configured project item|Configured status value|Project Status value):/.test(error.message)) await forgetProjectMetadata(context);
      throw error;
    }
  }
  return results;
}

async function githubTicket(root, config, ref, run, context) {
  return (await githubTickets(root, config, [ref], run, context)).get(ref);
}
async function readTracker(root, config, ref, run, context = {}) {
  if (config?.mode === 'github') return githubTicket(root, config, ref, run, context);
  if (config?.mode === 'local-markdown') return localTicket(root, config, ref);
  throw new Error('Exactly one configured tracker mode is required');
}
export async function readTrackerStatus({ workspace_root: root, ticket_ref: ref, run = defaultRun } = {}) {
  try {
    const config = await projectConfig(root);
    const identity = await localTicketIdentity(root, ref);
    const canonicalStatus = await localPlanStatus(root, identity.plan_set_id, identity.plan_id);
    if (config?.mode !== 'github') return { status: 'pass', reason: 'local_tracker_status_read', ticket_ref: ref, canonical_status: canonicalStatus, local_status: canonicalStatus };
    try {
      const tracker = await readTracker(root, config, ref, run, {});
      return { status: 'pass', reason: 'local_tracker_status_read', ticket_ref: ref, canonical_status: canonicalStatus, local_status: canonicalStatus, mirror_status: tracker.status, project_status: tracker.default_status, issue_state: tracker.issue_state, project_id: tracker.project?.id, field_id: tracker.field?.id, item_id: tracker.item?.id, ...(tracker.status !== canonicalStatus ? { warnings: [`GitHub mirror is ${tracker.status}; local status remains ${canonicalStatus}`] } : {}) };
    } catch (error) {
      return { status: 'pass', reason: 'local_tracker_status_read', ticket_ref: ref, canonical_status: canonicalStatus, local_status: canonicalStatus, mirror_status: null, warnings: [`GitHub mirror unavailable: ${error.message}`] };
    }
  } catch (error) { return { status: 'fail', reason: 'local_tracker_status_unresolved', ticket_ref: ref, violations: [error.message] }; }
}
export async function listPlanTickets({ workspace_root: root, plan_set_id: planSetId, run = defaultRun } = {}) {
  if (!planSetId) return [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planSetId)) throw new Error('Invalid plan set ID');
  const config = await projectConfig(root);
  if (config.mode === 'local-markdown') {
    const names = await readdir(resolve(root, 'docs/plans', planSetId));
    return names.filter((name) => name.endsWith('.md') && name !== 'plans.md').map((name) => ({ plan_id: name.slice(0, -3), ticket_ref: `docs/plans/${planSetId}/${name}` })).sort((a, b) => a.plan_id.localeCompare(b.plan_id));
  }
  if (config.mode !== 'github') throw new Error('Exactly one configured tracker mode is required');
  const settings = config.github;
  if (!/^[\w.-]+\/[\w.-]+$/.test(settings.repository || '')) throw new Error('Invalid configured GitHub repository');
  const receipt = sessionOutputPath(root, `runtime/to-ticket/${planSetId}-issues.json`, { create: false });
  const saved = await readFile(receipt, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (saved !== null) {
    const { repository, tickets } = JSON.parse(saved);
    if (repository === settings.repository) {
      if (!Array.isArray(tickets) || new Set(tickets.map((ticket) => ticket.plan_id)).size !== tickets.length) throw new Error('Invalid Issue links');
      for (const ticket of tickets) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ticket.plan_id)) throw new Error('Invalid linked plan ID');
        githubReference(config, ticket.ticket_ref);
      }
      return tickets;
    }
  }
  const tickets = new Map();
  const pages = await json(run, 'gh', ['api', '--paginate', '--slurp', `repos/${settings.repository}/issues?state=all&per_page=100`], root);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('Incomplete repository Issue response');
  for (const page of pages) {
    for (const issue of page) {
      if (issue.pull_request) continue;
      const content = { ...issue, url: issue.html_url };
      for (const match of (content.body || '').matchAll(/<!-- harness-plan ([^\n]*?) -->/g)) {
        let identity;
        try { identity = JSON.parse(match[1]); } catch { throw new Error('Invalid plan identity in Project Issue'); }
        if (identity.plan_set_id !== planSetId || identity.plan_id === '@parent') continue;
        if (typeof identity.plan_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identity.plan_id) || (!Number.isSafeInteger(content.number) || content.number <= 0) || content.url !== `https://github.com/${settings.repository}/issues/${content.number}`) throw new Error('Invalid plan Issue identity');
        if (tickets.has(identity.plan_id)) throw new Error(`Duplicate Issue for plan: ${identity.plan_id}`);
        tickets.set(identity.plan_id, { plan_id: identity.plan_id, ticket_ref: `${settings.repository}#${content.number}` });
      }
    }
  }
  return [...tickets.values()].sort((a, b) => a.plan_id.localeCompare(b.plan_id));
}

// Local plan Issues are canonical in every tracker mode. GitHub Issue references are an optional mirror mapping.
export async function readPlanSetTicketStatuses({ workspace_root: root, plan_set_id: planSetId, plan_ids: planIds, run = defaultRun } = {}) {
  if (!planSetId || !Array.isArray(planIds)) throw new Error('A plan set ID and its plan IDs are required');
  const config = await projectConfig(root);
  if (!['github', 'local-markdown'].includes(config?.mode)) throw new Error('Exactly one configured tracker mode is required');
  const links = config.mode === 'github' ? await localIssueLinks(root, planSetId) : new Map();
  const tickets = [];
  for (const planId of planIds) {
    const ref = config.mode === 'local-markdown' ? `docs/plans/${planSetId}/${planId}.md` : links.get(planId) ?? null;
    const status = await localPlanStatus(root, planSetId, planId);
    tickets.push({ plan_id: planId, ticket_ref: ref, status });
  }
  return tickets;
}

// Which plans must be finished before this plan, read from the plan's own "의존성" section (backticked plan IDs of the
// same plan set), and whether each ticket is completed. The stage reads this answer instead of matching Issue
// numbers to plans by hand, which has mistaken the plan's own ticket for a prerequisite.
export async function planDependencies({ workspace_root: root, plan_set_id: planSetId, plan_id: planId, run = defaultRun } = {}) {
  if (!planSetId || !planId) throw new Error('dependencies needs a plan-set worktree and a plan ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planSetId) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planId)) throw new Error('Invalid plan identity');
  const names = await readdir(resolve(root, 'docs/plans', planSetId));
  const known = new Set(names.filter((name) => name.endsWith('.md') && name !== 'plans.md').map((name) => name.slice(0, -3)));
  const text = await readFile(resolve(root, 'docs/plans', planSetId, `${planId}.md`), 'utf8');
  const section = /^##\s+의존성[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  // Only sentences that say "선행" name prerequisites; plans mentioned elsewhere (downstream checks) are not dependencies.
  const prerequisite = section.split(/(?<=[.。])\s+|\n+/).filter((sentence) => sentence.includes('선행')).join(' ');
  const ids = [...new Set([...prerequisite.matchAll(/`([A-Za-z0-9][A-Za-z0-9._-]*)`/g)].map((match) => match[1]))].filter((id) => id !== planId && known.has(id));
  const statuses = await readPlanSetTicketStatuses({ workspace_root: root, plan_set_id: planSetId, plan_ids: ids, run });
  const dependencies = statuses.map((ticket) => ({ ...ticket, complete: ticket.status === 'completed' }));
  const incomplete = dependencies.filter((item) => !item.complete);
  return { status: incomplete.length ? 'blocked' : 'pass', plan_id: planId, dependencies, incomplete: incomplete.map((item) => item.plan_id) };
}

export async function inspectTrackerSync({ workspace_root: root, ticket_refs = null, expected_plan_id = null, run = defaultRun } = {}) {
  try {
    const config = await projectConfig(root);
    if (ticket_refs !== null && (!Array.isArray(ticket_refs) || ticket_refs.some((ref) => typeof ref !== 'string' || !ref.trim()) || new Set(ticket_refs).size !== ticket_refs.length)) throw new Error('ticket_refs must contain unique exact references');
    let planSetId = null, planIds = [];
    if (expected_plan_id) {
      const separator = expected_plan_id.lastIndexOf(':');
      if (separator <= 0) throw new Error('Invalid expected plan identity');
      planSetId = expected_plan_id.slice(0, separator);
      planIds = [expected_plan_id.slice(separator + 1)];
    } else {
      try { planSetId = JSON.parse(await readFile(resolve(root, '.io/worktree.json'), 'utf8')).plan_set_id; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (planSetId) planIds = await localPlanIds(root, planSetId);
    }
    const warnings = [];
    let links = planSetId ? await localIssueLinks(root, planSetId) : new Map();
    if (config.mode === 'github' && planSetId && (!links.size || planIds.length === 0)) {
      try {
        const remoteLinks = await listPlanTickets({ workspace_root: root, plan_set_id: planSetId, run });
        links = new Map([...links, ...remoteLinks.map(({ plan_id, ticket_ref }) => [plan_id, ticket_ref])]);
        if (!planIds.length) planIds = remoteLinks.map(({ plan_id }) => plan_id);
      } catch (error) { warnings.push(`GitHub ticket mapping unavailable: ${error.message}`); }
    }
    if (ticket_refs !== null) {
      if (expected_plan_id) {
        const expectedPlanId = planIds[0];
        const knownRef = links.get(expectedPlanId);
        if (config.mode === 'github' && !knownRef) return { status: 'fail', reason: 'tracker_reference_unresolved', violations: ['The local plan Issue has no verified GitHub mirror link'], tickets: [] };
        if (knownRef && ticket_refs.some((ref) => ref !== knownRef)) return { status: 'fail', reason: 'tracker_reference_mismatch', violations: ['Ticket does not belong to the expected plan'], tickets: [] };
        if (!knownRef && config.mode === 'local-markdown' && ticket_refs.some((ref) => ref !== `docs/plans/${planSetId}/${expectedPlanId}.md`)) return { status: 'fail', reason: 'tracker_reference_mismatch', violations: ['Ticket does not belong to the expected plan'], tickets: [] };
      } else if (planSetId) {
        const mappedIds = [...links].filter(([, ref]) => ticket_refs.includes(ref)).map(([id]) => id);
        if (mappedIds.length) planIds = mappedIds;
      }
    }
    const localTickets = planSetId && planIds.length ? await readPlanSetTicketStatuses({ workspace_root: root, plan_set_id: planSetId, plan_ids: planIds, run }) : [];
    const refs = ticket_refs ?? localTickets.map((ticket) => ticket.ticket_ref).filter(Boolean);
    let mirrorStatuses = null;
    if (config.mode === 'github' && refs.length) {
      for (const ref of refs) githubReference(config, ref);
      try { mirrorStatuses = await githubTickets(root, config, refs, run, {}); }
      catch (error) { warnings.push(`GitHub status mirror unavailable: ${error.message}`); }
    }
    const tickets = localTickets.map((ticket) => {
      const mirrorStatus = ticket.ticket_ref && mirrorStatuses ? mirrorStatuses.get(ticket.ticket_ref)?.status ?? null : null;
      if (ticket.ticket_ref && mirrorStatuses && mirrorStatus !== ticket.status) warnings.push(mirrorStatus
        ? `GitHub mirror for ${ticket.plan_id} is ${mirrorStatus}; local status remains ${ticket.status}`
        : `GitHub mirror for ${ticket.plan_id} could not be read; local status remains ${ticket.status}`);
      return { ref: ticket.ticket_ref, plan_id: ticket.plan_id, status: ticket.status, ...(ticket.ticket_ref && mirrorStatuses ? { mirror_status: mirrorStatus } : {}) };
    });
    const localStatus = localTickets.length === 1 ? localTickets[0].status : expected_plan_id ? localTickets.find((ticket) => ticket.plan_id === planIds[0])?.status ?? null : null;
    return { status: 'pass', reason: 'local_tracker_current', local_status: localStatus, local_statuses: true, mirror_status: mirrorStatuses ? 'available' : config.mode === 'github' && refs.length ? 'unavailable' : 'not_configured', warnings, violations: [], tickets };
  } catch (error) {
    return { status: 'fail', reason: 'local_tracker_status_unresolved', violations: [error.message] };
  }
}

// Records a note on the ticket (for example what an implementation-only repair changed) without touching the plan.
export async function commentTracker({ workspace_root: root, ticket_ref: ref, body, run = defaultRun } = {}) {
  if (typeof body !== 'string' || !body.trim()) throw new Error('A comment body is required');
  const config = await projectConfig(root);
  if (config?.mode === 'github') {
    const { settings, number } = githubReference(config, ref);
    await run('gh', ['issue', 'comment', String(number), '--repo', settings.repository, '--body', body], root);
    return { status: 'pass', reason: 'tracker_comment_added', ticket_ref: ref };
  }
  if (config?.mode === 'local-markdown') {
    const ticket = await localTicket(root, config, ref);
    if (await readFile(ticket.path, 'utf8') !== ticket.content) throw new Error('Local ticket changed concurrently; retry');
    const note = `${ticket.content.replace(/\n*$/, '\n')}${ticket.content.includes('\n## 수정 기록\n') ? '' : '\n## 수정 기록\n'}\n- ${new Date().toISOString().slice(0, 10)}: ${body.trim().replace(/\n+/g, ' ')}\n`;
    const temp = `${ticket.path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, note, { flag: 'wx', mode: (await lstat(ticket.path)).mode }); await rename(temp, ticket.path); }
    finally { await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
    return { status: 'pass', reason: 'tracker_comment_added', ticket_ref: ref };
  }
  throw new Error('Exactly one configured tracker mode is required');
}

export async function syncTrackerStatus({ workspace_root: root, ticket_ref: ref, status = null, phase = null, classification = null, expected_plan_id = null, run = defaultRun } = {}) {
  if (status !== null && !Object.hasOwn(TRACKER_STATES, status)) throw new Error('Use planned, in-progress, blocked, or completed');
  if (phase !== null || classification !== null) throw new Error('Tracker phase and classification were retired with Beads; no metadata was changed');
  const config = await projectConfig(root);
  const identity = await localTicketIdentity(root, ref, expected_plan_id);
  if (expected_plan_id) {
    const check = await inspectTrackerSync({ workspace_root: root, ticket_refs: [ref], expected_plan_id, run });
    if (check.status !== 'pass') throw new Error(check.violations.join('; '));
  }
  const currentStatus = await localPlanStatus(root, identity.plan_set_id, identity.plan_id);
  const desired = status || currentStatus;
  if (!Object.hasOwn(TRACKER_STATES, desired)) throw new Error(`Unsupported local status: ${desired}`);
  const local_updated = await writeLocalPlanStatus(root, identity.plan_set_id, identity.plan_id, desired);

  if (config.mode !== 'github') return { status: 'pass', reason: 'local_status_recorded', ticket_ref: ref, plan_id: identity.plan_id, canonical_status: desired, local_updated, tracker_updated: false };
  let tracker_updated = false;
  const warnings = [];
  const context = {};
  let tracker;
  try {
    githubReference(config, ref);
    tracker = await readTracker(root, config, ref, run, context);
  } catch (error) {
    warnings.push(`GitHub status mirror unavailable: ${error.message}`);
    return { status: 'pass', reason: 'local_status_recorded', ticket_ref: ref, plan_id: identity.plan_id, canonical_status: desired, local_updated, mirror_status: 'unavailable', tracker_updated, warnings };
  }
  const evidence = sessionOutputPath(root, `runtime/tracker-sync/${createHash('sha256').update(ref).digest('hex')}.jsonl`);
  const writer = await new JsonlEventWriter(resolve(root, evidence), { streamId: `tracker:${ref}` }).init();
  try {
    await writer.append('tracker_sync_started', { ticket_ref: ref, desired, local_status: desired, mirror_previous: tracker.status, phase, classification }, { critical: true });
    if (tracker.status !== desired) {
      const option = single(tracker.field.options.filter((o) => o.name === TRACKER_STATES[desired][0]), 'Workflow Status option');
      await run('gh', ['project', 'item-edit', '--id', tracker.item.id, '--project-id', tracker.project.id, '--field-id', tracker.field.id, '--single-select-option-id', option.id], root);
      tracker_updated = true;
    }
    if (tracker.statusField) {
      const optionName = githubBoardStatus[desired];
      if (optionName && tracker.default_status !== optionName) {
        const option = single(tracker.statusField.options.filter((o) => o.name === optionName), 'Project Status option');
        await run('gh', ['project', 'item-edit', '--id', tracker.item.id, '--project-id', tracker.project.id, '--field-id', tracker.statusField.id, '--single-select-option-id', option.id], root);
        tracker_updated = true;
      }
    }
    try {
      const verified = await readTracker(root, config, ref, run, context);
      if (verified.status !== desired || (verified.statusField && githubBoardStatus[desired] && verified.default_status !== githubBoardStatus[desired])) throw new Error('GitHub mirror write did not verify');
      tracker = verified;
    } catch (error) { warnings.push(`GitHub status mirror verification unavailable: ${error.message}`); }
    const result = { status: 'pass', reason: 'local_status_recorded', ticket_ref: ref, plan_id: identity.plan_id, canonical_status: desired, local_updated, mirror_status: tracker.status, tracker_updated, warnings, evidence_path: evidence };
    await writer.append('tracker_sync', result, { critical: true });
    return result;
  } catch (error) {
    await forgetProjectMetadata(context);
    const warning = `GitHub status mirror update failed: ${error.message}`;
    warnings.push(warning);
    const result = { status: 'pass', reason: 'local_status_recorded', ticket_ref: ref, plan_id: identity.plan_id, canonical_status: desired, local_updated, mirror_status: 'unavailable', tracker_updated, warnings, evidence_path: evidence };
    await writer.append('tracker_sync', result, { critical: true });
    return result;
  } finally { await writer.close(); }
}
