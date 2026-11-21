#!/usr/bin/env node
const installed = new URL('../../.harness/src/contracts/contracts.mjs', import.meta.url);
const { runContractsCli } = await import(installed.href);
await runContractsCli();
