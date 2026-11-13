import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function existingCodexWake(cwd) {
  try {
    const config = JSON.parse((await exec('codex', ['mcp', 'get', 'codex-wake', '--json'], { cwd, timeout: 5000 })).stdout);
    if (config.enabled && config.transport?.type === 'stdio' && config.transport.command && config.transport.cwd) return config.transport;
    return null;
  } catch {}
  try {
    const list = JSON.parse((await exec('codex', ['plugin', 'list', '--json'], { cwd, timeout: 5000 })).stdout);
    const plugin = list.installed?.find((item) => item.name === 'codex-wake' && item.installed === true && item.enabled === true);
    if (!plugin || !/^[\w.-]+$/.test(plugin.marketplaceName || '') || !/^[\w.-]+$/.test(plugin.version || '')) return null;
    const directory = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'), 'plugins/cache', plugin.marketplaceName, 'codex-wake', plugin.version);
    const entry = JSON.parse(await readFile(join(directory, 'mcp.json'), 'utf8')).mcpServers?.['codex-wake'];
    if (entry?.type !== 'stdio' || typeof entry.command !== 'string' || !Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string')) return null;
    return { ...entry, cwd: resolve(directory, entry.cwd || '.') };
  } catch { return null; }
}
