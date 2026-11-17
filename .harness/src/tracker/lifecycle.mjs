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
async function githubProjectMetadata(root, settings, run, context) {
  if (!context.githubProjectMetadata) context.githubProjectMetadata = (async () => {
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
    return { project, field, statusField };
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
    batch.forEach((item, index) => results.set(item.ref, githubIssueStatus(repository[`issue_${index}`], item.ref, project, field, statusField)));
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
    const tracker = await readTracker(root, await projectConfig(root), ref, run, {});
    return { status: 'pass', reason: 'tracker_status_read', ticket_ref: ref, canonical_status: tracker.status, project_status: tracker.default_status, issue_state: tracker.issue_state, project_id: tracker.project?.id, field_id: tracker.field?.id, item_id: tracker.item?.id };
  } catch (error) { return { status: 'fail', reason: 'tracker_status_unresolved', ticket_ref: ref, violations: [error.message] }; }
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
  const { project } = await githubProjectMetadata(root, settings, run, {});
  const tickets = new Map();
  let cursor = null;
  const cursors = new Set();
  do {
    const query = `query { node(id:${JSON.stringify(project.id)}) { ... on ProjectV2 { items(first:100, after:${JSON.stringify(cursor)}) { pageInfo { hasNextPage endCursor } nodes { content { __typename ... on Issue { number url body } } } } } } }`;
    const response = await json(run, 'gh', ['api', 'graphql', '-f', `query=${query}`], root);
    const page = response.data?.node?.items;
    if (response.errors?.length || !Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('Incomplete Project ticket response');
    for (const { content } of page.nodes) {
      if (content?.__typename !== 'Issue') continue;
      for (const match of (content.body || '').matchAll(/<!-- harness-plan ([^\n]*?) -->/g)) {
        let identity;
        try { identity = JSON.parse(match[1]); } catch { throw new Error('Invalid plan identity in Project Issue'); }
        if (identity.plan_set_id !== planSetId || identity.plan_id === '@parent') continue;
        if (typeof identity.plan_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identity.plan_id) || (!Number.isSafeInteger(content.number) || content.number <= 0) || content.url !== `https://github.com/${settings.repository}/issues/${content.number}`) throw new Error('Invalid plan Issue identity');
        if (tickets.has(identity.plan_id)) throw new Error(`Duplicate Issue for plan: ${identity.plan_id}`);
        tickets.set(identity.plan_id, { plan_id: identity.plan_id, ticket_ref: `${settings.repository}#${content.number}` });
      }
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo.hasNextPage && (!cursor || cursors.has(cursor))) throw new Error('Invalid Project pagination');
    cursors.add(cursor);
  } while (cursor);
  // Older publications can be identified only by a unique match to their reviewed publication body.
  const planDirectory = resolve(root, 'docs/plans', planSetId);
  const names = await readdir(planDirectory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  const missing = names.filter((name) => name.endsWith('.md') && name !== 'plans.md' && !tickets.has(name.slice(0, -3)));
  if (missing.length) {
    const { inspectPublication } = await import('./publication.mjs');
    let publication;
    try { publication = await inspectPublication({ root, planSetId, run: (args, cwd) => run('gh', args, cwd) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const item of publication?.items || []) {
      if (item.plan_id === '@parent' || tickets.has(item.plan_id) || item.content?.__typename !== 'Issue' || !item.body_matches) continue;
      const { number, url } = item.content;
      if (!Number.isSafeInteger(number) || number <= 0 || url !== `https://github.com/${settings.repository}/issues/${number}`) throw new Error('Invalid legacy plan Issue identity');
      tickets.set(item.plan_id, { plan_id: item.plan_id, ticket_ref: `${settings.repository}#${number}` });
    }
  }
  return [...tickets.values()].sort((a, b) => a.plan_id.localeCompare(b.plan_id));
}

// Canonical tracker status of every plan of a plan set, read from the configured tracker (never from a model's report).
// local-markdown: the plan document's own frontmatter status. github: the Workflow Status of the mapped Issue. A plan without a mapped ticket is reported with ticket_ref null; unreadable trackers throw.
export async function readPlanSetTicketStatuses({ workspace_root: root, plan_set_id: planSetId, plan_ids: planIds, run = defaultRun } = {}) {
  if (!planSetId || !Array.isArray(planIds)) throw new Error('A plan set ID and its plan IDs are required');
  const config = await projectConfig(root);
  if (config?.mode === 'local-markdown') {
    const tickets = [];
    for (const planId of planIds) {
      const ref = `docs/plans/${planSetId}/${planId}.md`;
      tickets.push({ plan_id: planId, ticket_ref: ref, status: (await localTicket(root, config, ref)).status });
    }
    return tickets;
  }
  if (config?.mode !== 'github') throw new Error('Exactly one configured tracker mode is required');
  const mapped = new Map((await listPlanTickets({ workspace_root: root, plan_set_id: planSetId, run })).map((ticket) => [ticket.plan_id, ticket]));
  const refs = planIds.map((planId) => mapped.get(planId)?.ticket_ref).filter(Boolean);
  const statuses = refs.length ? await githubTickets(root, config, refs, run, {}) : new Map();
  return planIds.map((planId) => {
    const ticket = mapped.get(planId);
    return { plan_id: planId, ticket_ref: ticket?.ticket_ref ?? null, status: ticket ? statuses.get(ticket.ticket_ref).status : null };
  });
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
    let refs = ticket_refs;
    if (refs === null) {
      let planSetId;
      try { planSetId = JSON.parse(await readFile(resolve(root, '.io/worktree.json'), 'utf8')).plan_set_id; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!planSetId && expected_plan_id) planSetId = expected_plan_id.slice(0, expected_plan_id.lastIndexOf(':'));
      const tickets = planSetId ? await listPlanTickets({ workspace_root: root, plan_set_id: planSetId, run }) : [];
      refs = tickets.filter((ticket) => !expected_plan_id || `${planSetId}:${ticket.plan_id}` === expected_plan_id).map((ticket) => ticket.ticket_ref);
    }
    if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string' || !ref.trim()) || new Set(refs).size !== refs.length) throw new Error('ticket_refs must contain unique exact references');
    if (expected_plan_id && refs.length) {
      const separator = expected_plan_id.lastIndexOf(':');
      const tickets = await listPlanTickets({ workspace_root: root, plan_set_id: expected_plan_id.slice(0, separator), run });
      if (refs.some((ref) => !tickets.some((ticket) => ticket.plan_id === expected_plan_id.slice(separator + 1) && ticket.ticket_ref === ref))) throw new Error('Ticket does not belong to the expected plan');
    }
    const context = {};
    const statuses = config.mode === 'github' && refs.length ? await githubTickets(root, config, refs, run, context) : null;
    const tickets = [];
    for (const ref of refs) tickets.push({ ref, status: (statuses ? statuses.get(ref) : await readTracker(root, config, ref, run, context)).status });
    return { status: 'pass', reason: refs.length ? 'tracker_tickets_current' : 'no_managed_tracker_tickets', violations: [], tickets };
  } catch (error) { return { status: 'fail', reason: 'tracker_status_unresolved', violations: [error.message] }; }
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
  if (expected_plan_id) {
    const check = await inspectTrackerSync({ workspace_root: root, ticket_refs: [ref], expected_plan_id, run });
    if (check.status !== 'pass') throw new Error(check.violations.join('; '));
  }
  const context = {};
  let tracker = await readTracker(root, config, ref, run, context), tracker_updated = false;
  const evidence = sessionOutputPath(root, `runtime/tracker-sync/${createHash('sha256').update(ref).digest('hex')}.jsonl`);
  const writer = await new JsonlEventWriter(resolve(root, evidence), { streamId: `tracker:${ref}` }).init();
  try {
    const desired = status || tracker.status;
    await writer.append('tracker_sync_started', { ticket_ref: ref, desired, previous: tracker.status, phase, classification }, { critical: true });
    if (config.mode === 'github') {
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
    } else if (tracker.status !== desired) {
      const updated = tracker.frontmatter.replace(/^status:[ \t]*[^\r\n]+/m, `status: ${desired}`);
      if (await readFile(tracker.path, 'utf8') !== tracker.content) throw new Error('Local ticket changed concurrently; retry from the latest state');
      const temp = `${tracker.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, tracker.content.replace(tracker.frontmatter, updated), { flag: 'wx', mode: (await lstat(tracker.path)).mode });
        await rename(temp, tracker.path);
      } finally { await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
      tracker_updated = true;
    }
    tracker = await readTracker(root, config, ref, run, context);
    if (tracker.status !== desired) throw new Error('Canonical tracker write did not verify');
    if (tracker.statusField && githubBoardStatus[desired] && tracker.default_status !== githubBoardStatus[desired]) throw new Error('GitHub Project Status write did not verify');
    const result = { status: 'pass', reason: 'tracker_synced', ticket_ref: ref, canonical_status: desired, tracker_updated, evidence_path: evidence };
    await writer.append('tracker_sync', result, { critical: true });
    return result;
  } catch (error) {
    const result = { status: 'fail', reason: 'tracker_sync_failed', ticket_ref: ref, tracker_updated, phase, classification, violations: [error.message], retry: 'Read the latest tracker status before retrying', evidence_path: evidence };
    await writer.append('tracker_sync', result, { critical: true });
    return result;
  } finally { await writer.close(); }
}
