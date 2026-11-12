# Stage 입력 프롬프트 구성

workflow stage 하나가 실행될 때 모델이 받는 입력을 정리한다. 실제 조립은 [`harness-agent-run.mjs`](../../.codex/scripts/harness-agent-run.mjs)와 [`buildStagePrompt`](../../.harness/src/workflow/execution-context.mjs)가 한다. 크기는 이 문서를 쓴 시점의 source 기준이다.

## 1. 모든 stage에 공통으로 들어가는 것

| 순서 | 내용 | 정본 파일 | 전달 방식 |
|---|---|---|---|
| 1 | Worker 기본 규칙 (0.8KB) | [`worker-base.md`](../../.codex/internal-skills/skill-execution/worker-base.md) | Codex: `model_instructions_file` ([codex.mjs](../../.harness/src/workflow/providers/codex.mjs) `stageConfigArgs`). Claude: `--system-prompt`에 고정 문구 한 단락을 덧붙여 전달 ([claude-code.mjs](../../.claude/harness/providers/claude-code.mjs) `buildCommand`) |
| 2 | 프로젝트 지침 | consumer의 `AGENTS.md`(Codex), `CLAUDE.md`(Claude Code) | provider 기본 동작으로 읽힌다. Harness는 이를 끄거나 따로 넣지 않는다 |
| 3 | 실행 위치 안내 | — | prompt 첫 문장: workspace 경로, `input.json` 경로, runtime 디렉터리, plan set의 Spec·plan 디렉터리 |
| 4 | Stage GUIDE 전문 | `.codex/internal-skills/<skill>/GUIDE.md` | prompt에 `Current stage guide (...)`로 붙임 |
| 5 | Agent 프로필 전문 | `.codex/agents/<role>.toml` (Claude는 변환된 `.claude/agents/<role>.md`) | prompt에 `Current agent profile (...)`로 붙임. 역할 선언과 GUIDE 경로만 담는다 |
| 6 | 반환 계약·질문 반환 형식 (3.0KB) | [`stage-return.md`](../../.codex/internal-skills/skill-execution/references/stage-return.md) | prompt에 `Current phase instructions (...)`로 항상 붙임 |
| 7 | 단계별 추가 지침 | `spec-me`: [`product-spec/GUIDE.md`](../../.codex/internal-skills/product-spec/GUIDE.md) + [`topics.md`](../../.codex/internal-skills/product-spec/references/topics.md) (Product Spec 파일이 생기기 전까지). `product-spec`: `topics.md` | 6과 같은 방식. 다른 skill은 없음 |
| 8 | 상황별 문장 | — | 사용자 답변(`answers.json`)·feedback 경로, 현재 phase, compaction 복구 안내, read-only 실행 안내, 마지막 지시문 |
| 9 | 결과 schema | [`return.schema.json`](../../.codex/internal-skills/skill-execution/schemas/return.schema.json) + `flows/common`·`spec-review`·`plan-review` 중 하나 | Codex `--output-schema`, Claude `--json-schema`. 조립: [`output-schema.mjs`](../../.harness/src/workflow/output-schema.mjs) |

모델이 직접 읽는 파일:

- `input.json`: [`stage-input.mjs`](../../.harness/src/workflow/stage-input.mjs)가 만들고 [`input.schema.json`](../../.codex/internal-skills/skill-execution/schemas/input.schema.json) 형식을 따른다. `input_refs`(승인 Spec·plan·이전 결과)와 `context`(`worktree_ref`, `plan_set_id`, `execution_workspace`, `publication_drafts` 등)를 담는다.
- GUIDE가 링크한 reference 문서: prompt에는 넣지 않으며 필요할 때 모델이 읽는다.

이어서 실행(resume)할 때는 바뀌지 않은 GUIDE·프로필·추가 지침을 다시 넣지 않는다. provider가 context compaction을 기록했으면 다시 넣는다.

역할별 도구 제한도 같이 적용된다. Codex는 `stageConfigArgs`가 web search·이미지·MCP 서버를 역할별로 켜고 끈다. Claude는 `allowedToolsForRole`이 도구 목록을 정한다.

## 2. 기본 흐름의 runner stage

orchestrator는 `harness-prepare-input.mjs --stage-id <stage-id>`로 입력을 만들고 `harness-agent-run.mjs`로 실행한다. 입력은 manifest의 stage ID를 보존하고 해당 stage의 skill을 사용한다. runner는 `context.stage_id`와 skill로 workflow manifest의 `role`, model tier, sandbox를 붙인다([`stage-input.mjs`](../../.harness/src/workflow/stage-input.mjs), [`resolveWorkflowStage`](../../.harness/src/workflow/skill-execution.mjs)). 기본 흐름에는 `plan-pr`와 `integration-pr`처럼 stage ID와 skill 이름이 다른 stage도 있다.

