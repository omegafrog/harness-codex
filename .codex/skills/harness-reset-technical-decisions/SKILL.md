---
name: harness-reset-technical-decisions
description: >
  Reset one ChangeSet use case's Technical Decisions stage from scratch without
  running an agent. Use when the user wants to discard current
  technical-decisions.md content, cancel pending Technical Decisions questions,
  clear persisted dashboard rerun state, or restart Technical Decisions with no
  previous answer history.
---

# Reset Technical Decisions

Run bundled deterministic script. Do not invoke harness runtime commands or
`$harness-technical-decisions`.

```bash
python3 .codex/skills/harness-reset-technical-decisions/scripts/reset.py \
  --repo-root <repo-root> \
  --change-set <CHG-ID> \
  --uc <UC-ID>
```

Report script JSON result. Do not edit other UC artifacts. Do not start a new
Technical Decisions run unless user separately requests it.
