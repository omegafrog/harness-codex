import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseYaml } from '../eval/yaml.mjs';
import { sessionOutputPath } from '../workflow/session-output.mjs';
import { inspectPlanSet, snapshotPlanSet } from '../workflow/plan-review.mjs';
import { TRACKER_STATES } from './lifecycle.mjs';

const exec = promisify(execFile);
const defaultRun = async (args, cwd) => (await exec('gh', args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })).stdout;

function publicationBodyPath(planId) {
  return `runtime/to-ticket/publication-bodies/${planId === '@parent' ? 'parent' : planId}.md`;
}

function executionBlock(workspace) {
  return `<details><summary>실행 정보</summary>\n\n- workspace_root: \`${workspace.workspace_root}\`\n- workspace_branch: \`${workspace.workspace_branch}\`\n\n</details>`;
}

export async function preparePublicationDrafts({ root, planSetId }) {
  const snapshot = await snapshotPlanSet({ root, planSetId });
  const review = await inspectPlanSet({ root, planSetId, phase: 'planning' });
  if (review.status !== 'pass' || !snapshot.execution_workspace) throw new Error('Publication bodies require a reviewed plan set and canonical execution workspace');
  const drafts = [];
  for (const planId of ['@parent', ...snapshot.plans.map((plan) => plan.id)]) {
    const source = sessionOutputPath(root, `runtime/to-ticket/drafts/${planId === '@parent' ? 'parent' : planId}.md`, { create: false });
    let body = await readFile(source, 'utf8');
    if (!body.trim()) throw new Error(`Publication draft body is empty: ${planId}`);
    // Legacy plan locations are display text, never runtime authority.
    const legacy = [...snapshot.plans.map((plan) => plan.body), body].join('\n');
    for (const match of legacy.matchAll(/^\s*-?\s*workspace_(root|branch):\s*`([^`]+)`/gm)) {
      if (match[1] === 'root') body = body.replaceAll(`\`${match[2]}\``, `\`${snapshot.execution_workspace.workspace_root}\``);
      else body = body.replaceAll(`branch \`${match[2]}\``, `branch \`${snapshot.execution_workspace.workspace_branch}\``);
    }
    body = body.replace(/<details><summary>실행 정보<\/summary>[\s\S]*?<\/details>\s*/g, '')
      .replace(/^\s*-?\s*workspace_(?:root|branch):[^\n]*(?:\n|$)/gm, '').trimEnd();
    body += `\n\n${executionBlock(snapshot.execution_workspace)}\n\n${marker(planSetId, planId)}\n`;
    const path = publicationBodyPath(planId);
    const target = sessionOutputPath(root, path);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, body, { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
    drafts.push({ plan_id: planId, body_path: path, body_sha256: createHash('sha256').update(body).digest('hex') });
  }
  return drafts;
}

