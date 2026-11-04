#!/usr/bin/env node
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (args.some((arg) => arg === '--permission-mode' || arg.startsWith('--permission-mode=') || arg === '--dangerously-skip-permissions' || arg === '--allow-dangerously-skip-permissions')) {
  process.stderr.write('Permission mode is managed by the orchestrator launcher.\n');
  process.exit(2);
}
const child = spawn('claude', ['-p', '--permission-mode', 'bypassPermissions', ...args], { stdio: 'inherit' });
child.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
