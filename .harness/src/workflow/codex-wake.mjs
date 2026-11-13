import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);

export async function existingCodexWake(cwd) {
  try {
    const config = JSON.parse((await exec('codex', ['mcp', 'get', 'codex-wake', '--json'], { cwd, timeout: 5000 })).stdout);
    if (config.enabled && config.transport?.type === 'stdio' && config.transport.command && config.transport.cwd) return config.transport;
    return null;
  } catch {}
  try {
    const list = JSON.parse((await exec('codex', ['plugin', 'list', '--json'], { cwd, timeout: 5000 })).stdout);
    const plugin = list.installed?.find((item) => item.name === 'codex-wake');
    if (plugin && (!plugin.installed || !plugin.enabled)) return null;
    const home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
    let directory;
    if (plugin && /^[\w.-]+$/.test(plugin.marketplaceName || '') && /^[\w.-]+$/.test(plugin.version || '')) {
      directory = resolve(home, 'plugins/cache', plugin.marketplaceName, 'codex-wake', plugin.version);
    } else {
      const config = await readFile(join(home, 'config.toml'), 'utf8');
      const sections = [...config.matchAll(/^\[plugins\."codex-wake@([\w.-]+)"\]\s*\n([^\[]*)/gm)].filter((match) => /^\s*enabled\s*=\s*true\s*(?:#.*)?$/m.test(match[2]));
      if (sections.length !== 1) return null;
      const marketplaces = JSON.parse((await exec('codex', ['plugin', 'marketplace', 'list', '--json'], { cwd, timeout: 5000 })).stdout);
      const marketplace = marketplaces.marketplaces?.find((item) => item.name === sections[0][1] && item.marketplaceSource?.sourceType === 'local');
      if (!marketplace || !marketplace.root || !isAbsolute(marketplace.root)) return null;
      directory = resolve(marketplace.root);
      const manifest = JSON.parse(await readFile(join(directory, '.codex-plugin/plugin.json'), 'utf8'));
      if (manifest.name !== 'codex-wake' || manifest.mcpServers !== './mcp.json') return null;
      // Do not trigger the plugin's release download when only a source package is present.
      const binary = join(directory, 'bin/codex-wake'), checksum = join(directory, 'bin/codex-wake.sha256');
      if (!(await lstat(binary)).isFile() || !(await lstat(checksum)).isFile()) return null;
      const expected = /^([a-f\d]{64})  codex-wake\s*$/i.exec(await readFile(checksum, 'utf8'))?.[1];
      if (!expected || createHash('sha256').update(await readFile(binary)).digest('hex') !== expected.toLowerCase()) return null;
    }
    const entry = JSON.parse(await readFile(join(directory, 'mcp.json'), 'utf8')).mcpServers?.['codex-wake'];
    if (entry?.type !== 'stdio' || typeof entry.command !== 'string' || !Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string')) return null;
    return { ...entry, cwd: resolve(directory, entry.cwd || '.') };
  } catch { return null; }
}
