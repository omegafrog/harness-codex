import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseYaml } from '../eval/yaml.mjs';
import { sessionOutputPath } from '../workflow/session-output.mjs';
import { inspectPlanSet, snapshotPlanSet } from '../workflow/plan-review.mjs';

const exec = promisify(execFile);
const defaultRun = async (args, cwd) => (await exec('gh', args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })).stdout;

export async function updatePublication({ root, planSetId, planId, action, itemId }) {
  if (!(planId === '@parent' || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planId || '')) || !['begin', 'record'].includes(action)) throw new Error('Valid publication action and plan ID are required');
  const snapshot = await snapshotPlanSet({ root, planSetId });
  const review = await inspectPlanSet({ root, planSetId, phase: 'planning' });
  if (review.status !== 'pass' || !['@parent', ...snapshot.plans.map((plan) => plan.id)].includes(planId)) throw new Error('Current passing review and a plan in its set are required');
  const path = sessionOutputPath(root, 'runtime/to-ticket/publish-state.json');
  const lock = `${path}.lock`;
  await mkdir(lock);
  try {
    let journal;
    try { journal = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; journal = { plan_set_id: planSetId, review_attempt_id: review.details.review_attempt_id, items: [], pending: [] }; }
    const allowed = ['@parent', ...snapshot.plans.map((plan) => plan.id)];
    if (journal.plan_set_id !== planSetId || journal.review_attempt_id !== review.details.review_attempt_id || !Array.isArray(journal.items) || !Array.isArray(journal.pending) || journal.items.some((item) => !item || !allowed.includes(item.plan_id) || typeof item.item_id !== 'string' || !item.item_id.trim()) || journal.pending.some((id) => !allowed.includes(id)) || new Set(journal.items.map((item) => item.plan_id)).size !== journal.items.length || new Set(journal.items.map((item) => item.item_id)).size !== journal.items.length || new Set(journal.pending).size !== journal.pending.length || journal.items.some((item) => journal.pending.includes(item.plan_id))) throw new Error('Publication journal does not match the current review');
    const existing = journal.items.find((item) => item.plan_id === planId);
    if (action === 'begin') {
      if (existing) return { status: 'already_created', item_id: existing.item_id };
      if (journal.pending.includes(planId)) throw new Error('Creation result is ambiguous; inspect the Project and record the existing item before retrying');
      journal.pending.push(planId);
    } else {
      if (existing || !journal.pending.includes(planId) || typeof itemId !== 'string' || !itemId.trim() || journal.items.some((item) => item.item_id === itemId)) throw new Error('A unique item ID and pending creation are required');
      journal.items.push({ plan_id: planId, item_id: itemId });
      journal.pending = journal.pending.filter((id) => id !== planId);
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
    return { status: action === 'begin' ? 'pending' : 'recorded', ...(itemId ? { item_id: itemId } : {}) };
  } finally { await rm(lock, { recursive: true }); }
}

export async function verifyDraftPublication({ root, planSetId, run = defaultRun }) {
  const config = parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8')).tracker;
  if (config?.mode !== 'github') return;
  const settings = config.github;
  if (!settings || !/^[\w-]+$/.test(settings.project_owner || '') || !Number.isInteger(settings.project_number) || settings.project_number <= 0 || !settings.status_field || settings.status_field === 'Status') throw new Error('Invalid configured GitHub project');
  const journal = JSON.parse(await readFile(sessionOutputPath(root, 'runtime/to-ticket/publish-state.json', { create: false }), 'utf8'));
  const snapshot = await snapshotPlanSet({ root, planSetId });
  const review = await inspectPlanSet({ root, planSetId, phase: 'planning' });
  if (review.status !== 'pass' || journal.plan_set_id !== planSetId || journal.review_attempt_id !== review.details.review_attempt_id) throw new Error('Publication journal does not match the current passing plan review');
  const expected = ['@parent', ...snapshot.plans.map((plan) => plan.id)];
  if (!Array.isArray(journal.pending) || journal.pending.length || !Array.isArray(journal.items) || journal.items.length !== expected.length || journal.items.some((item) => !item || typeof item.plan_id !== 'string' || typeof item.item_id !== 'string' || !item.item_id.trim()) || new Set(journal.items.map((item) => item.plan_id)).size !== expected.length || new Set(journal.items.map((item) => item.item_id)).size !== expected.length || expected.some((id) => !journal.items.some((item) => item.plan_id === id))) throw new Error('Publication journal must map every plan and the parent to unique draft items with no pending creations');
  const get = async (args) => JSON.parse(await run(args, root));
  const project = await get(['project', 'view', String(settings.project_number), '--owner', settings.project_owner, '--format', 'json']);
  const fields = await get(['project', 'field-list', String(settings.project_number), '--owner', settings.project_owner, '--format', 'json', '--limit', '100']);
  if (!project.id || !Array.isArray(fields.fields) || fields.totalCount > fields.fields.length) throw new Error('Incomplete project metadata');
  const matching = fields.fields.filter((field) => field.name === settings.status_field && field.type === 'ProjectV2SingleSelectField');
  if (matching.length !== 1 || !matching[0].id) throw new Error('Configured project status field is missing or ambiguous');
  for (let offset = 0; offset < journal.items.length; offset += 10) {
    const items = journal.items.slice(offset, offset + 10);
    const query = `query { nodes(ids:${JSON.stringify(items.map((item) => item.item_id))}) { ... on ProjectV2Item { id project { id } content { __typename ... on DraftIssue { title body } } fieldValues(first:100) { pageInfo { hasNextPage } nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { id } } } } } } } }`;
    const response = await get(['api', 'graphql', '-f', `query=${query}`]);
    if (response.errors?.length || !Array.isArray(response.data?.nodes) || response.data.nodes.length !== items.length) throw new Error('Incomplete draft verification response');
    for (const [index, node] of response.data.nodes.entries()) {
      const values = node?.fieldValues;
      const status = values?.nodes?.filter((entry) => entry.field?.id === matching[0].id);
      const contentId = items[index].plan_id === '@parent' ? planSetId : items[index].plan_id;
      if (node?.id !== items[index].item_id || node.project?.id !== project.id || node.content?.__typename !== 'DraftIssue' || !`${node.content?.title || ''}\n${node.content?.body || ''}`.includes(contentId) || values?.pageInfo?.hasNextPage !== false || status?.length !== 1 || status[0].name !== 'Planned') throw new Error(`Draft publication is missing or not Planned: ${items[index].plan_id}`);
    }
  }
}
