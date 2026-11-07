import { dirname, join, resolve } from 'node:path';
import { realpath, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCodexProcess } from '../codex-process.mjs';
import { parseYaml } from '../../eval/yaml.mjs';

export const id = 'codex';

export async function resumeWriteDirs(sessionId, env) {
  const home = resolve(env.CODEX_HOME || join(env.HOME || '', '.codex'));
  const sessionRoot = join(home, 'sessions');
  const dirs = new Set();
  async function findSession(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await findSession(path);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) return dirname(path);
    }
    return null;
  }
  const sessionDir = await findSession(await realpath(sessionRoot));
  if (!sessionDir) throw new Error(`Codex resume session file not found under ${sessionRoot}: ${sessionId}`);
  dirs.add(await realpath(sessionDir));
  for (const path of ['thread-writer-locks', 'shell_snapshots', 'tmp/arg0', 'tmp/arg0-linux']) {
    try { dirs.add(await realpath(join(home, path))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return [...dirs];
}

export async function buildCommand({ root, sandbox, resumeWriteDirs: dirs, binding, schemaPath, output, resume, role, skill, env = process.env }) {
  const config = ['implement-wrapper', 'implement'].includes(skill) ? parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8')) : {};
  const githubTracker = skill === 'implement-wrapper' && config.tracker?.mode === 'github';
  if (sandbox === 'workspace-write' && config.beads?.enabled === true) {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--git-common-dir'], { cwd: root });
    const gitCommonDir = await realpath(resolve(root, stdout.trim()));
    dirs = [...new Set([...dirs, dirname(gitCommonDir), gitCommonDir])];
  }
  return ['exec', '--sandbox', sandbox, ...dirs.flatMap((path) => ['--add-dir', path]), '--cd', root, '--model', binding.model,
    ...await stageConfigArgs(env, [join(root, '.codex/config.toml')], role, skill), ...(githubTracker && sandbox === 'workspace-write' ? ['-c', 'sandbox_workspace_write.network_access=true'] : []), '-c', `model_reasoning_effort=${JSON.stringify(binding.reasoning_effort)}`, '-c', 'approval_policy="never"', '--enable', 'multi_agent', '--json',
    '--output-schema', schemaPath, '--output-last-message', output, ...(resume ? ['resume', resume, '-'] : ['-'])];
}

function mcpServerName(line) {
  const section = /^\[mcp_servers\.(.+?)\](?:\s*#.*)?$/.exec(line.trim())?.[1];
  if (!section) return null;
  if (section[0] === '"' || section[0] === "'") return section.slice(1, section.indexOf(section[0], 1));
  return section.split('.')[0];
}

export async function stageConfigArgs(env = process.env, configPaths = [], role = null, skill = null) {
  const paths = [resolve(env.CODEX_HOME || join(env.HOME || '', '.codex'), 'config.toml'), ...configPaths];
  const configs = await Promise.all(paths.map((path) => readFile(path, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; })));
  const servers = [...new Set(configs.flatMap((config) => config.split('\n').map(mcpServerName).filter(Boolean)))];
  const frontend = ['frontend_designer', 'frontend_implementation_agent', 'frontend_visual_reviewer'].includes(role);
  const research = skill === 'spec-me' || ['spec_document_writer', 'code_researcher', 'architecture_review_lead', 'spec_adversarial_reviewer', 'knowledge_source_researcher', 'knowledge_principle_synthesizer', 'frontend_designer'].includes(role);
  const visual = frontend || role === 'diagram_creator' || role === 'spec_adversarial_reviewer' || skill === 'spec-me';
  const imageGeneration = frontend || skill === 'frontend-design';
  const retained = frontend ? new Set(['figwright', 'iconify', 'awwwards']) : new Set();
  const disabledServers = servers.filter((server) => !retained.has(server));
  return ['-c', 'skills.include_instructions=false', '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'features.goals=false', '-c', `features.image_generation=${imageGeneration ? 'true' : 'false'}`, '-c', `features.view_image=${visual ? 'true' : 'false'}`, '-c', `web_search=${JSON.stringify(research ? 'live' : 'disabled')}`, '-c', `model_instructions_file=${JSON.stringify(resolve(fileURLToPath(new URL('../../../..', import.meta.url)), '.codex/internal-skills/skill-execution/worker-base.md'))}`,
    ...(disabledServers.length ? ['-c', `mcp_servers={${disabledServers.map((server) => `${JSON.stringify(server)}={enabled=false}`).join(',')}}`] : [])];
}

export async function run({ root, args, prompt, env, onStart, onSession, onEvent, onStderr, onCodexError }) {
  const result = await runCodexProcess({ root, args, prompt, env, onStart, onEvent, onStderr, onCodexError, onThread: onSession });
  return { ...result, sessionId: result.threadId };
}
