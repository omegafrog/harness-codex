---
name: harness-runtime-artifacts
description: Show or accept generated harness runtime stage artifacts. Use when the user asks to inspect generated stage output, accept a stage artifact, approve runtime artifacts, or run `harness artifacts show|accept`.
---

# Harness Runtime Artifacts

## Command Map

- `./harness artifacts show <CHG-ID> <stage>`
- `./harness artifacts accept <CHG-ID> <stage>`

## Procedure

1. Use `show` before `accept` unless the user already reviewed the artifact.
2. For `accept`, state exact ChangeSet and stage, then require explicit approval if the user did not already ask to accept.
3. After acceptance, run `./harness stages list <CHG-ID>` to show updated state.
4. Do not edit artifact content inside this skill.
