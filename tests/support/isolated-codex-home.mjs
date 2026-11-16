// Tests run setup and update, which write the Codex user hooks. Point them at a throwaway CODEX_HOME so a test run
// never edits the developer's ~/.codex (it once added untrusted Harness hooks there).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.CODEX_HOME) {
  const home = mkdtempSync(join(tmpdir(), 'harness-test-codex-home-'));
  process.env.CODEX_HOME = home;
  process.once('exit', () => rmSync(home, { recursive: true, force: true }));
}

// Harness decides which CLI is running from these variables (runtimeAgentProvider). A test that does not choose a
// provider must not depend on the CLI that happens to run the suite, so they are cleared here; a test that needs a
// provider sets it explicitly for the process or command it starts.
for (const name of ['HARNESS_PROVIDER_ID', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']) delete process.env[name];
