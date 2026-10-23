---
name: spec-me
description: Turn a user request into Product Spec and Architecture Spec, then recommend to-ticket without jumping to implementation.
---

# spec-me

## What it does

`spec-me` turns a user request into Product Spec and Architecture Spec, then recommends `to-ticket`.

The `spec-me` parent must run with the model ID and reasoning effort resolved from `agents.high_performance_model` and `agents.high_performance_reasoning_effort`. The skill cannot change the model of an already-running parent invocation; when the runtime exposes model selection, select the configured high-performance pair before starting.

Subagent routing is explicit: `spec_document_writer` owns Spec Markdown and `diagram_creator` owns diagram files. Before each lightweight spawn, resolve `agents.low_performance_model` and `agents.low_performance_reasoning_effort` to actual runtime values and pass them to `multi_agent_v1.spawn_agent` with `fork_context: false`. `model: agents.low_performance_model` means the resolved model ID, never the literal config key. If either value is missing, invalid, or unavailable, stop and require `setup`; never omit the override, inherit the high-performance parent, or perform delegated writing/diagram work in the parent.

If the request is about broken behavior, flaky regression, or performance regression, `spec-me` is not the right on-ramp; use `diagnosing-bugs` instead.

## Flow

1. 진입 시 [worktree-create](../../../.codex/internal-skills/worktree-create/GUIDE.md)를 실행한다. 생성한 `worktree.json`의 `workspace`를 `session_worktree`로 사용한다. 이후 단계와 agent에는 같은 절대 경로를 `workspace_root`와 `cwd`로 지정하고 `session_directory`를 전달한다.
2. [Product Spec 절차](../../../.codex/internal-skills/product-spec/GUIDE.md)와 [Architecture 결정 단계](references/architecture-decision.md)를 순서대로 진행하며, 리뷰 시점과 gate는 [적대적 Spec 리뷰](references/adversarial-spec-review.md)를 따른다.
3. 리뷰와 완료 gate를 통과한 Specs와 근거를 session branch에 보존한 뒤 같은 worktree를 [`to-ticket`](../to-ticket/SKILL.md)에 넘긴다.
## Documents

- Create `docs/specs/<ticket-id>/` when missing.
- Spec artifacts belong to the session worktree until its branch is merged. Before accepting any writer/diagram result, verify every reported output resolves inside `session_worktree`; reject results written to the base workspace or another worktree. Never write Spec files into the base workspace during a managed session.
- Resolve the ticket ID before writing the specs.
- Do not overwrite an existing ticket-scoped spec without explicit user approval.

## Rules

- When the request or confirmed interview answers contain reusable implementation-only or test-running preferences, pass the absolute original-project `shared_guidance_root` (`return_root`) and update its `docs/agents/implementation-guidance.md` or `testing-guidance.md` through the matching [implementation guidance](../../../.codex/internal-skills/implementation-guidance/GUIDE.md) or [testing guidance](../../../.codex/internal-skills/testing-guidance/GUIDE.md). Verify it shares the same Git common directory as `workspace_root`. Keep inferred preferences, ticket-specific behavior, and unsettled architecture choices out of durable guidance.
- The model decides whether to write an ADR. Write one when the decision is worth preserving; otherwise do not.

## 기준 계약

Spec 설계 전에 대상 프로젝트의 `docs/contracts/` 계약과 연결 다이어그램을 읽고 현재 구현 기준으로 참고한다. 제안하는 변경은 ticket-scoped Spec에 기록한다. 통합 계약 갱신은 구현 ticket 통합이 끝난 최종 구현 완료 단계에서 수행한다.

## 세션 출력

`node .codex/scripts/harness-session-output.mjs --root <workspace_root>`로 `session_directory`를 구해 agent와 tool에 전달한다. 리뷰 증거와 임시 산출물은 그 경로에, Spec과 다이어그램은 선언된 프로젝트 경로에 기록한다.
