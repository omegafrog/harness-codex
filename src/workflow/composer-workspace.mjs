import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkflowWorktree, parseWorktreeRecord } from './worktrees.mjs';
import { resolveSkillSession, readSkillSessionJson } from './skill-execution.mjs';

// Only the deterministic worktree lifecycle runs outside the model sandbox.
export async function prepareComposerWorkspace({ root, session, input, inputPath }) {
  let reference = input.context?.worktree_ref;
  if (!reference) {
    let state;
    try { state = await readSkillSessionJson({ root, session_directory: session, path: 'runtime/orchestrator/state.json' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const current = state?.stages?.['workflow-compose'];
    const previous = current?.execution_id === input.execution_id ? current.attempts?.at(-1) : current;
    if (previous?.execution_id && previous.execution_id !== input.execution_id) {
      const prior = await readSkillSessionJson({ root, session_directory: session, path: `runtime/executions/${previous.execution_id}/input.json` });
      reference = prior.context?.worktree_ref;
    }
  }
  let record;
  if (reference) {
    const directory = reference.slice(0, -'/worktree.json'.length);
    if (!reference.endsWith('/worktree.json')) throw new Error('Invalid canonical worktree reference');
    await resolveSkillSession(root, directory);
    record = parseWorktreeRecord(await readFile(reference, 'utf8'));
    if (record.state !== 'active' || record.session_directory !== directory) throw new Error('Worktree requires lifecycle recovery');
  } else record = await createWorkflowWorktree({ workspace_root: root, return_root: input.shared_guidance_root });
  input.context = { ...input.context, worktree_ref: join(record.session_directory, 'worktree.json') };
  await writeFile(join(session, inputPath), JSON.stringify(input, null, 2) + '\n', { mode: 0o600 });
  return record;
}
