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

1. Use the `session-worktree` skill to prepare the session workspace. 동일 workflow의 active 소유 receipt가 있는 linked worktree만 재사용하고, 그 외에는 공통 create로 새 sibling worktree를 만든다. source branch와 clean 상태 조건은 session-worktree 규칙을 따른다. `origin/main` is not a required base.
2. Run `product-spec` in the high-performance parent context.
3. Call `multi_agent_v1.spawn_agent` with `agent_type="spec_document_writer"`, `fork_context: false`, `model: resolved_low_performance_model_id`, `reasoning_effort: resolved_low_performance_reasoning_effort`, and the settled Product decisions, planned diagram inventory, exact ticket scope, Product template, and absolute `session_worktree`; require the writer's working directory and output path to be under that root. Wait for the lightweight agent result, then review the draft document from the session worktree.
4. When the Product diagram gate applies, call `multi_agent_v1.spawn_agent` with `agent_type="diagram_creator"`, `fork_context: false`, `model: resolved_low_performance_model_id`, `reasoning_effort: resolved_low_performance_reasoning_effort`, and the settled Product requirements, exact ticket scope, and absolute `session_worktree`; require diagram sources and rendered outputs to be under that root. Wait for the lightweight agent result, then review its artifacts and Markdown links in the session worktree.
5. Use `spec-review` to spawn a fresh `spec_adversarial_reviewer` for Product after its document/diagrams are ready. Do not start System Targets/domain-baseline/Architecture until `product_adversarial_review` passes.
   Do not advance until the Product Spec coverage gate and applicable Product 다이어그램 완료 게이트 have passed and `docs/specs/<ticket-id>/product-spec.md` exists in the session worktree.
6. Before `architecture-spec`, complete the `define-system-targets` stage. Describe interaction, workload, state, consistency, availability, and growth, then ask only NFR questions related to those characteristics. Save relevant Current, Expected Growth, and Architecture Boundary goals in `docs/specs/<ticket-id>/system-targets.yaml`; leave irrelevant metric groups empty. Mark known goals `status: resolved`; record unknown values as `status: unresolved` with provenance, confidence, and rationale instead of inventing numbers. Complete the stage only after the registered `system_targets_complete` evaluator passes. Numeric goals require a unit; Architecture Boundary goals may use an observable condition.
   - Product Spec에 Architecture Decision이 포함되면 System Targets에 `decision_metadata: { decision_layer_version: 1, decision_ids: [...] }`를 기록하고 code/infrastructure 결정마다 안정적인 ID를 사용한다. 사용자가 새 결정 workflow를 진행하지 않는 과거 artifact에는 이 metadata를 추가하지 않는다.
7. Complete `domain-baseline` with `code-research` in the session workspace after Product Spec. Read the existing context map, linked model/ADR/diagram evidence and affected source before choosing owners. Return current model, rule and mutation ownership, communication/deployment facts, inspected commit and drift; use `docs/architecture/domain-model.md` when present and recover missing facts from source. Pass the result into `architecture-spec` in the high-performance parent context using the completed Product Spec; do not repeat identical research.
8. Use `event-storming`, `ddd-design`, and `codebase-design` as needed inside the architecture step.
9. Call `multi_agent_v1.spawn_agent` with `agent_type="spec_document_writer"`, `fork_context: false`, `model: resolved_low_performance_model_id`, `reasoning_effort: resolved_low_performance_reasoning_effort`, and the settled Architecture decisions, planned diagram inventory, exact ticket scope, Architecture template, and absolute `session_worktree`; require the writer's working directory and output path to be under that root. Wait for the lightweight agent result, then review the draft document from the session worktree.
10. When the Architecture diagram gate applies, call `multi_agent_v1.spawn_agent` with `agent_type="diagram_creator"`, `fork_context: false`, `model: resolved_low_performance_model_id`, `reasoning_effort: resolved_low_performance_reasoning_effort`, and the settled Architecture design, exact ticket scope, and absolute `session_worktree`; require diagram sources and rendered outputs to be under that root. Wait for the lightweight agent result, then review its artifacts and Markdown links in the session worktree.
11. Before final reviews, reconcile canonical Product/Architecture contracts, terminology and diagrams through sync-contracts. Refresh a stale Product review in a new agent before final Architecture review. Seal only after final reviewed content is stable. After Architecture decisions/diagrams are ready, use `spec-review` with a different fresh reviewer for Architecture and the reviewed Product. `architecture_adversarial_review` and both current review records must pass before completion/to-ticket.
   Do not advance until the Architecture Spec coverage gate and applicable Architecture 다이어그램 완료 게이트 have passed and `docs/specs/<ticket-id>/architecture-spec.md` exists in the session worktree.
   - 결정 artifact가 opt-in된 경우 architecture 결과 완료 전에 등록된 `decision_evidence_complete` 및 `decision_review_complete` gate가 통과해야 한다. 두 gate는 Normal과 Learning mode에 공통 적용한다.
12. 승인된 범위의 Spec 산출물을 session branch에 보존하고 공통 완료 명령으로 검사·archive·worktree 제거를 수행한다. `to-ticket`에는 보존한 branch/HEAD/recovery_path/return_root를 전달하고, 해당 branch로 새 worktree를 만들게 한다. 실제 commit/push 권한은 세션의 사용자 지시를 따른다.
13. PR merge까지 worktree를 유지하지 않는다. 완료·실패·중간 종료 모두 `session-worktree`의 공통 finally cleanup을 수행하고 제거 검증 후에만 종료한다. branch와 미커밋 snapshot은 보존한다.
## 작업 루트 전달과 검증

