import { injectStageContract } from './stage-contract.mjs';
import { AUTO_COMPACT_WINDOW } from '../workflow/compaction-boundary.mjs';

// A document stage needs these tools and nothing else. Without an allowlist every worker starts with the skill listing and the
// deferred and MCP tool listings (about 10K tokens). Other writable profiles may need a project's MCP tools, so they only lose Skill.
const DOCUMENT_TOOLS = 'Bash, Read, Edit, Write, Agent';
const CLAUDE_TOOLS = {
  workflow_stage: DOCUMENT_TOOLS,
  to_ticket: DOCUMENT_TOOLS,
  tactical_designer: `${DOCUMENT_TOOLS}, WebSearch, WebFetch`,
};

export function transformSourceContent(content, transform) {
  // Agent profiles carry the stage contract marker; both provider copies receive the contract text in its place.
  const text = ['project-local-paths-v1', 'codex-assets-v2', 'claude-agent-v1'].includes(transform) ? injectStageContract(content.toString('utf8')) : content.toString('utf8');
  if (transform === 'codex-assets-v2') return text;
  if (transform === 'project-local-paths-v1') return text.replaceAll('.codex/skills/', '.agents/skills/');
  if (transform === 'claude-skills-v1') {
    return text.replaceAll('.codex/skills/', '.claude/skills/')
      .replace(/^(---\r?\nname: orchestrator\r?\n)/, '$1disable-model-invocation: true\n');
  }
  if (transform === 'claude-agent-v1') {
    const fields = Object.fromEntries(['name', 'description', 'sandbox_mode'].map((key) => {
      const match = new RegExp(`^${key} = "((?:\\\\.|[^"])*)"$`, 'm').exec(text);
      if (!match) throw new Error(`Claude agent conversion requires ${key}`);
      return [key, JSON.parse(`"${match[1]}"`)];
    }));
    const prompt = /^developer_instructions = """\r?\n([\s\S]*?)\r?\n"""\s*$/m.exec(text)?.[1];
    if (!prompt) throw new Error('Claude agent conversion requires developer_instructions');
    const permissionMode = { 'read-only': 'plan', 'workspace-write': 'acceptEdits', 'danger-full-access': 'bypassPermissions' }[fields.sandbox_mode];
    if (!permissionMode) throw new Error(`Unsupported agent sandbox_mode: ${fields.sandbox_mode}`);
    const tools = fields.sandbox_mode === 'read-only' ? 'tools: Read, Grep, Glob, WebSearch, WebFetch' : CLAUDE_TOOLS[fields.name] ? `tools: ${CLAUDE_TOOLS[fields.name]}` : 'disallowedTools: Skill';
    return `---
name: ${fields.name}
description: ${JSON.stringify(fields.description)}
model: inherit
permissionMode: ${permissionMode}
${tools}
autoCompactWindow: ${AUTO_COMPACT_WINDOW}
---
${prompt.replaceAll('.codex/skills/', '.claude/skills/')}
`;
  }
  // The source contract module uses only Node built-ins and is already self-contained at its installed path.
  if (transform === 'standalone-contracts-v1') return text;
  return content;
}