const normalizeBody = (body) => body.replace(/<!-- harness-plan [^\n]* -->/g, '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
const marker = (set, plan) => `<!-- harness-plan ${JSON.stringify({ plan_set_id: set, plan_id: plan })} -->`;

export async function inspectPublication({ root, planSetId, run = defaultRun }) {
  const tracker = parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8')).tracker;
  if (tracker?.mode !== 'github') throw new Error('Project publication requires GitHub tracker mode');
  const settings = tracker.github;
  if (!/^[\w-]+$/.test(settings?.project_owner || '') || !Number.isInteger(settings.project_number) || settings.project_number <= 0 || !settings.status_field || settings.status_field === 'Status') throw new Error('Invalid configured GitHub project');
  const get = async (args) => JSON.parse(await run(args, root));
  const project = await get(['project', 'view', String(settings.project_number), '--owner', settings.project_owner, '--format', 'json']);
  const fields = await get(['project', 'field-list', String(settings.project_number), '--owner', settings.project_owner, '--format', 'json', '--limit', '100']);
  const field = fields.fields?.filter((f) => f.name === settings.status_field && f.type === 'ProjectV2SingleSelectField');
  if (!project.id || fields.totalCount > fields.fields?.length || field?.length !== 1) throw new Error('Incomplete or ambiguous Project metadata');
  const planned = field[0].options?.filter((o) => o.name === 'Planned');
  const nodes = [];
  let cursor = null;
  const cursors = new Set();
  do {
    const query = `query { node(id:${JSON.stringify(project.id)}) { ... on ProjectV2 { items(first:100, after:${JSON.stringify(cursor)}) { pageInfo { hasNextPage endCursor } nodes { id content { __typename ... on DraftIssue { title body } ... on Issue { title body number url } } fieldValues(first:100) { pageInfo { hasNextPage } nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { id } } } } } } } } } }`;
    const response = await get(['api', 'graphql', '-f', `query=${query}`]);
    const page = response.data?.node?.items;
    if (response.errors?.length || !Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('Incomplete Project publication response');
    nodes.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo.hasNextPage && (!cursor || cursors.has(cursor))) throw new Error('Invalid Project pagination');
    cursors.add(cursor);
  } while (cursor);
  const drafts = await preparePublicationDrafts({ root, planSetId });
  const items = [];
  for (const draft of drafts) {
    const body = await readFile(sessionOutputPath(root, draft.body_path, { create: false }), 'utf8');
    const identity = marker(planSetId, draft.plan_id);
    const matches = nodes.filter((n) => n?.content && (n.content.body?.includes(identity) || normalizeBody(n.content.body || '') === normalizeBody(body)));
    if (matches.length > 1) throw new Error(`Duplicate Project items for plan: ${draft.plan_id}`);
    const node = matches[0];
    if (node) {
      if (node.fieldValues?.pageInfo?.hasNextPage !== false) throw new Error('Incomplete Project item status');
      const statuses = node.fieldValues.nodes.filter((v) => v.field?.id === field[0].id);
      items.push({ ...draft, item_id: node.id, content: node.content, status: statuses.length === 1 ? statuses[0].name : null, identity_matches: node.content.body?.includes(identity) || false, body_matches: normalizeBody(node.content.body || '') === normalizeBody(body) });
    } else items.push({ ...draft, item_id: null });
  }
  if (new Set(items.filter((i) => i.item_id).map((i) => i.item_id)).size !== items.filter((i) => i.item_id).length) throw new Error('One Project item matches multiple plans');
  const matchedIds = new Set(items.map((item) => item.item_id));
  if (nodes.some((node) => ['DraftIssue', 'Issue'].includes(node.content?.__typename) && !matchedIds.has(node.id) && (node.content.body?.includes(planSetId) || node.content.title?.includes(planSetId)))) throw new Error('Unidentified Project item references this plan set; resolve duplicates before publishing');
  return { plan_set_id: planSetId, project_id: project.id, status_field_id: field[0].id, planned_option_id: planned?.length === 1 ? planned[0].id : null, items };
}

export async function updatePublication({ root, planSetId, planId, action, itemId, run = defaultRun }) {
  if (!['inspect', 'begin', 'record', 'publish', 'activate'].includes(action)) throw new Error('Invalid publication action');
  if (action === 'inspect') return inspectPublication({ root, planSetId, run });
  if (action === 'activate') return activatePublication({ root, planSetId });
  const lock = sessionOutputPath(root, 'runtime/to-ticket/publication.lock');
  await mkdir(lock);
  try {
    const state = await inspectPublication({ root, planSetId, run });
    const item = state.items.find((i) => i.plan_id === planId);
    if (!item) throw new Error('Plan does not belong to the reviewed plan set');
    if (action === 'record') {
      if (!item.item_id || item.item_id !== itemId || !item.body_matches) throw new Error('Creation response does not match the actual Project item');
      return { status: 'verified', ...item };
    }
    if (action === 'begin') return { ...item, status: item.item_id ? 'already_created' : 'pending' };
    if (item.item_id && item.content.__typename === 'Issue') {
      if (item.identity_matches || item.body_matches) return { ...item, status: 'already_published' };
      throw new Error(`Converted Issue identity does not match the reviewed publication body: ${planId}`);
    }
    if (!state.planned_option_id) throw new Error('Planned Project status option is unavailable');
    if (item.item_id && item.content.__typename !== 'DraftIssue') throw new Error('Project item is already converted to an Issue');
    if (item.item_id && !item.body_matches) throw new Error(`Project body differs from reviewed publication body: ${planId}`);
    let id = item.item_id;
    if (!id) {
      const body = await readFile(sessionOutputPath(root, item.body_path, { create: false }), 'utf8');
      const title = await publicationTitle(root, planSetId, planId);
      const mutation = `mutation { addProjectV2DraftIssue(input:{projectId:${JSON.stringify(state.project_id)},title:${JSON.stringify(title)},body:${JSON.stringify(body)}}) { projectItem { id } } }`;
      const response = JSON.parse(await run(['api', 'graphql', '-f', `query=${mutation}`], root));
      id = response.data?.addProjectV2DraftIssue?.projectItem?.id;
      if (response.errors?.length || !id) throw new Error('Ambiguous creation response; inspect the Project before retrying');
    }
    const mutation = `mutation { updateProjectV2ItemFieldValue(input:{projectId:${JSON.stringify(state.project_id)},itemId:${JSON.stringify(id)},fieldId:${JSON.stringify(state.status_field_id)},value:{singleSelectOptionId:${JSON.stringify(state.planned_option_id)}}}) { projectV2Item { id } } }`;
    const response = JSON.parse(await run(['api', 'graphql', '-f', `query=${mutation}`], root));
    if (response.errors?.length || response.data?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== id) throw new Error('Project status update failed');
    const verified = (await inspectPublication({ root, planSetId, run })).items.find((i) => i.plan_id === planId);
    if (verified.item_id !== id || !verified.body_matches || verified.status !== 'Planned') throw new Error('Published Project item verification failed');
    return { ...verified, status: 'published' };
  } finally { await rm(lock, { recursive: true }); }
}

export async function publicationTitle(root, planSetId, planId) {
  const path = planId === '@parent' ? `docs/plans/${planSetId}/plans.md` : `docs/plans/${planSetId}/${planId}.md`;
  const source = await readFile(join(root, path), 'utf8');
  const title = source.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  if (!title) throw new Error(`Publication title heading is missing: ${path}`);
  return `${planId === '@parent' ? '[Harness Plan Set]' : '[Harness Plan]'} ${title}`;
}

export async function verifyDraftPublication({ root, planSetId, run = defaultRun }) {
  const config = parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8')).tracker;
  if (config?.mode !== 'github') return;
  const state = await inspectPublication({ root, planSetId, run });
  const issueStatuses = new Set(Object.values(TRACKER_STATES).map(([label]) => label));
  for (const item of state.items) {
    if (item.content?.__typename === 'Issue') {
      if (!item.item_id || !(item.identity_matches || item.body_matches) || !issueStatuses.has(item.status)) throw new Error(`Converted Project Issue identity or status is unresolved: ${item.plan_id}`);
    } else if (!item.item_id || !item.body_matches || item.content?.__typename !== 'DraftIssue' || item.status !== 'Planned') throw new Error(`Draft publication is missing, changed or not Planned: ${item.plan_id}`);
  }
  return state;
}

const defaultCommand = async (command, args, cwd) => (await exec(command, args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })).stdout;

