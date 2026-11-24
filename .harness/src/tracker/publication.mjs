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
  if (review.status !== 'pass' || !snapshot.execution_workspace) throw Object.assign(new Error('Publication bodies require a reviewed plan set and canonical execution workspace'), { code: 'PUBLICATION_NOT_READY' });
  // GitHub needs an Issue body; a local-markdown plan is already its own ticket.
  const config = parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8').catch(() => ''));
  if (config.tracker?.mode !== 'github') return [];
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
  const repository = tracker.github?.repository;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Invalid configured GitHub repository');
  const drafts = await preparePublicationDrafts({ root, planSetId });
  const pages = JSON.parse(await run(['api', '--paginate', '--slurp', `repos/${repository}/issues?state=all&per_page=100`], root));
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('Incomplete repository Issue response');
  const issues = pages.flat().filter((issue) => !issue.pull_request);
  const items = [];
  for (const draft of drafts) {
    const body = await readFile(sessionOutputPath(root, draft.body_path, { create: false }), 'utf8');
    const identity = marker(planSetId, draft.plan_id);
    const matches = issues.filter((issue) => issue.body?.includes(identity) || normalizeBody(issue.body || '') === normalizeBody(body));
    if (matches.length > 1) throw new Error(`Duplicate Issues for plan: ${draft.plan_id}`);
    const issue = matches[0];
    if (issue && (!Number.isSafeInteger(issue.number) || issue.number <= 0 || issue.html_url !== `https://github.com/${repository}/issues/${issue.number}`)) throw new Error('Invalid published Issue identity');
    items.push({ ...draft, item_id: issue?.number ?? null, content: issue ? { __typename: 'Issue', number: issue.number, url: issue.html_url } : null });
  }
  const numbers = items.flatMap((item) => item.item_id ? [item.item_id] : []);
  if (new Set(numbers).size !== numbers.length) throw new Error('One Issue matches multiple plans');
  return { plan_set_id: planSetId, repository, items };
}

