#!/usr/bin/env node
import { runWriteGuardHook } from '../../.harness/scripts/harness-write-guard.mjs';

await runWriteGuardHook();
