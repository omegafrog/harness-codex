#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
let sourceCheckout = false;
try { sourceCheckout = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).name === '@omegafrog/harness-codex'; } catch {}
import { resolve } from 'node:path';
const installed = new URL('../harness-runtime/src/workflow/session-output.mjs', import.meta.url);
const source = new URL('../../src/workflow/session-output.mjs', import.meta.url);
const { sessionDirectory, sessionOutputPath } = await import(existsSync(installed) && !sourceCheckout ? installed.href : source.href);
try {
  let root = process.cwd(), output = null;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!value || !['--root', '--path'].includes(key)) throw new Error('Usage: harness-session-output.mjs --root DIR [--path RELATIVE]');
    if (key === '--root') root = resolve(value); else output = value;
  }
  process.stdout.write(`${output ? sessionOutputPath(root, output) : sessionDirectory(root)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
