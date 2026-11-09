// Stage input preparation refuses Codex stages unless the Harness subagent hook is trusted.
// Tests use an isolated CODEX_HOME that already trusts it, so they never read the developer's ~/.codex.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexHookTrustHash, codexSubagentHook } from '../../.harness/src/workflow/providers/codex.mjs';

const home = mkdtempSync(join(tmpdir(), 'harness-codex-home-'));
const hook = codexSubagentHook();
writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: { SubagentStart: [{ hooks: [hook] }], SubagentStop: [{ hooks: [hook] }] } }));
const trusted = ['subagent_start', 'subagent_stop'].map((event) => `[hooks.state."${join(home, 'hooks.json')}:${event}:0:0"]\ntrusted_hash = "sha256:${codexHookTrustHash(event, hook)}"\n`).join('\n');
writeFileSync(join(home, 'config.toml'), `[hooks.state]\n\n${trusted}`);
process.env.CODEX_HOME = home;
process.once('exit', () => rmSync(home, { recursive: true, force: true }));
export const trustedCodexHome = home;
