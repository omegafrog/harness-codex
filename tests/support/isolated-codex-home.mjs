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
