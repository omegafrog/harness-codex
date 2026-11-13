import { execFile, spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);

async function hasExistingWakeBinary(transport) {
  const wrapper = [transport.command, ...(transport.args || [])].find((arg) => typeof arg === 'string' && /(?:^|\/)run-mcp\.sh$/.test(arg));
  if (!wrapper) return true;
  try {
    const plugin = resolve(transport.cwd, wrapper, '../..');
    const binary = join(plugin, 'bin/codex-wake'), checksum = `${binary}.sha256`;
    if (!(await lstat(binary)).isFile() || !(await lstat(checksum)).isFile()) return false;
    const sum = /^([a-f\d]{64})  codex-wake\s*$/i.exec(await readFile(checksum, 'utf8'))?.[1];
    return Boolean(sum && createHash('sha256').update(await readFile(binary)).digest('hex') === sum.toLowerCase());
  } catch { return false; }
}

export async function existingCodexWake(cwd, { verifyBinary = true } = {}) {
  try {
    const config = JSON.parse((await exec('codex', ['mcp', 'get', 'codex-wake', '--json'], { cwd, timeout: 5000 })).stdout);
    if (config.enabled && config.transport?.type === 'stdio' && config.transport.command && config.transport.cwd) return !verifyBinary || await hasExistingWakeBinary(config.transport) ? config.transport : null;
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
    const transport = { ...entry, cwd: resolve(directory, entry.cwd || '.') };
    return !verifyBinary || await hasExistingWakeBinary(transport) ? transport : null;
  } catch { return null; }
}

// Wake owns one shared service. Check its account before launching the MCP, which can start or alter that service.
export async function checkWakeService(cwd, transport = null) {
  const codex_home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  try {
    const service = (await exec('systemctl', ['--user', 'show', 'codex-wake.service', '--property=Environment', '--value'], { cwd, timeout: 3000 })).stdout;
    const value = (key) => {
      const match = new RegExp(`(?:^|\\s)${key}=(?:"([^"]+)"|(\\S+))`).exec(service);
      return match?.[1] || match?.[2] || null;
    };
    const { realpath } = await import('node:fs/promises');
    const canonical = async (path) => realpath(path).catch(() => path);
    const serviceHome = value('CODEX_HOME');
    if (serviceHome && await canonical(resolve(serviceHome)) !== await canonical(codex_home)) return { status: 'unavailable', reason: 'service_codex_home_mismatch', codex_home, service_codex_home: resolve(serviceHome) };
    const pluginBase = value('CODEX_WAKE_PLUGIN_BASE');
    const wrapper = transport && [transport.command, ...(transport.args || [])].find((arg) => typeof arg === 'string' && /(?:^|\/)run-mcp\.sh$/.test(arg));
    if (pluginBase && wrapper) {
      const base = await canonical(resolve(pluginBase));
      const plugin = await canonical(resolve(transport.cwd, wrapper, '../..'));
      const rel = relative(base, plugin);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { status: 'unavailable', reason: 'service_plugin_path_mismatch', codex_home, service_plugin_base: base, plugin_path: plugin };
    }
    return { status: 'available', codex_home, service_check: serviceHome ? 'matched' : 'not_detected' };
  } catch { return { status: 'available', codex_home, service_check: 'not_detected' }; }
}

// A tools/list handshake checks the configured MCP without queuing a message or resuming a thread.
export async function inspectCodexWake(cwd) {
  const codex_home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const account = await checkWakeService(cwd);
  if (account.status !== 'available') return account;
  const transport = await existingCodexWake(cwd, { verifyBinary: false });
  if (!transport) return { status: 'unavailable', reason: 'not_configured_for_active_codex_home', codex_home };
  if (typeof transport.command !== 'string' || typeof transport.cwd !== 'string' || (transport.args !== undefined && (!Array.isArray(transport.args) || transport.args.some((arg) => typeof arg !== 'string'))) || (transport.env != null && (typeof transport.env !== 'object' || Array.isArray(transport.env)))) return { status: 'unavailable', reason: 'invalid_mcp_transport', codex_home };
  if (!await hasExistingWakeBinary(transport)) return { status: 'unavailable', reason: 'existing_wake_binary_missing_or_invalid', codex_home };
  const service = await checkWakeService(cwd, transport);
  if (service.status !== 'available') return service;
  const result = await new Promise((resolveResult) => {
    let finished = false, buffer = '';
    const child = spawn(transport.command, transport.args || [], { cwd: transport.cwd, env: { ...process.env, ...transport.env, CODEX_HOME: codex_home, CODEX_WAKE_BUILD_FROM_SOURCE: '0' }, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (status, reason) => { if (finished) return; finished = true; clearTimeout(timer); child.kill(); resolveResult({ status, reason, codex_home }); };
    const timer = setTimeout(() => finish('unavailable', 'mcp_timeout'), 10000);
    child.on('error', () => finish('unavailable', 'mcp_start_failed'));
    child.on('close', () => finish('unavailable', 'mcp_closed'));
    child.stdin.on('error', () => finish('unavailable', 'mcp_input_failed'));
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 100000) return finish('unavailable', 'mcp_response_too_large');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message; try { message = JSON.parse(line); } catch { return finish('unavailable', 'mcp_invalid_response'); }
        if (message.id === 1 && message.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          const found = Array.isArray(message.result?.tools) && message.result.tools.some((tool) => tool.name === 'queue_thread');
          return finish(found ? 'available' : 'unavailable', found ? 'queue_thread_available' : 'queue_thread_missing');
        } else if (message.id === 1 && message.error) return finish('unavailable', 'mcp_initialize_failed');
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'harness-setup', version: '1' } } });
  });
  if (result.status !== 'available') return result;
  return { ...result, service_check: service.service_check };
}
