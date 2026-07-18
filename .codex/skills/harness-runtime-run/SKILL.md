---
name: harness-runtime-run
description: Run repository-local application and wiki commands through the harness runtime. Use when the user asks for `harness run app`, app server status/stop/attach, foreground app runs, wiki serve/build/install, or runtime server verification.
---

# Harness Runtime Run

## Command Map

- `./harness run app init [--force]`
- `./harness run app [--timeout SECONDS] [-- SERVER_ARG ...]`
- `./harness run app --foreground [-- APP_ARG ...]`
- `./harness run app status`
- `./harness run app stop`
- `./harness run app attach infra|server`
- `./harness run wiki [serve|build|install] [--dev-addr HOST:PORT]`

## Procedure

1. Use `run app init` only to generate `infra/harness/aws/**` and run Terraform `init` and `validate`; never infer application scripts or apply AWS resources.
2. Use status before starting or stopping existing app sessions.
3. Prefer managed `run app` for runtime verification when plan asks for runtime server proof.
4. Stop servers after verification unless user wants them left running.
5. For wiki changes, run `./harness run wiki build` before reporting success.
6. Summarize logs; avoid dumping long server output.