- `session-worktree` skill이 준비한 `session_worktree`의 절대 경로는 단계와 서브에이전트 사이에 명시적으로 전달한다. Worktree 생성이나 한 명령의 working directory 설정이 이후 호출의 기본 경로를 바꾸지 않는다.
- 첫 단계나 서브에이전트를 시작하기 직전에 `session_worktree`를 `cwd`로 지정해 `node .codex/scripts/harness-workspace-preflight.mjs --expected-root <session_worktree> --json`을 실행한다. `spec-me`의 `before_dispatch` lifecycle hook은 `session_worktree` 검사를 실행하며 `valid: true`, `cwd`, `git_root`, `worktree_registered: true`, `is_linked_worktree: true` 증거가 모두 있어야 통과한다. 실패하면 workflow를 시작하지 않는다. 모든 위임 호출은 `cwd`와 `workspace_root`를 같은 절대 경로로 전달한다.
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

## Engineering Decision Review

- 새 단계는 role/skill을 dispatch하기 직전에 `evaluateWorkflowStage({ workflow, stageId, input: { review_session } })`로 실행 여부를 평가한다. 결과가 `skip`이면 해당 단계를 reviewer에게 dispatch하지 않고 건너뛰며, `dispatch`일 때만 선언된 role/skill을 실행한다.
- 새 decision workflow는 사용자가 명시적으로 `Normal`을 선택하지 않으면 `Learning`에서 시작한다. 검증된 mode 입력과 사용자 역할이 기록된 이력에서 등록된 `learning_mode` 조건을 평가한다. workflow YAML에 정적 mode 필드를 추가하지 않는다.
- In Learning, dispatch `architecture_review_lead` with the `architecture-review` skill after the Architecture Decision is prepared. The Reviewer challenges with provenance-backed objections and the shared seven-item checklist, but does not provide answers or choose for the user.
- Before the Reviewer uses newly discovered source, claims, or context, present the exact material to the user and wait for explicit material-use approval. Rejection excludes the material and requires an alternative or a hold. This approval is separate from Principle approval.
- An explicit Learning → Normal transition preserves local history, material-approval waits, and unresolved gates. Normal mode removes the Reviewer challenge loop only; it does not bypass decision evidence or review gates.
- On a `decision_layer_version: 1` ticket, look up project-local Principles through the read-only registry contract. Only hash-valid `approved` Principles are authoritative; `candidate` and `reviewed` records are informational context. Do not create, revise, approve, or deprecate Principles from `spec-me`.
- If lookup has no applicable approved Principle, or the human Reviewer finds the approved material insufficient, keep the Decision on hold and continue research/material presentation. Wait for explicit user approval before the Reviewer uses newly found material; lookup never writes a Principle.
- Use only approved durable project Evidence as authoritative Decision evidence. Preserve target, accepted Decision, Principle, and Evidence IDs together when passing final architecture/ADR context downstream. Referenced object edits do not automatically invalidate another object's approval.
- A deprecated Principle is no longer authoritative. Referencing Decisions are marked `review_required` with their existing approval and history preserved; the Decision review gate stays blocked until the user and Reviewer revisit the affected topic.

## Rules

- Product Spec does not inspect source or test code.
- When the request or confirmed interview answers contain reusable implementation-only or test-running preferences, pass the absolute original-project `shared_guidance_root` (`return_root`) and update its `docs/agents/implementation-guidance.md` or `testing-guidance.md` through the matching guidance skill, even when ticket artifacts belong in a session worktree. Verify it shares the same Git common directory as `workspace_root`. Do not turn inferred preferences, ticket-specific behavior, or unsettled architecture choices into durable guidance. Keep both documents separate from Product and Architecture contracts.
- Architecture Spec does inspect current code and test structure.
- Current implementation may settle descriptive facts but does not automatically settle desired product behavior or a material target architecture decision.
- `CONTEXT.md` is glossary only.
- The model decides whether to write an ADR. Write one when the decision is worth preserving; otherwise do not.

## 통합 계약 연속성

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. `sync-contracts`에 따라 영향 섹션·용어·다이어그램·버전을 갱신하고, 정상 종료는 공통 완료 명령의 pass receipt로 확인한다. ticket Spec은 변경 근거다.

## 세션 출력

`docs/agents/EXEC.md`의 세션 파일 출력 경계를 따른다. `harness-session-output.mjs --root <workspace_root>`로 절대 `session_directory`를 구하고 모든 agent/tool에 전달한다. 로그·임시 파일·스크린샷·실행 증거는 그 아래에만 저장한다. 각 process의 TMPDIR/TMP/TEMP와 browser output 경로도 지정한다. 최종 source·Spec·계약·제품 다이어그램은 선언된 프로젝트 경로에 둔다.

## Fresh 적대적 Spec 리뷰

`spec-review`를 필수 적용한다. 요청 원문과 확정된 사용자 답변만 request.md에 보존하고 각 리뷰어를 fork_turns:none(동등 adapter fork_context:false)으로 새로 생성한다. 고성능 모델/effort를 실제 값으로 해석해 전달한다. writer의 설명이나 전체 대화는 상속하지 않는다. Normal mode도 이 리뷰를 생략하지 않는다. blocker/major는 수정 또는 interview 재개 후 fresh 재검토하며 최대 2회 보정 후 미해결은 blocked다. completion state에는 ticket_id와 실제 reviewer 원본/metadata의 spec_reviews를 넣고, to-ticket은 같은 branch와 review evidence를 인계받아 최신 hash로 재검사한다. 부모의 자체 검토로 대체하지 않는다.

현재 workflow가 새로 작성한 draft의 리뷰 수정은 기존 요청 범위에서 수행한다. 과거 승인 Spec의 실질 변경이나 사용자 결정 변경은 기존 확인 규칙을 따르며, 단순 재검토를 이유로 동일 draft 수정 승인을 반복 요청하지 않는다.
