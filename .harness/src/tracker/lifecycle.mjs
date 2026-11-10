import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, lstat, rename, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseYaml } from '../eval/yaml.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { sessionOutputPath } from '../workflow/session-output.mjs';
import { JsonlEventWriter } from '../eval/journal.mjs';

const exec = promisify(execFile);
export const TRACKER_STATES = Object.freeze({ planned: ['Planned', 'open'], 'in-progress': ['In Progress', 'in_progress'], blocked: ['Blocked', 'blocked'], completed: ['Done', 'closed'] });
const PHASES = new Set(['planning', 'implementation', 'test', 'review']);
const CLASSIFICATIONS = new Set(['backlog', 'committed']);
const canonical = (value) => Object.keys(TRACKER_STATES).find((key) => key === value || TRACKER_STATES[key][0] === value);
const defaultRun = async (command, args, cwd) => (await exec(command, args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })).stdout;
const json = async (run, command, args, root) => JSON.parse(await run(command, args, root));
const single = (items, label) => { if (!Array.isArray(items) || items.length !== 1) throw new Error(`${label}: expected exactly one match`); return items[0]; };

async function projectConfig(root) {
  if (!isAbsolute(root || '')) throw new Error('Absolute workspace_root is required');
  return parseYaml(await readFile(resolve(root, '.codex/harness.yaml'), 'utf8')).tracker;
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
    return { project, field };
  })();
  return context.githubProjectMetadata;
}
function githubIssueStatus(issue, ref, project, field) {
  if (!issue || issue.projectItems.pageInfo.hasNextPage) throw new Error(`Missing issue or incomplete project item pagination: ${ref}`);
  const item = single(issue.projectItems.nodes.filter((i) => i.project.id === project.id), 'Configured project item');
  if (item.fieldValues.pageInfo.hasNextPage) throw new Error('Incomplete project field pagination');
  const value = single(item.fieldValues.nodes.filter((v) => v.field?.id === field.id), 'Configured status value');
  const status = canonical(value.name);
  if (!status) throw new Error(`Unsupported Workflow Status: ${value.name}`);
  if (issue.state !== 'OPEN' && status !== 'completed') throw new Error('A closed GitHub issue cannot have an unfinished Workflow Status');
  return { status, project, field, item, issue_state: issue.state };
}

function githubReference(config, ref) {
  const settings = config.github;
  if (!settings || !/^[\w.-]+\/[\w.-]+$/.test(settings.repository || '') || !/^[\w-]+$/.test(settings.project_owner || '') || !Number.isInteger(settings.project_number) || settings.project_number <= 0 || !settings.status_field || settings.status_field === 'Status') throw new Error('Invalid configured GitHub Workflow Status project');
  const match = ref.match(/^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/);
  if (!match || match[1] !== settings.repository) throw new Error('Ticket reference must match configured repository');
  return { settings, owner: match[1].split('/')[0], repo: match[1].split('/')[1], number: Number(match[2]) };
}
function beadsExternalRef(config, ref) {
  if (config.mode !== 'github') return ref;
  const { settings, number } = githubReference(config, ref);
  return `https://github.com/${settings.repository}/issues/${number}`;
}
function trackerReference(config, externalRef) {
  if (config.mode !== 'github') return externalRef;
  const match = externalRef.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)$/);
  if (!match || match[1] !== config.github?.repository) throw new Error('Beads external_ref does not match the configured GitHub repository');
  return `${match[1]}#${match[2]}`;
}

