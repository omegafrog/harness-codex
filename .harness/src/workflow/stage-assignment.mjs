// The worker assignment both providers give a stage worker in one piece: its GUIDE, input, schema and the references the
// stage always needs are fixed by the launch, so reading them one by one would cost a turn each and the file tool's line
// numbers. Claude Code receives it as the Agent prompt (claude-stage-dispatch.mjs); Codex reads it from
// runtime/executions/<id>/assignment.md, which `start` writes. The paths stay for links and for the parts left out.
import { constants, readFileSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { stripSkillDeclaration } from './skill-declaration.mjs';
import { referenceBlocks } from './stage-references.mjs';

// The result schema a worker needs while it asks nothing: the two large shapes it rarely uses are named and left in the file.
// Stages that ask by design keep the question shape inline: the worker would otherwise spend a call reading it.
const ASKING_STAGES = new Set(['stakeholder-analysis', 'event-storming', 'subdomain-classification', 'requirements-fix', 'tactical-technology', 'tactical-ui']);

export function inlineSchema(schema) {
  const copy = structuredClone(schema), result = copy.properties?.result?.properties;
  const skill = copy.properties?.skill?.const;
  for (const key of ['questions', 'review_request']) {
    if (key === 'questions' && ASKING_STAGES.has(skill)) continue;
    if (!result?.[key] || JSON.stringify(result[key]).length < 600) continue;
    result[key] = { description: key === 'questions' ? 'Use [] when you ask nothing. To ask, first read properties.result.properties.questions in schema_path for the item shape.' : 'Use null when you request no review. To request one, first read properties.result.properties.review_request in schema_path.' };
  }
  return copy;
}

export const ASSIGNMENT_FILE = 'assignment.md';

// `launched` carries stage_id, execution_id, guide, input_path, schema_path and the optional answers_path, feedback_path,
// document_draft_root and browser_environment_path. The Claude text is the original worker prompt, unchanged.
export function buildAssignment(root, launched, { provider = 'claude-code' } = {}) {
  const codex = provider === 'codex';
  const guide = stripSkillDeclaration(readFileSync(launched.guide, 'utf8')).trim();
  const input = JSON.parse(readFileSync(launched.input_path, 'utf8'));
  const schema = inlineSchema(JSON.parse(readFileSync(launched.schema_path, 'utf8')));
  const references = referenceBlocks(root, launched.stage_id);
  const lines = [
    `Run the Harness stage \`${launched.stage_id}\`.`,
    `- workspace_root: ${root}`,
    `- execution_id: ${launched.execution_id}`,
    `- guide: ${launched.guide}`,
    `- input_path: ${launched.input_path}`,
    `- schema_path: ${launched.schema_path}`,
    ...(launched.answers_path ? [`- answers_path: ${launched.answers_path}`] : []),
    ...(launched.feedback_path ? [`- feedback_path: ${launched.feedback_path}`] : []),
    ...(launched.document_draft_root ? [`- document_draft_root: ${launched.document_draft_root}`] : []),
    ...(launched.browser_environment_path ? [`- browser_environment_path: ${launched.browser_environment_path}`] : []),
    '',
    'The guide, input and schema are included below in full except where the schema says otherwise: do not read those files again.' + (references.length ? ' The `<reference>` blocks below hold the references this stage always needs (only the sections it uses where a file is long): references included below must not be read again.' : '') + ' Relative links in the guide resolve from its directory. `context.workspace` in the input already holds the workspace check, the document paths and the source overview. In your first turn read every document and guide reference you need in parallel, by these paths. Write completed documents under document_draft_root at their canonical relative paths.',
    codex
      ? 'Submission: pipe the one JSON object that matches the schema to the exact `receive_command` the caller gave you, on standard input (a quoted heredoc), and wait for `received` before replying. If Harness answers with format or gate errors, fix only what they name (read the feedback file when one is given) and submit again to the same command. Run any Harness command yourself; never ask the caller to run one.'
      : 'Submission: there is no receive command and you do not bind or finish anything. Your final message must be exactly one JSON object that matches the schema, with no prose around it. Harness records it when you stop and runs the gates itself. If it answers with format or gate errors you continue: fix only what they name (read the feedback file when one is given) and reply again with the whole corrected JSON object. Run any Harness command yourself; never ask the caller to run one.',
    '', '<guide>', guide, '</guide>',
    '', '<input>', JSON.stringify(input), '</input>',
    '', '<schema>', JSON.stringify(schema), '</schema>',
    ...(references.length ? ['', ...references] : []),
    '', codex
      ? 'After your last document write, submit with the receive_command; make no tool call that does nothing (no `echo`, `true` or other no-op command) before it.'
      : 'After your last document write, your next output is the final JSON text itself, with no tool call in between (no `echo`, `true` or other no-op command); an empty Bash result means the write succeeded.',
  ];
  return lines.join('\n');
}

// Writes the assignment next to the execution's other files (owner-only, never through a link) and returns its absolute path.
export async function writeAssignmentFile({ session, executionId, directory, text }) {
  const relative = `runtime/executions/${executionId}/${ASSIGNMENT_FILE}`;
  await assertWorkspaceTarget(session, relative);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, ASSIGNMENT_FILE);
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('Unsafe worker assignment file');
    await file.writeFile(text);
  } finally { await file.close(); }
  return path;
}
