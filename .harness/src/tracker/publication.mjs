import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseYaml } from '../eval/yaml.mjs';
import { sessionOutputPath } from '../workflow/session-output.mjs';
import { inspectPlanSet, planReviewSnapshotHash, snapshotPlanSet } from '../workflow/plan-review.mjs';
import { publicationMarker, titleFromBody, writePublicationBodies } from './publication-body.mjs';

const exec = promisify(execFile);
const defaultRun = async (args, cwd) => (await exec('gh', args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })).stdout;

export const publicationDraftFingerprint = (drafts) => createHash('sha256').update(JSON.stringify(drafts
  .map(({ plan_id, body_path, body_sha256 }) => [plan_id, body_path, body_sha256])
  .sort(([a], [b]) => a.localeCompare(b)))).digest('hex');

async function preparePublication({ root, planSetId, expectedSnapshotSha256, expectedDraftsSha256 }) {
  const snapshot = await snapshotPlanSet({ root, planSetId });
  const review = await inspectPlanSet({ root, planSetId, phase: 'planning', expectedSnapshotSha256 });
  if (review.status !== 'pass' || review.details.review_snapshot_sha256 !== planReviewSnapshotHash(snapshot.inputs) || !snapshot.execution_workspace) {
    throw Object.assign(new Error(`Publication bodies require the current reviewed plan set and canonical execution workspace: ${review.reason}`), { code: 'PUBLICATION_NOT_READY' });
  }
  const drafts = snapshot.publication_bodies;
  if (expectedDraftsSha256 !== undefined && expectedDraftsSha256 !== publicationDraftFingerprint(drafts)) throw new Error('Publication bodies no longer match the approved final body hashes');
  await writePublicationBodies(root, drafts);
  return drafts;
}

export async function preparePublicationDrafts(options) {
  return (await preparePublication(options)).map(({ body: _body, title: _title, ...draft }) => draft);
}

const normalizeBody = (body) => body.replace(/<!-- harness-plan [^\n]* -->/g, '').replace(/\r\n/g, '\n').replace(/\n+$/, '');

async function publicationState({ root, planSetId, expectedSnapshotSha256, expectedDraftsSha256, run = defaultRun }) {
  const tracker = parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8')).tracker;
  if (tracker?.mode !== 'github') throw new Error('Project publication requires GitHub tracker mode');
  const repository = tracker.github?.repository;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Invalid configured GitHub repository');
  const drafts = await preparePublication({ root, planSetId, expectedSnapshotSha256, expectedDraftsSha256 });
  if (!drafts.length) throw new Error('The passing snapshot has no reviewed GitHub publication drafts');
  const pages = JSON.parse(await run(['api', '--paginate', '--slurp', `repos/${repository}/issues?state=all&per_page=100`], root));
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('Incomplete repository Issue response');
  const issues = pages.flat().filter((issue) => !issue.pull_request);
  const items = [];
  for (const draft of drafts) {
    const { body } = draft;
    const identity = publicationMarker(planSetId, draft.plan_id);
    const matches = issues.filter((issue) => issue.body?.includes(identity) || normalizeBody(issue.body || '') === normalizeBody(body));
    if (matches.length > 1) throw new Error(`Duplicate Issues for plan: ${draft.plan_id}`);
    const issue = matches[0];
    if (issue && normalizeBody(issue.body || '') !== normalizeBody(body)) throw new Error(`Published Issue body differs from the approved draft: ${draft.plan_id}`);
    if (issue && (!Number.isSafeInteger(issue.number) || issue.number <= 0 || issue.html_url !== `https://github.com/${repository}/issues/${issue.number}`)) throw new Error('Invalid published Issue identity');
    items.push({ ...draft, item_id: issue?.number ?? null, content: issue ? { __typename: 'Issue', number: issue.number, url: issue.html_url } : null });
  }
  const numbers = items.flatMap((item) => item.item_id ? [item.item_id] : []);
  if (new Set(numbers).size !== numbers.length) throw new Error('One Issue matches multiple plans');
  return { plan_set_id: planSetId, repository, items };
}

function publicIssueItem({ body: _body, title: _title, ...item }) { return item; }

export async function inspectPublication(options) {
  const state = await publicationState(options);
  return { ...state, items: state.items.map(publicIssueItem) };
}

