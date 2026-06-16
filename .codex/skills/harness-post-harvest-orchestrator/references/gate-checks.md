## Gate Checks

After each stage, verify only the expected output files exist and are non-empty.

If a gate fails:

- Stop immediately.
- Report which stage failed.
- Report the missing or empty files.
- Do not continue to downstream stages.