export async function updatePublication({ root, planSetId, planId, action, run = defaultRun }) {
  if (action === 'inspect') return inspectPublication({ root, planSetId, run });
  if (action === 'activate') return activatePublication({ root, planSetId, run: (_command, args, cwd) => run(args, cwd) });
  if (action !== 'publish') throw new Error('Invalid publication action');
  const lock = sessionOutputPath(root, 'runtime/to-ticket/publication.lock');
  await mkdir(lock);
  try {
    const state = await inspectPublication({ root, planSetId, run });
    const item = state.items.find((entry) => entry.plan_id === planId);
    if (!item) throw new Error('Plan does not belong to the reviewed plan set');
    if (item.item_id) return { ...item, status: 'already_published' };
    const title = await publicationTitle(root, planSetId, planId);
    const url = (await run(['issue', 'create', '--repo', state.repository, '--title', title, '--body-file', sessionOutputPath(root, item.body_path, { create: false })], root)).trim();
    const verified = (await inspectPublication({ root, planSetId, run })).items.find((entry) => entry.plan_id === planId);
    if (!verified?.item_id || verified.content.url !== url) throw new Error('Issue creation did not verify; inspect repository Issues before retrying');
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

const activatedIssues = (items) => items.map((item) => ({ plan_id: item.plan_id, url: item.content.url })).sort((a, b) => a.plan_id.localeCompare(b.plan_id));

export async function activatePublication({ root, planSetId, run = defaultCommand }) {
  const gh = (args, cwd) => run('gh', args, cwd);
  const ghJson = async (args) => JSON.parse(await gh(args, root));
  const config = parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8'));
  if (config.tracker?.mode === 'local-markdown') {
    const snapshot = await snapshotPlanSet({ root, planSetId });
    return { status: 'activated', plan_set_id: planSetId, tickets: snapshot.plans.map((plan) => ({ plan_id: plan.id, ticket_ref: `docs/plans/${planSetId}/${plan.id}.md` })), published_issues: [] };
  }
  const repository = config.tracker?.github?.repository;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Configured GitHub repository is required to activate the plan set');
  const state = await inspectPublication({ root, planSetId, run: gh });
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
    // `issues` also keeps the parent and each Issue URL so the stage result's published_issues can be verified.
    await writeFile(temporary, JSON.stringify({ repository, tickets, issues: activatedIssues(state.items) }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  const { inspectTrackerSync } = await import('./lifecycle.mjs');
  const check = await inspectTrackerSync({ workspace_root: root, ticket_refs: refs, run });
  if (check.status === 'fail') throw new Error(`Activated tracker does not verify: ${check.violations.join('; ')}`);
  return { status: 'activated', plan_set_id: planSetId, issues: state.items.map((item) => ({ plan_id: item.plan_id, number: item.content.number, url: item.content.url })), published_issues: activatedIssues(state.items), tracker_check: check, warnings: [...warnings, ...(check.warnings || [])] };
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

// A tracker-publish result reports the Issues it published in `published_issues` ({plan_id, url}); they are tracker
// references, not files. Results written before that field existed listed the URLs as artifacts instead.
export const PUBLISHED_ISSUE_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9][0-9]*)$/;

// Reads the published Issues of a stored tracker-publish result of any version. A legacy URL artifact has no plan ID.
export function publishedIssues(result) {
  if (Array.isArray(result?.published_issues)) return result.published_issues.map(({ plan_id, url }) => ({ plan_id, url }));
  return (Array.isArray(result?.artifacts) ? result.artifacts : [])
    .filter((artifact) => typeof artifact?.path === 'string' && PUBLISHED_ISSUE_URL.test(artifact.path))
    .map((artifact) => ({ plan_id: null, url: artifact.path }));
}

// The plan-to-Issue mapping activation saved: every published Issue (parent included) by plan ID.
async function activatedIssueMap(root, planSetId) {
  const saved = JSON.parse(await readFile(sessionOutputPath(root, `runtime/to-ticket/${planSetId}-issues.json`, { create: false }), 'utf8'));
  const issues = Array.isArray(saved.issues) ? saved.issues
    // An activation receipt of an earlier Harness kept only the child tickets.
    : (saved.tickets || []).map((ticket) => ({ plan_id: ticket.plan_id, url: `https://github.com/${saved.repository}/issues/${String(ticket.ticket_ref).split('#')[1]}` }));
  return { repository: saved.repository, complete: Array.isArray(saved.issues), byUrl: new Map(issues.map((issue) => [issue.url, issue])) };
}

// Moves Issue URLs a stage declared as artifacts into published_issues, naming each by the activated mapping, so the
// runner neither looks for them as files nor drops them. Returns the URLs it moved.
export async function normalizePublishedIssues({ root, planSetId, result }) {
  const urls = [];
  if (Array.isArray(result?.artifacts)) {
    result.artifacts = result.artifacts.filter((artifact) => {
      if (typeof artifact?.path !== 'string' || !PUBLISHED_ISSUE_URL.test(artifact.path)) return true;
      urls.push(artifact.path);
      return false;
    });
  }
  if (!urls.length) return [];
  const published = Array.isArray(result.published_issues) ? result.published_issues : [];
  const known = new Set(published.map((issue) => issue?.url));
  const mapping = await activatedIssueMap(root, planSetId).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  for (const url of new Set(urls)) {
    if (known.has(url)) continue;
    const issue = mapping?.byUrl.get(url);
    if (!issue) throw new Error(`Published Issue is not in the activated plan mapping: ${url}; report it in published_issues after activate`);
    published.push({ plan_id: issue.plan_id, url });
  }
  result.published_issues = published;
  return [...new Set(urls)];
}

// A completed tracker-publish result must report exactly the Issues activation recorded.
export async function assertPublishedIssues({ root, planSetId, result }) {
  if (!Object.hasOwn(result || {}, 'published_issues')) return;
  const issues = result.published_issues;
  if (!Array.isArray(issues)) throw new Error('published_issues must be a list');
  const config = parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8').catch(() => ''));
  if (config.tracker?.mode !== 'github') {
    if (issues.length) throw new Error('published_issues must be empty when no GitHub tracker is configured');
    return;
  }
  const urls = issues.map((issue) => issue?.url);
  if (new Set(urls).size !== urls.length || new Set(issues.map((issue) => issue?.plan_id)).size !== issues.length) throw new Error('published_issues lists an Issue or plan twice');
  const mapping = await activatedIssueMap(root, planSetId);
  if (mapping.repository !== config.tracker.github?.repository) throw new Error('Activated Issue mapping belongs to another repository');
  for (const issue of issues) {
    const match = PUBLISHED_ISSUE_URL.exec(issue?.url || '');
    if (!match || match[1] !== mapping.repository) throw new Error(`Published Issue is not in the configured repository: ${issue?.url}`);
    if (mapping.byUrl.get(issue.url)?.plan_id !== issue.plan_id) throw new Error(`Published Issue does not match the activated plan mapping: ${issue.plan_id} ${issue.url}`);
  }
  const missing = [...mapping.byUrl.values()].filter((issue) => !urls.includes(issue.url));
  if (mapping.complete && missing.length) throw new Error(`published_issues omits activated Issues: ${missing.map((issue) => issue.plan_id).join(', ')}`);
}