async function githubTickets(root, config, refs, run, context) {
  const { settings } = githubReference(config, refs[0]);
  const { project, field } = await githubProjectMetadata(root, settings, run, context);
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
    batch.forEach((item, index) => results.set(item.ref, githubIssueStatus(repository[`issue_${index}`], item.ref, project, field)));
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
    return { status: 'pass', reason: 'tracker_status_read', ticket_ref: ref, canonical_status: tracker.status, issue_state: tracker.issue_state, project_id: tracker.project?.id, field_id: tracker.field?.id, item_id: tracker.item?.id };
  } catch (error) { return { status: 'fail', reason: 'tracker_status_unresolved', ticket_ref: ref, violations: [error.message] }; }
}
async function mirror(root, ref, run, config) {
  const externalRef = beadsExternalRef(config, ref);
  const items = await json(run, 'bd', ['list', '--all', '--json', '--limit', '0', '--external-ref', externalRef], root);
  const bead = single(items.filter((item) => item.external_ref === externalRef), 'Beads external_ref');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(bead.id || '')) throw new Error('Invalid Beads ID');
  if (bead.metadata?.harness_tracker_version !== 1) throw new Error('Ticket is not registered for lifecycle v1');
  return bead;
}
// A stage implements one plan. Its tickets are checked against that plan so a guessed Issue number cannot move another
// plan's ticket (the community-comment stage once completed the e2e Issue).
function assertTicketPlan(bead, expectedPlanId, ref) {
  if (!expectedPlanId) return;
  const actual = bead?.metadata?.harness_plan_id;
  if (actual !== expectedPlanId) throw new Error(`Ticket ${ref} belongs to plan ${actual || 'unknown'}, but this execution implements ${expectedPlanId}; take the ticket from harness-context.mjs plan_tickets`);
}

// Plan ID → ticket reference of one plan set, read from the Beads mirrors that tracker-publish created.
export async function listPlanTickets({ workspace_root: root, plan_set_id: planSetId, run = defaultRun } = {}) {
  if (!planSetId) return [];
  const config = await projectConfig(root);
  const items = await json(run, 'bd', ['list', '--all', '--json', '--limit', '0', '--metadata-field', 'harness_tracker_version=1'], root);
  return items
    .filter((item) => String(item.metadata?.harness_plan_id || '').startsWith(`${planSetId}:`) && item.external_ref)
    .map((item) => ({ plan_id: item.metadata.harness_plan_id.slice(planSetId.length + 1), ticket_ref: trackerReference(config, item.external_ref), bead_id: item.id, bead_status: item.status }))
    .sort((a, b) => a.plan_id.localeCompare(b.plan_id));
}

// Which plans must be finished before this plan, read from the plan's own "의존성" section (backticked plan IDs of the
// same plan set), and whether each one's Beads ticket is closed. The stage reads this answer instead of matching Issue
// numbers to plans by hand, which has mistaken the plan's own ticket for a prerequisite.
export async function planDependencies({ workspace_root: root, plan_set_id: planSetId, plan_id: planId, run = defaultRun } = {}) {
  if (!planSetId || !planId) throw new Error('dependencies needs a plan-set worktree and a plan ID');
  const tickets = await listPlanTickets({ workspace_root: root, plan_set_id: planSetId, run });
  const known = new Set(tickets.map((ticket) => ticket.plan_id));
  const text = await readFile(resolve(root, 'docs/plans', planSetId, `${planId}.md`), 'utf8');
  const section = /^##\s+의존성[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  // Only sentences that say "선행" name prerequisites; plans mentioned elsewhere (downstream checks) are not dependencies.
  const prerequisite = section.split(/(?<=[.。])\s+|\n+/).filter((sentence) => sentence.includes('선행')).join(' ');
  const ids = [...new Set([...prerequisite.matchAll(/`([A-Za-z0-9][A-Za-z0-9._-]*)`/g)].map((match) => match[1]))].filter((id) => id !== planId && known.has(id));
  const dependencies = ids.map((id) => {
    const ticket = tickets.find((item) => item.plan_id === id);
    return { plan_id: id, ticket_ref: ticket.ticket_ref, bead_status: ticket.bead_status, complete: ticket.bead_status === 'closed' };
  });
  const incomplete = dependencies.filter((item) => !item.complete);
  return { status: incomplete.length ? 'blocked' : 'pass', plan_id: planId, dependencies, incomplete: incomplete.map((item) => item.plan_id) };
}

function metadataValid(bead) {
  if (!PHASES.has(bead.metadata?.harness_phase)) throw new Error('Invalid harness_phase');
  if (!CLASSIFICATIONS.has(bead.metadata?.harness_classification)) throw new Error('Invalid harness_classification');
}

