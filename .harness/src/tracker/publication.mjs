import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseYaml } from '../eval/yaml.mjs';
import { sessionOutputPath } from '../workflow/session-output.mjs';
import { inspectPlanSet, snapshotPlanSet } from '../workflow/plan-review.mjs';

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
  const tracker = parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8')).tracker;
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
      items.push({ ...draft, item_id: node.id, content: node.content, status: statuses.length === 1 ? statuses[0].name : null, body_matches: normalizeBody(node.content.body || '') === normalizeBody(body) });
    } else items.push({ ...draft, item_id: null });
  }
  if (new Set(items.filter((i) => i.item_id).map((i) => i.item_id)).size !== items.filter((i) => i.item_id).length) throw new Error('One Project item matches multiple plans');
  const matchedIds = new Set(items.map((item) => item.item_id));
  if (nodes.some((node) => ['DraftIssue', 'Issue'].includes(node.content?.__typename) && !matchedIds.has(node.id) && (node.content.body?.includes(planSetId) || node.content.title?.includes(planSetId)))) throw new Error('Unidentified Project item references this plan set; resolve duplicates before publishing');
  return { plan_set_id: planSetId, project_id: project.id, status_field_id: field[0].id, planned_option_id: planned?.length === 1 ? planned[0].id : null, items };
}

export async function updatePublication({ root, planSetId, planId, action, itemId, run = defaultRun }) {
  if (!['inspect', 'begin', 'record', 'publish'].includes(action)) throw new Error('Invalid publication action');
  if (action === 'inspect') return inspectPublication({ root, planSetId, run });
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
    if (!state.planned_option_id) throw new Error('Planned Project status option is unavailable');
    if (item.item_id && item.content.__typename !== 'DraftIssue') throw new Error('Project item is already converted to an Issue');
    if (item.item_id && !item.body_matches) throw new Error(`Project body differs from reviewed publication body: ${planId}`);
    let id = item.item_id;
    if (!id) {
      const body = await readFile(sessionOutputPath(root, item.body_path, { create: false }), 'utf8');
      const title = `${planSetId} / ${planId}`;
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

export async function verifyDraftPublication({ root, planSetId, run = defaultRun }) {
  const config = parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8')).tracker;
  if (config?.mode !== 'github') return;
  const state = await inspectPublication({ root, planSetId, run });
  for (const item of state.items) if (!item.item_id || !item.body_matches || item.content.__typename !== 'DraftIssue' || item.status !== 'Planned') throw new Error(`Draft publication is missing, changed or not Planned: ${item.plan_id}`);
  return state;
}