| 순서 | stage | GUIDE (prompt에 붙음) | 프로필 | sandbox | 반환과 runtime 검사 |
|---|---|---|---|---|---|
| 0 | `workflow-compose` | 모델 stage 아님. [`harness-compose-workspace.mjs`](../../.codex/scripts/harness-compose-workspace.mjs)가 worktree·`worktree.json`·`plan_set_id`를 만든다 | — | — | 준비된 worktree가 등록된 linked worktree이고 project readiness가 pass여야 한다 |
| 1 | `spec-me` | [`spec-me`](../../.codex/internal-skills/spec-me/GUIDE.md) 8.2KB (+ Product 단계 지침, 아래) | 없음 | workspace-write | `completed/OK`. 완료 시 현재 두 Spec의 독립 리뷰 pass 필요. `review_request: spec-review` 반환 금지 |
| 2 | `to-ticket` | [`to-ticket`](../../.codex/internal-skills/to-ticket/GUIDE.md) 4.3KB | [`to_ticket`](../../.codex/agents/to_ticket.toml) | workspace-write | `completed/OK`. 완료 시 현재 plan review pass 필요. `REVIEW_REQUIRED` 반환 금지 |
| 3 | `tracker-publish` (사용자 발행 승인 뒤) | [`tracker-publish`](../../.codex/internal-skills/tracker-publish/GUIDE.md) 2.7KB | [`tracker_publisher`](../../.codex/agents/tracker_publisher.toml) | danger-full-access | `completed/OK`. 완료 시 Project draft 발행을 다시 조회해 확인 |
| 4 | `implement-wrapper` (plan마다) | [`implement-wrapper`](../../.codex/internal-skills/implement-wrapper/GUIDE.md) 6.4KB. [`implement`](../../.codex/internal-skills/implement/GUIDE.md)(14.6KB)는 모델이 읽는다 | 없음 | workspace-write | 구현 뒤 `action_required/REVIEW_REQUIRED`. 리뷰 결과는 `--feedback`으로 같은 stage에 돌아온다 |

stage 사이 입력: 앞 stage 결과의 `artifacts`가 다음 stage의 `input_refs`가 된다. `implement-wrapper`는 `to-ticket`과 `spec-me` 결과의 artifacts도 함께 받는다([`stage-input.mjs`](../../.harness/src/workflow/stage-input.mjs)). 수정 코드는 담당 stage로만 돌아간다: `SPEC_REVISION_REQUIRED`→`spec-me`, `PLAN_REVISION_REQUIRED`→`to-ticket`, `IMPLEMENTATION_REVISION_REQUIRED`→`implement-wrapper`.

### `spec-me` 세부

기본 흐름에서 `spec-me`는 stage 하나다. Product 인터뷰, System Targets·Architecture 결정, Architecture Spec, 독립 리뷰, 다이어그램을 같은 대화에서 이어서 처리하고, writer·`diagram_creator`·`spec_adversarial_reviewer` 같은 하위 agent는 그 안에서 직접 띄운다. stage 입력에 `context.role`이 없어서 agent 프로필은 붙지 않는다.

| 들어가는 것 | 크기 |
|---|---|
| [`spec-me` GUIDE](../../.codex/internal-skills/spec-me/GUIDE.md) | 8.2KB |
| [`product-spec` GUIDE](../../.codex/internal-skills/product-spec/GUIDE.md) + [`topics.md`](../../.codex/internal-skills/product-spec/references/topics.md) | 8.5KB. 이 plan set의 `product-spec.md`가 생기기 전까지만 넣는다 ([`phaseInstructionPaths`](../../.harness/src/workflow/execution-context.mjs)) |
| 그 뒤 단계별로 모델이 직접 읽는 문서 | [template](../../.codex/internal-skills/product-spec/references/template.md), [architecture-decision](../../.codex/internal-skills/spec-me/references/architecture-decision.md), [architecture-spec GUIDE](../../.codex/internal-skills/architecture-spec/GUIDE.md), [adversarial-spec-review](../../.codex/internal-skills/spec-me/references/adversarial-spec-review.md), [spec-review GUIDE](../../.codex/internal-skills/spec-review/GUIDE.md) |

[`spec-me.yaml`](../../.codex/workflows/spec-me.yaml)의 stage 목록(product, define-system-targets, architecture 등)은 이 내부 단계별 역할과 model tier를 정하는 데 쓰인다. 기본 흐름에서 runner가 이 stage들을 따로 실행하지는 않는다.

## 3. Stage 밖이나 stage 안에서 띄우는 하위 agent

runner를 거치지 않으므로 1번 표의 3~9가 없다. Codex `multi_agent`나 Claude `Agent` 도구가 프로필(`developer_instructions`)을 agent 정의로 쓰고, 띄운 쪽이 작업 내용을 넘긴다. GUIDE는 프로필에 적힌 경로를 보고 agent가 직접 읽는다.