// Plan dependencies come from the reviewed index: each table row starts with the plan link, and plan IDs named in
// its dependency column are what that plan waits for.
async function planDependencies(root, planSetId, planIds) {
  const index = await readFile(join(root, 'docs/plans', planSetId, 'plans.md'), 'utf8');
  const dependencies = new Map(planIds.map((id) => [id, []]));
  const pattern = (id) => new RegExp(`(^|[^\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`);
  // Columns are found by header, so a leading order or Issue column does not shift them.
  let dependencyColumn = null;
  for (const line of index.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const header = cells.findIndex((cell) => /^(의존성|dependencies|depends on)$/i.test(cell));
    if (header >= 0) { dependencyColumn = header; continue; }
    if (dependencyColumn === null) continue;
    const owner = planIds.find((id) => cells.some((cell, index) => index !== dependencyColumn && (cell.includes(`[${id}]`) || cell === id || cell === `\`${id}\``)));
    if (!owner) continue;
    dependencies.set(owner, planIds.filter((id) => id !== owner && pattern(id).test(cells[dependencyColumn] || '')));
  }
  return dependencies;
}

// Turns an approved, published plan set into the tracker state implementation starts from: every Project draft
// becomes a repository Issue, children are sub-issues of the parent, and each Issue has its Beads mirror with the
// plan dependencies. Every step reads the current state first, so a rerun after a partial failure only does what
// is missing. The result is verified with the same tracker check implementation uses.
export async function activatePublication({ root, planSetId, run = defaultCommand }) {
  const gh = (args, cwd) => run('gh', args, cwd);
  const ghJson = async (args) => JSON.parse(await gh(args, root));
  const config = parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8'));
  const repository = config.tracker?.github?.repository;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Configured GitHub repository is required to activate the plan set');
  let state = await inspectPublication({ root, planSetId, run: gh });
  const missing = state.items.filter((item) => !item.item_id).map((item) => item.plan_id);
  if (missing.length) throw new Error(`Publish these plans before activation: ${missing.join(', ')}`);
  const drafts = state.items.filter((item) => item.content?.__typename === 'DraftIssue');
  if (drafts.length) {
    const repositoryId = (await ghJson(['repo', 'view', repository, '--json', 'id'])).id;
    if (!repositoryId) throw new Error('Repository ID is unavailable');
    for (const item of drafts) {
      const mutation = `mutation { convertProjectV2DraftIssueItemToIssue(input:{itemId:${JSON.stringify(item.item_id)},repositoryId:${JSON.stringify(repositoryId)}}) { item { id } } }`;
      let response;
      try { response = JSON.parse(await gh(['api', 'graphql', '-f', `query=${mutation}`], root)); } catch (error) { response = { errors: [{ message: error.message }] }; }
      // An unclear response is resolved by reading the Project again, never by converting a second time.
      const current = (await inspectPublication({ root, planSetId, run: gh })).items.find((entry) => entry.plan_id === item.plan_id);
      if (current?.content?.__typename !== 'Issue') throw new Error(`Draft conversion did not produce an Issue for ${item.plan_id}: ${(response.errors || []).map((error) => error.message).join('; ') || 'no Issue in the Project item'}`);
    }
    state = await inspectPublication({ root, planSetId, run: gh });
  }
  const byPlan = new Map(state.items.map((item) => [item.plan_id, item]));
  for (const item of state.items) {
    if (item.content?.__typename !== 'Issue' || !item.content.number) throw new Error(`Project item is not an Issue: ${item.plan_id}`);
    if (!(item.identity_matches || item.body_matches)) throw new Error(`Issue body does not match the reviewed plan: ${item.plan_id}`);
    if (!item.status) {
      if (!state.planned_option_id) throw new Error('Planned Project status option is unavailable');
      const mutation = `mutation { updateProjectV2ItemFieldValue(input:{projectId:${JSON.stringify(state.project_id)},itemId:${JSON.stringify(item.item_id)},fieldId:${JSON.stringify(state.status_field_id)},value:{singleSelectOptionId:${JSON.stringify(state.planned_option_id)}}}) { projectV2Item { id } } }`;
      const response = JSON.parse(await gh(['api', 'graphql', '-f', `query=${mutation}`], root));
      if (response.errors?.length) throw new Error(`Setting Planned failed for ${item.plan_id}`);
    }
  }
  const [owner, name] = repository.split('/');
  const taxonomyLabels = [
    ['harness:plan-set', 'Harness generated plan set'],
    ['harness:plan', 'Harness generated plan'],
    ['harness:intake', 'Human-created Harness intake'],
  ];
  const labels = JSON.parse(await gh(['label', 'list', '--repo', repository, '--limit', '1000', '--json', 'name']));
  if (!Array.isArray(labels) || labels.some((label) => typeof label?.name !== 'string')) throw new Error('Repository labels response is incomplete');
  const existingLabels = new Set(labels.map((label) => label.name));
  for (const [label, description] of taxonomyLabels) {
    if (!existingLabels.has(label)) await gh(['label', 'create', label, '--repo', repository, '--color', '5319e7', '--description', description]);
  }
  for (const item of state.items) {
    const label = item.plan_id === '@parent' ? 'harness:plan-set' : 'harness:plan';
    await gh(['issue', 'edit', String(item.content.number), '--repo', repository, '--add-label', label]);
  }
  const parent = byPlan.get('@parent');
  const children = state.items.filter((item) => item.plan_id !== '@parent');
  const issueQuery = (number) => `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) { issue(number:${number}) { id subIssues(first:100) { nodes { id } } } } }`;
  const parentIssue = (await ghJson(['api', 'graphql', '-f', `query=${issueQuery(parent.content.number)}`])).data?.repository?.issue;
  if (!parentIssue?.id) throw new Error('Parent Issue is unavailable');
  const linked = new Set(parentIssue.subIssues.nodes.map((node) => node.id));
  for (const child of children) {
    const childId = (await ghJson(['api', 'graphql', '-f', `query=${issueQuery(child.content.number)}`])).data?.repository?.issue?.id;
    if (!childId) throw new Error(`Child Issue is unavailable: ${child.plan_id}`);
    if (linked.has(childId)) continue;
    const response = JSON.parse(await gh(['api', 'graphql', '-f', `query=mutation { addSubIssue(input:{issueId:${JSON.stringify(parentIssue.id)},subIssueId:${JSON.stringify(childId)}}) { subIssue { id } } }`], root));
    if (response.errors?.length) throw new Error(`Linking ${child.plan_id} under the parent failed: ${response.errors.map((error) => error.message).join('; ')}`);
  }
  const refs = state.items.map((item) => `${repository}#${item.content.number}`);
  if (config.beads?.enabled !== false) {
    const bd = async (args) => run('bd', args, root);
    const mirrors = new Map();
    const statusOf = (item) => ({ 'In Progress': 'in_progress', Blocked: 'blocked', Done: 'closed' })[item.status] || 'open';
    for (const item of [parent, ...children]) {
      const externalRef = `https://github.com/${repository}/issues/${item.content.number}`;
      const existing = JSON.parse(await bd(['list', '--all', '--json', '--limit', '0', '--external-ref', externalRef])).filter((bead) => bead.external_ref === externalRef);
      if (existing.length > 1) throw new Error(`Several Beads mirror ${externalRef}`);
      if (existing.length) { mirrors.set(item.plan_id, existing[0].id); continue; }
      const metadata = JSON.stringify({ harness_tracker_version: 1, harness_phase: 'planning', harness_classification: 'committed', harness_plan_id: `${planSetId}:${item.plan_id === '@parent' ? 'parent' : item.plan_id}` });
      const args = ['create', '--title', `${planSetId} / ${item.plan_id === '@parent' ? 'parent' : item.plan_id}`, '--type', item.plan_id === '@parent' ? 'epic' : 'feature', '--status', statusOf(item), '--external-ref', externalRef, '--metadata', metadata, '--silent'];
      if (item.plan_id !== '@parent') args.push('--parent', mirrors.get('@parent'));
      const id = (await bd(args)).trim().split(/\s+/).pop();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id || '')) throw new Error(`Beads did not return an ID for ${item.plan_id}`);
      mirrors.set(item.plan_id, id);
    }
    const dependencies = await planDependencies(root, planSetId, children.map((child) => child.plan_id));
    for (const [planId, needs] of dependencies) {
      const shown = JSON.parse(await bd(['show', mirrors.get(planId), '--json']));
      const current = new Set((Array.isArray(shown) ? shown[0] : shown)?.dependencies?.map((dependency) => dependency.id || dependency.depends_on_id) || []);
      for (const need of needs) {
        if (current.has(mirrors.get(need))) continue;
        try { await bd(['dep', 'add', mirrors.get(planId), mirrors.get(need)]); }
        catch (error) { if (!/already|exists|duplicate/i.test(error.message)) throw error; }
      }
    }
  }
  const { inspectTrackerSync } = await import('./lifecycle.mjs');
  const check = await inspectTrackerSync({ workspace_root: root, ticket_refs: refs, run });
  if (check.status !== 'pass') throw new Error(`Activated tracker does not verify: ${check.violations.join('; ')}`);
  return { status: 'activated', plan_set_id: planSetId, issues: state.items.map((item) => ({ plan_id: item.plan_id, number: item.content.number, url: item.content.url })), tracker_check: check };
}

// tracker-publish is complete only when implementation can start: every plan is an Issue in the Project and the
// tracker check (Issue status and Beads mirror) passes.
export async function verifyActivatedPublication({ root, planSetId, run = defaultCommand }) {
  const config = parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8'));
  if (config.tracker?.mode !== 'github') return;
  const state = await inspectPublication({ root, planSetId, run: (args, cwd) => run('gh', args, cwd) });
  const pending = state.items.filter((item) => item.content?.__typename !== 'Issue').map((item) => item.plan_id);
  if (pending.length) throw new Error(`Plans are not activated as Issues yet (run harness-publication.mjs activate): ${pending.join(', ')}`);
  const { inspectTrackerSync } = await import('./lifecycle.mjs');
  const check = await inspectTrackerSync({ workspace_root: root, ticket_refs: state.items.map((item) => `${config.tracker.github.repository}#${item.content.number}`), run });
  if (check.status !== 'pass') throw new Error(`Activated tracker does not verify: ${check.violations.join('; ')}`);
  return state;
}