export async function updatePublication({ root, planSetId, planId, action, expectedSnapshotSha256, expectedDraftsSha256, run = defaultRun }) {
  if (action === 'inspect') return inspectPublication({ root, planSetId, expectedSnapshotSha256, expectedDraftsSha256, run });
  if (action === 'activate') return activatePublication({ root, planSetId, expectedSnapshotSha256, expectedDraftsSha256, run: (_command, args, cwd) => run(args, cwd) });
  if (action !== 'publish') throw new Error('Invalid publication action');
  const lock = sessionOutputPath(root, 'runtime/to-ticket/publication.lock');
  await mkdir(lock);
  try {
    const state = await publicationState({ root, planSetId, expectedSnapshotSha256, expectedDraftsSha256, run });
    const item = state.items.find((entry) => entry.plan_id === planId);
    if (!item) throw new Error('Plan does not belong to the reviewed plan set');
    if (item.item_id) return { ...publicIssueItem(item), status: 'already_published' };
    const reviewed = await preparePublication({ root, planSetId, expectedSnapshotSha256, expectedDraftsSha256 });
    const current = reviewed.find((entry) => entry.plan_id === planId);
    if (!current || current.body_sha256 !== item.body_sha256 || current.title !== item.title) throw new Error('Publication input changed while checking existing Issues');
    // Use the bytes captured from the reviewed snapshot, independent of later edits to shared publication body files.
    const unshared = sessionOutputPath(root, `runtime/to-ticket/publication.lock/${randomUUID()}.md`);
    await writeFile(unshared, item.body, { flag: 'wx', mode: 0o600 });
    const url = (await run(['issue', 'create', '--repo', state.repository, '--title', item.title, '--body-file', unshared], root)).trim();
    const verified = (await inspectPublication({ root, planSetId, expectedSnapshotSha256, expectedDraftsSha256, run })).items.find((entry) => entry.plan_id === planId);
    if (!verified?.item_id || verified.content.url !== url) throw new Error('Issue creation did not verify; inspect repository Issues before retrying');
    return { ...verified, status: 'published' };
  } finally { await rm(lock, { recursive: true }); }
}

export async function publicationTitle(root, planSetId, planId) {
  const path = planId === '@parent' ? `docs/plans/${planSetId}/plans.md` : `docs/plans/${planSetId}/${planId}.md`;
  return titleFromBody(planId, await readFile(join(root, path), 'utf8'), path);
}

const defaultCommand = async (command, args, cwd) => (await exec(command, args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })).stdout;

// Plan dependencies come from the reviewed index: each table row starts with the plan link, and plan IDs named in
// its dependency column are what that plan waits for.
export async function planDependencies(root, planSetId, planIds) {
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

export async function activatePublication({ root, planSetId, expectedSnapshotSha256, expectedDraftsSha256, run = defaultCommand }) {
  const gh = (args, cwd) => run('gh', args, cwd);
  const ghJson = async (args) => JSON.parse(await gh(args, root));
  const config = parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8'));
  if (config.tracker?.mode === 'local-markdown') {
    const snapshot = await snapshotPlanSet({ root, planSetId });
    const drafts = await preparePublicationDrafts({ root, planSetId, expectedSnapshotSha256: expectedSnapshotSha256 ?? planReviewSnapshotHash(snapshot.inputs), expectedDraftsSha256 });
    if (drafts.length) throw new Error('Local ticket activation cannot use GitHub Issue drafts');
    return { status: 'activated', plan_set_id: planSetId, tickets: snapshot.plans.map((plan) => ({ plan_id: plan.id, ticket_ref: `docs/plans/${planSetId}/${plan.id}.md` })) };
  }
  const repository = config.tracker?.github?.repository;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Configured GitHub repository is required to activate the plan set');
  const state = await inspectPublication({ root, planSetId, expectedSnapshotSha256, expectedDraftsSha256, run: gh });
  const missing = state.items.filter((item) => !item.item_id).map((item) => item.plan_id);
  if (missing.length) throw new Error(`Published Issues are missing for: ${missing.join(', ')}`);
  const byPlan = new Map(state.items.map((item) => [item.plan_id, item]));
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
  const warnings = [];
  const settings = config.tracker.github;
  for (const item of state.items) {
    try {
      await gh(['project', 'item-add', String(settings.project_number), '--owner', settings.project_owner, '--url', item.content.url], root);
    } catch (error) {
      warnings.push(error.message);
      break;
    }
  }
  const refs = state.items.map((item) => `${repository}#${item.content.number}`);
  const path = sessionOutputPath(root, `runtime/to-ticket/${planSetId}-issues.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const tickets = children.map((item) => ({ plan_id: item.plan_id, ticket_ref: `${repository}#${item.content.number}` })).sort((a, b) => a.plan_id.localeCompare(b.plan_id));
  try {
    await writeFile(temporary, JSON.stringify({ repository, tickets }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  const { inspectTrackerSync } = await import('./lifecycle.mjs');
  const check = await inspectTrackerSync({ workspace_root: root, ticket_refs: refs, run });
  if (check.status !== 'pass') throw new Error(`Activated tracker does not verify: ${check.violations.join('; ')}`);
  return { status: 'activated', plan_set_id: planSetId, issues: state.items.map((item) => ({ plan_id: item.plan_id, number: item.content.number, url: item.content.url })), tracker_check: check, warnings: [...warnings, ...(check.warnings || [])] };
}

// Verify the plan-to-Issue mapping without consulting the Project.
export async function verifyActivatedPublication({ root, planSetId, run = defaultCommand }) {
  const config = parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8'));
  if (config.tracker?.mode !== 'github') return;
  const { listPlanTickets } = await import('./lifecycle.mjs');
  const tickets = await listPlanTickets({ workspace_root: root, plan_set_id: planSetId, run });
  const snapshot = await snapshotPlanSet({ root, planSetId });
  const mapped = new Set(tickets.map((ticket) => ticket.plan_id));
  const missing = snapshot.plans.filter((plan) => !mapped.has(plan.id)).map((plan) => plan.id);
  if (missing.length) throw new Error(`Published Issues are missing for: ${missing.join(', ')}`);
  return tickets;
}
