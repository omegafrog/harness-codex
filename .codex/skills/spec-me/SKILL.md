---
name: spec-me
description: Turn a user request into Product Spec and Architecture Spec, then recommend to-ticket without jumping to implementation.
---

# spec-me

## What it does

`spec-me` turns a user request into Product Spec and Architecture Spec, then recommends `to-ticket`.

The `spec-me` parent must run with the model ID and reasoning effort resolved from `agents.high_performance_model` and `agents.high_performance_reasoning_effort`. The skill cannot change the model of an already-running parent invocation; when the runtime exposes model selection, select the configured high-performance pair before starting.

Subagent routing is explicit: `spec_document_writer` owns Spec Markdown and `diagram_creator` owns diagram files. Before every lightweight spawn, resolve the configured `agents.low_performance_model` and `agents.low_performance_reasoning_effort` to actual runtime values, then pass those values to `multi_agent_v1.spawn_agent`. `model: agents.low_performance_model` means the resolved model ID, never the literal config key. If either low-performance value is missing, invalid, or unavailable, stop and require `setup`; never omit the override, inherit the high-performance parent, or perform delegated writing/diagram work in the parent.

If the request is about broken behavior, flaky regression, or performance regression, `spec-me` is not the right on-ramp; use `diagnosing-bugs` instead.

## Flow

1. At session entry, inspect the current repository root, current branch, `HEAD`, and porcelain status. Record the absolute current root as `source_workspace`. If the workspace is dirty, detached, or already a worktree session, stop before creating another worktree.
2. Create a sibling session worktree and dedicated branch from the captured current branch and `HEAD`; record `session_base_branch`, `session_base_sha`, `session_worktree`, and `session_branch`. Tracked files come from the captured `HEAD`; also carry over local setup configuration that Git does not track. If `<source_workspace>/.codex/harness.yaml` exists and `<session_worktree>/.codex/harness.yaml` does not, create the target `.codex` directory and copy that file into the session worktree without overwriting an existing target. Treat the absolute `session_worktree` path as required workflow context: pass it to every agent and tool call that reads or writes repository files, and explicitly set each command's working directory to it. Creating the worktree does not change the caller's or later tools' default working directory. Before any workflow stage or subagent spawn, install the project-local Harness runtime into that worktree. If running from a Harness source checkout, invoke its installer with `node <harness_source_root>/bin/harness-install.mjs install --project <session_worktree> --force`. If the application checkout does not contain the Harness source, use `npx --yes github:omegafrog/harness-codex install --project <session_worktree> --force`; do not assume `bin/harness-install.mjs` exists in the application worktree. For each required skill (`spec-me` and `product-spec`), resolve `<session_worktree>/.agents/skills/<skill>/SKILL.md` first, falling back to `<session_worktree>/.codex/skills/<skill>/SKILL.md`, matching the workflow loader. Harness source checkouts and their worktrees use the repository-owned `.codex/skills` directly; the installer intentionally skips copying skills and rewriting agent profiles there. Verify the resolved skill files, `<session_worktree>/.codex/agents/spec_document_writer.toml`, and `<session_worktree>/.codex/workflows/spec-me.yaml` exist. If installation or verification fails, stop; do not run Spec work in an unprepared worktree.
3. Run `product-spec` in the high-performance parent context.
4. Call `multi_agent_v1.spawn_agent` with `agent_type="spec_document_writer"`, `fork_context: false`, `model: resolved_low_performance_model_id`, `reasoning_effort: resolved_low_performance_reasoning_effort`, and the settled Product decisions, planned diagram inventory, exact ticket scope, Product template, and absolute `session_worktree`; require the writer's working directory and output path to be under that root. Wait for the lightweight agent result, then review the draft document from the session worktree.
5. When the Product diagram gate applies, call `multi_agent_v1.spawn_agent` with `agent_type="diagram_creator"`, `fork_context: false`, `model: resolved_low_performance_model_id`, `reasoning_effort: resolved_low_performance_reasoning_effort`, and the settled Product requirements, exact ticket scope, and absolute `session_worktree`; require diagram sources and rendered outputs to be under that root. Wait for the lightweight agent result, then review its artifacts and Markdown links in the session worktree.
6. Do not advance until the Product Spec coverage gate and applicable Product 다이어그램 완료 게이트 have passed and `docs/specs/<ticket-id>/product-spec.md` exists in the session worktree.
7. Run `architecture-spec` in the high-performance parent context using the completed Product Spec.
8. Use `event-storming`, `ddd-design`, and `codebase-design` as needed inside the architecture step.
9. Call `multi_agent_v1.spawn_agent` with `agent_type="spec_document_writer"`, `fork_context: false`, `model: resolved_low_performance_model_id`, `reasoning_effort: resolved_low_performance_reasoning_effort`, and the settled Architecture decisions, planned diagram inventory, exact ticket scope, Architecture template, and absolute `session_worktree`; require the writer's working directory and output path to be under that root. Wait for the lightweight agent result, then review the draft document from the session worktree.
10. When the Architecture diagram gate applies, call `multi_agent_v1.spawn_agent` with `agent_type="diagram_creator"`, `fork_context: false`, `model: resolved_low_performance_model_id`, `reasoning_effort: resolved_low_performance_reasoning_effort`, and the settled Architecture design, exact ticket scope, and absolute `session_worktree`; require diagram sources and rendered outputs to be under that root. Wait for the lightweight agent result, then review its artifacts and Markdown links in the session worktree.
11. Do not advance until the Architecture Spec coverage gate and applicable Architecture 다이어그램 완료 게이트 have passed and `docs/specs/<ticket-id>/architecture-spec.md` exists in the session worktree.
12. Commit the complete Spec change in the session branch, then recommend `to-ticket` and the downstream implementation workflow from that same session worktree.
13. After the implementation PR is merged, verify the session branch/worktree has no uncommitted or untracked changes, verify the merge landed on the captured base branch, return the active session to the base branch workspace, then remove the session worktree. If PR merge, clean status, or base-branch verification fails, retain the worktree and report the blocker.

