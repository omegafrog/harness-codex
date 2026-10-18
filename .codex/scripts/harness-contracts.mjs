#!/usr/bin/env node
import { existsSync } from 'node:fs';
const installed = new URL('../harness-runtime/src/contracts/contracts.mjs', import.meta.url);
const source = new URL('../../src/contracts/contracts.mjs', import.meta.url);
const { runContractsCli } = await import(existsSync(installed) ? installed.href : source.href);
await runContractsCli();
