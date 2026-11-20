import { injectStageContract } from './stage-contract.mjs';

export function transformSourceContent(content, transform) {
  // Agent profiles carry the stage contract marker; both provider copies receive the contract text in its place.
  const text = ['project-local-paths-v1', 'claude-agent-v1'].includes(transform) ? injectStageContract(content.toString('utf8')) : content.toString('utf8');
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
    const readOnlyTools = fields.sandbox_mode === 'read-only' ? '\ntools: Read, Grep, Glob, WebSearch, WebFetch' : '';
    return `---
name: ${fields.name}
description: ${JSON.stringify(fields.description)}
model: inherit
permissionMode: ${permissionMode}${readOnlyTools}
---
${prompt.replaceAll('.codex/skills/', '.claude/skills/')}
`;
  }
  // The source contract module uses only Node built-ins and is already self-contained at its installed path.
  if (transform === 'standalone-contracts-v1') return text;
  return content;
}
