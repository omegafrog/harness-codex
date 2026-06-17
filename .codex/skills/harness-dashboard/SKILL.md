---
name: harness-dashboard
description: Use harness dashboard runtime commands. Use when the user asks for dashboard JSON, contract dashboard projection, local dashboard server, UI server, or `harness dashboard` / `harness ui-server`.
---

# Harness Dashboard

## Command Map

- `./harness dashboard [contracts --change-set <CHG-ID> --format json]`
- `./harness ui-server [--host HOST] [--port PORT]`

## Procedure

1. Use `dashboard` for state JSON and `ui-server` for browser UI.
2. For contract views, pass explicit `--change-set`.
3. If starting `ui-server`, keep session running only when user needs live UI; report URL.
4. For dashboard code changes, verify with:

```bash
node --check harness_codex/runtime/dashboard_assets/dashboard.js
python3 -m py_compile harness_codex/runtime/ui_server.py harness_codex/runtime/document_dashboard.py
```
