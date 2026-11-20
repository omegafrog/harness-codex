import { createHash, randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { sessionOutputPath } from '../workflow/session-output.mjs';

export const publicationMarker = (set, plan) => `<!-- harness-plan ${JSON.stringify({ plan_set_id: set, plan_id: plan })} -->`;

export function titleFromBody(planId, source, path) {
  const title = source.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  if (!title) throw new Error(`Publication title heading is missing: ${path}`);
  return `${planId === '@parent' ? '[Harness Plan Set]' : '[Harness Plan]'} ${title}`;
}

// The same captured inputs generate the admission files and the bytes sent to GitHub.
export function renderPublicationBodies({ planSetId, base, indexBody, plans, issueDrafts, workspace }) {
  if (!issueDrafts.length) return [];
  if (!workspace) throw new Error('GitHub Issue draft rendering requires the canonical execution workspace');
  const executionBlock = `<details><summary>실행 정보</summary>\n\n- workspace_root: \`${workspace.workspace_root}\`\n- workspace_branch: \`${workspace.workspace_branch}\`\n\n</details>`;
  const planContent = plans.map((plan) => plan.body);
  return issueDrafts.map(({ plan_id: planId, body: draft }) => {
    let body = draft;
    // Update legacy display text using the runner's canonical workspace.
    const legacy = [...planContent, draft].join('\n');
    for (const match of legacy.matchAll(/^\s*-?\s*workspace_(root|branch):\s*\`([^\`]+)\`/gm)) {
      if (match[1] === 'root') body = body.replaceAll(`\`${match[2]}\``, `\`${workspace.workspace_root}\``);
      else body = body.replaceAll(`branch \`${match[2]}\``, `branch \`${workspace.workspace_branch}\``);
    }
    body = body.replace(/<details><summary>실행 정보<\/summary>[\s\S]*?<\/details>\s*/g, '')
      .replace(/^\s*-?\s*workspace_(?:root|branch):[^\n]*(?:\n|$)/gm, '').trimEnd();
    body += `\n\n${executionBlock}\n\n${publicationMarker(planSetId, planId)}\n`;
    const bodyPath = `runtime/to-ticket/publication-bodies/${planId === '@parent' ? 'parent' : planId}.md`;
    const plan = plans.find((item) => item.id === planId);
    const title = titleFromBody(planId, plan?.body ?? indexBody, plan?.path ?? `${base}/plans.md`);
    return { plan_id: planId, body_path: bodyPath, body_sha256: createHash('sha256').update(body).digest('hex'), title, body };
  });
}

export async function writePublicationBodies(root, drafts) {
  for (const { body_path: path, body } of drafts) {
    const target = sessionOutputPath(root, path);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
}