async function worktreePlanSetId(root) {
  try { return JSON.parse(await readFile(resolve(root, '.io/worktree.json'), 'utf8')).plan_set_id || null; }
  catch { return null; }
}

export async function inspectTrackerSync({ workspace_root: root, ticket_refs = null, expected_plan_id = null, run = defaultRun } = {}) {
  try {
    let refs = ticket_refs;
    let config = null;
    let beadsDisabled = false;
    if (isAbsolute(root || '')) {
      try { beadsDisabled = parseYaml(await readFile(resolve(root, '.codex/harness.yaml'), 'utf8')).beads?.enabled === false; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (refs === null) {
      if (beadsDisabled) return { status: 'pass', reason: 'no_managed_tracker_tickets', violations: [] };
      // Only versioned mirrors belong to this policy; older/local operational Beads are untouched.
      if (!isAbsolute(root || '')) throw new Error('Absolute workspace_root is required');
      let beadsRoot = resolve(root, '.beads');
      try { await lstat(beadsRoot); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const common = (await run('git', ['rev-parse', '--git-common-dir'], root)).trim();
        beadsRoot = resolve(dirname(resolve(root, common)), '.beads');
        try { await lstat(beadsRoot); } catch (sharedError) {
          if (sharedError.code !== 'ENOENT') throw sharedError;
          return { status: 'pass', reason: 'no_managed_tracker_tickets', violations: [] };
        }
      }
      config = await projectConfig(root);
      const items = await json(run, 'bd', ['list', '--all', '--json', '--limit', '0', '--metadata-field', 'harness_tracker_version=1'], root);
      // In a workflow worktree the check covers that plan set's tickets: tickets of other, finished plan sets are not this
      // workflow's concern, and reading every mirror in the repository took longer each run (about a minute at 44 mirrors).
      const planSetId = await worktreePlanSetId(root);
      const scoped = planSetId ? items.filter((item) => String(item.metadata?.harness_plan_id || '').startsWith(`${planSetId}:`)) : items;
      if (scoped.some((item) => !item.external_ref)) throw new Error('Managed mirror is missing external_ref');
      refs = scoped.map((item) => trackerReference(config, item.external_ref));
    }
    if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string' || !ref.trim()) || new Set(refs).size !== refs.length) throw new Error('ticket_refs must contain unique exact references');
    if (!refs.length) return { status: 'pass', reason: 'no_managed_tracker_tickets', violations: [] };
    config ||= await projectConfig(root);
    const tickets = [], context = {};
    const githubStatuses = config.mode === 'github' ? await githubTickets(root, config, refs, run, context) : null;
    for (const ref of refs) {
      if (beadsDisabled) {
        const tracker = githubStatuses ? githubStatuses.get(ref) : await readTracker(root, config, ref, run, context);
        tickets.push({ ref, status: tracker.status });
        continue;
      }
      const bead = await mirror(root, ref, run, config);
      assertTicketPlan(bead, expected_plan_id, ref);
      const tracker = githubStatuses ? githubStatuses.get(ref) : await readTracker(root, config, ref, run, context);
      metadataValid(bead);
      if (tracker.status === 'in-progress' && bead.metadata.harness_classification === 'backlog') throw new Error(`Backlog cannot be executing: ${ref}`);
      if (bead.status !== TRACKER_STATES[tracker.status][1]) throw new Error(`Mirror mismatch: ${ref}; canonical=${tracker.status}, beads=${bead.status}`);
      tickets.push({ ref, bead_id: bead.id, status: tracker.status });
    }
    return { status: 'pass', reason: beadsDisabled ? 'tracker_tickets_current' : 'tracker_mirrors_current', violations: [], tickets };
  } catch (error) { return { status: 'fail', reason: 'tracker_mirror_unresolved', violations: [error.message] }; }
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
  if (phase !== null && !PHASES.has(phase)) throw new Error('Invalid phase');
  if (classification !== null && !CLASSIFICATIONS.has(classification)) throw new Error('Invalid classification');
  const config = await projectConfig(root);
  const beadsEnabled = parseYaml(await readFile(resolve(root, '.codex/harness.yaml'), 'utf8')).beads?.enabled !== false;
  const bead = beadsEnabled ? await mirror(root, ref, run, config) : null;
  if (bead) assertTicketPlan(bead, expected_plan_id, ref);
  if (bead) metadataValid({ metadata: { ...bead.metadata, ...(phase ? { harness_phase: phase } : {}), ...(classification ? { harness_classification: classification } : {}) } });
  const context = {};
  let tracker = await readTracker(root, config, ref, run, context), tracker_updated = false;
  const evidence = sessionOutputPath(root, `runtime/tracker-sync/${createHash('sha256').update(ref).digest('hex')}.jsonl`);
  const writer = await new JsonlEventWriter(resolve(root, evidence), { streamId: `tracker:${ref}` }).init();
  try {
    const desired = status || tracker.status;
    if (desired === 'in-progress' && (classification || bead?.metadata.harness_classification) === 'backlog') throw new Error('Commit backlog classification before starting execution');
    await writer.append('tracker_sync_started', { ticket_ref: ref, desired, previous: tracker.status, phase, classification }, { critical: true });
    if (tracker.status !== desired) {
      if (config.mode === 'github') {
        const option = single(tracker.field.options.filter((o) => o.name === TRACKER_STATES[desired][0]), 'Status option');
        await run('gh', ['project', 'item-edit', '--id', tracker.item.id, '--project-id', tracker.project.id, '--field-id', tracker.field.id, '--single-select-option-id', option.id], root);
      } else {
        const updated = tracker.frontmatter.replace(/^status:[ \t]*[^\r\n]+/m, `status: ${desired}`);
        if (await readFile(tracker.path, 'utf8') !== tracker.content) throw new Error('Local ticket changed concurrently; retry from the latest state');
        const temp = `${tracker.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, tracker.content.replace(tracker.frontmatter, updated), { flag: 'wx', mode: (await lstat(tracker.path)).mode });
          await rename(temp, tracker.path);
        } finally { await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
      }
      tracker_updated = true;
    }
    tracker = await readTracker(root, config, ref, run, context);
    if (tracker.status !== desired) throw new Error('Canonical tracker write did not verify');
    if (!bead) {
      const result = { status: 'pass', reason: 'tracker_synced', ticket_ref: ref, canonical_status: desired, tracker_updated, evidence_path: evidence };
      await writer.append('tracker_sync', result, { critical: true });
      return result;
    }
    const expected = TRACKER_STATES[desired][1];
    if (bead.status !== expected) {
      await run('bd', expected === 'closed' ? ['close', bead.id, '--reason', 'Canonical tracker implementation verification completed'] : ['update', bead.id, '--status', expected], root);
    }
    if (phase || classification) {
      const args = ['update', bead.id];
      if (phase) args.push('--set-metadata', `harness_phase=${phase}`);
      if (classification) args.push('--set-metadata', `harness_classification=${classification}`);
      await run('bd', args, root);
    }
    const verified = single(await json(run, 'bd', ['show', bead.id, '--json'], root), 'Beads verification');
    if (verified.external_ref !== beadsExternalRef(config, ref) || verified.status !== expected || (phase && verified.metadata?.harness_phase !== phase) || (classification && verified.metadata?.harness_classification !== classification)) throw new Error('Beads write did not verify');
    metadataValid(verified);
    const current = await readTracker(root, config, ref, run, context);
    if (current.status !== desired) throw new Error('Canonical state changed during mirror write; retry from the latest state');
    const result = { status: 'pass', reason: 'tracker_mirror_synced', ticket_ref: ref, canonical_status: desired, bead_id: bead.id, tracker_updated, evidence_path: evidence };
    await writer.append('tracker_sync', result, { critical: true });
    return result;
  } catch (error) {
    const result = { status: 'fail', reason: 'tracker_mirror_sync_failed', ticket_ref: ref, tracker_updated, phase, classification, violations: [error.message], retry: 'Rerun sync without --status, preserving recorded --phase/--classification; mirror the latest canonical state and never roll it back', evidence_path: evidence };
    await writer.append('tracker_sync', result, { critical: true });
    return result;
  } finally { await writer.close(); }
}
