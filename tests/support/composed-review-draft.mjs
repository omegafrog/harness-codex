import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { bindStageDocumentWriter, prepareWriterBrief, receiveWriterComposition, stageDocumentBatch } from '../../.harness/src/workflow/stage-documents.mjs';

export async function composeReviewDraft({ root, executionId, skill, planSetId, documents = {}, github = false }) {
  const config = join(root, '.harness/harness.yaml');
  await mkdir(dirname(config), { recursive: true });
  const tracker = github ? 'tracker:\n  mode: github\n' : '';
  await writeFile(config, `agents:\n  claude-code:\n    low_performance_model: haiku\n    low_performance_reasoning_effort: low\n${tracker}`);
  const batch = await stageDocumentBatch({
    root, input: { execution_id: executionId, skill }, envelope: {}, planSetId,
    binding: { provider: 'claude-code' }, beforeReview: true,
  });
  const agentId = 'fixture-document-writer', parentSessionId = 'fixture-stage-author';
  await bindStageDocumentWriter({ root, id: executionId, agentId, workerId: parentSessionId, parentSessionId });
  const brief = JSON.parse(await readFile(await prepareWriterBrief(root, batch), 'utf8'));
  for (const { path, proposed_content, output } of brief.files) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, documents[path] ?? proposed_content);
  }
  await receiveWriterComposition({ root, id: executionId, agentId });
  const log = join(root, '.io/runtime/executions', executionId, 'subagents.jsonl');
  for (const event of ['SubagentStart', 'SubagentStop']) {
    await appendFile(log, `${JSON.stringify({ event, agent_id: agentId, session_id: parentSessionId, agent_type: batch.agent_profile, recorded_at: new Date().toISOString() })}\n`);
  }
}