## 작업 루트 전달과 검증

- `session_worktree`의 절대 경로는 단계와 서브에이전트 사이에 명시적으로 전달한다. Worktree 생성이나 한 명령의 working directory 설정이 이후 호출의 기본 경로를 바꾸지 않는다.
- 새 worktree에서 첫 단계나 서브에이전트를 시작하기 직전에 그 worktree를 `cwd`로 지정해 `node .codex/scripts/harness-workspace-preflight.mjs --expected-root <session_worktree> --json`을 실행한다. 결과의 `valid: true`, `cwd`, `git_root`, `worktree_registered`를 확인한다. 실패하면 해당 단계/agent를 시작하지 않는다. 모든 위임 호출은 `cwd`와 `workspace_root`를 같은 절대 경로로 전달한다.
- 저장소 파일을 읽거나 쓰는 모든 명령과 에이전트 호출에 `session_worktree`를 지정한다. 생성된 Spec·다이어그램 경로가 해당 루트 안인지 확인한 뒤 단계 완료를 인정한다.

## Interview gates

Both specification stages are coverage-driven interviews through `grill-with-docs`.

- `product-spec` owns the Product Spec coverage checklist.
- `architecture-spec` owns the Architecture Spec coverage checklist.
- `grill-with-docs` owns the one-question-at-a-time interview loop and completion gate.
- `spec-me` MUST NOT bypass, shorten, or reinterpret either stage's coverage gate merely to complete the workflow in one pass.
- If a stage still has a material `PARTIAL` or `UNRESOLVED` topic, remain in that stage and continue the interview after the user's next answer.
- Do not manufacture a minimum number of questions. The gate is coverage, not question count.
- Zero-question completion is allowed only when the stage satisfies the exceptional zero-question rule in `grill-with-docs`.

## Documents

- Write the completed Product Spec to `docs/specs/<ticket-id>/product-spec.md` using the `product-spec` template.
- Write the completed Architecture Spec to `docs/specs/<ticket-id>/architecture-spec.md` using the `architecture-spec` template.
- Create `docs/specs/<ticket-id>/` when missing.
- Spec artifacts belong to the session worktree until its branch is merged. Before accepting any writer/diagram result, verify every reported output resolves inside `session_worktree`; reject results written to the base workspace or another worktree. Never write Spec files into the base workspace during a managed session.
- Resolve the ticket ID before writing the specs.
- Do not overwrite an existing ticket-scoped spec without explicit user approval.
- Do not claim either stage is complete until both its interview coverage gate has passed and its document exists.
- Each stage's diagram completion gate requires the applicable `.puml` original, successful local render through the existing renderer, non-empty SVG, Markdown SVG link, ID traceability, and Spec-content consistency review. A missing or failed render blocks stage completion.
- 다이어그램 완료 게이트의 원본은 `.puml` 파일이며, 렌더된 SVG와 Markdown 링크까지 확인해야 한다.
- 원본과 렌더 산출물의 내용 일치 검토가 끝나야 단계 완료로 판정한다.
- 렌더 실패는 해당 Spec 단계 완료를 막는다.
- 다이어그램 생성·렌더링은 경량 `diagram_creator` 서브에이전트가 실행하고, `spec-me`가 산출물·내용 일치를 검토한다.
- Spec Markdown 작성은 경량 `spec_document_writer` 서브에이전트가 실행한다. 이 에이전트는 확정된 결정만 템플릿에 기록하고 요구사항·설계 결정을 만들거나 변경하지 않는다.
- 다이어그램 작업을 상위 에이전트가 직접 수행하지 않는다. `diagram_creator` 결과가 실패하면 원인·파일·복구 방법을 보고하고 해당 Spec 게이트를 멈춘다.
- Apply diagrams conditionally: no flow change means no forced Product flow diagrams; Product never gets class diagrams; duplicate business/design state diagrams are not created.

## Rules

- Product Spec does not inspect source or test code.
- Architecture Spec does inspect current code and test structure.
- Current implementation may settle descriptive facts but does not automatically settle desired product behavior or a material target architecture decision.
- `CONTEXT.md` is glossary only.
- The model decides whether to write an ADR. Write one when the decision is worth preserving; otherwise do not.