| agent | 띄우는 곳 | 읽는 GUIDE |
|---|---|---|
| [`spec_adversarial_reviewer`](../../.codex/agents/spec_adversarial_reviewer.toml) | `spec-me` stage ([adversarial-spec-review](../../.codex/internal-skills/spec-me/references/adversarial-spec-review.md)) | [`spec-review`](../../.codex/internal-skills/spec-review/GUIDE.md) |
| [`diagram_creator`](../../.codex/agents/diagram_creator.toml) | `spec-me` stage, `sync-contracts` | [`plantuml-diagrams`](../../.codex/internal-skills/plantuml-diagrams/GUIDE.md) |
| [`code_researcher`](../../.codex/agents/code_researcher.toml), [`architecture_review_lead`](../../.codex/agents/architecture_review_lead.toml), [`spec_document_writer`](../../.codex/agents/spec_document_writer.toml) | `spec-me` stage의 내부 작업 | 각 프로필이 가리키는 GUIDE |
| [`plan_reviewer`](../../.codex/agents/plan_reviewer.toml) | `to-ticket` stage ([review-routing](../../.codex/internal-skills/to-ticket/references/review-routing.md)) | [`plan-review`](../../.codex/internal-skills/plan-review/GUIDE.md) |
| [`contract_reviewer`](../../.codex/agents/contract_reviewer.toml) | `sync-contracts` stage, seal 뒤 ([sync-contracts](../../.codex/internal-skills/sync-contracts/GUIDE.md)) | [`contract-review`](../../.codex/internal-skills/contract-review/GUIDE.md) |
| [`standards_reviewer`](../../.codex/agents/standards_reviewer.toml), [`spec_reviewer`](../../.codex/agents/spec_reviewer.toml) | 메인 orchestrator, plan마다와 통합 리뷰 ([repair.md](../../.codex/internal-skills/code-review/references/repair.md)) | [`code-review`](../../.codex/internal-skills/code-review/GUIDE.md) 8.6KB |
| [`e2e_test_runner`](../../.codex/agents/e2e_test_runner.toml) | 메인 orchestrator가 최종 E2E 승인 뒤 fresh로 새로 띄움 ([implementation.md](../../.codex/skills/orchestrator/references/implementation.md)) | [`e2e-test`](../../.codex/internal-skills/e2e-test/GUIDE.md) |
| [`execution_runner`](../../.codex/agents/execution_runner.toml) | `implement-wrapper` stage의 runtime 검증 | 프로필이 규칙을 가짐 |

하위 agent의 시작·종료는 provider와 관계없이 같은 subagent hook([`harness-agent-event.mjs`](../../.codex/scripts/harness-agent-event.mjs))이 그 stage execution의 `subagents.jsonl`에 기록한다. reviewer는 이 hook이 리뷰 회차에 묶은 신원으로만 기록되고, 회차 밖이나 fork로 띄운 reviewer는 `admitted: false`로 남는다. Claude Code는 runner가 `--settings`로 hook을 넣고, Codex는 setup이 사용자 전역 `~/.codex/hooks.json`에 한 번 등록하며 사용자가 `/hooks`에서 한 번 신뢰해야 stage가 시작된다.

`frontend-design`과 `knowledge-harvest`는 메인 세션이 [기능 라우팅](../../.codex/skills/orchestrator/references/capability-routing.md)으로 GUIDE를 직접 읽고 진행하며, [`frontend-design.yaml`](../../.codex/workflows/frontend-design.yaml)·[`knowledge-harvest-workflow.yaml`](../../.codex/workflows/knowledge-harvest-workflow.yaml)의 역할을 위와 같이 하위 agent로 띄운다.

## 3-1. Workflow manifest가 실제로 쓰이는 곳

- 기본 흐름 stage의 프로필·sandbox 매칭(위 2번)과 `--workflow`/`--stage`를 넘긴 실행의 model tier.
- 완료 gate: `harness-workflow-complete.mjs`가 manifest의 `before_complete` 목록을 실행한다([`completion.mjs`](../../.harness/src/workflow/completion.mjs)).
- `before_dispatch`·`before_handoff` 목록은 선언만 있고 기본 흐름에서 실행되지 않는다. dispatch 전 확인은 각 GUIDE가 `harness-workspace-preflight.mjs`와 `harness-plan-review.mjs check`로 직접 한다.

## 4. 규칙을 어디에 쓰는가

- 규칙은 해당 skill의 GUIDE에만 쓴다. 프로필에는 역할 선언, GUIDE 경로, 하위 agent의 결과 형식처럼 GUIDE를 읽기 전에 필요한 것만 둔다.
- 여러 skill을 오가는 `spec_document_writer`와 소유 GUIDE가 없는 `execution_runner`만 역할 규칙을 프로필에 둔다.
- 이 기준은 [`tests/prompt_budget.test.mjs`](../../tests/prompt_budget.test.mjs)가 검사한다. 모든 프로필은 존재하는 GUIDE를 가리켜야 하고 `developer_instructions`는 1KB(위 두 역할은 2KB) 이하여야 한다.
