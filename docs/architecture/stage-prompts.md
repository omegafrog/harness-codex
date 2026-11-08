# Stage 입력 프롬프트 구성

workflow stage 하나가 실행될 때 모델이 받는 입력을 정리한다. 실제 조립은 [`harness-agent-run.mjs`](../../.codex/scripts/harness-agent-run.mjs)와 [`buildStagePrompt`](../../.harness/src/workflow/execution-context.mjs)가 한다. 크기는 이 문서를 쓴 시점의 source 기준이다.

## 1. 모든 stage에 공통으로 들어가는 것

| 순서 | 내용 | 정본 파일 | 전달 방식 |
|---|---|---|---|
| 1 | Worker 기본 규칙 (0.8KB) | [`worker-base.md`](../../.codex/internal-skills/skill-execution/worker-base.md) | Codex: `model_instructions_file` ([codex.mjs](../../.harness/src/workflow/providers/codex.mjs) `stageConfigArgs`). Claude: `--system-prompt`에 고정 문구 한 단락을 덧붙여 전달 ([claude-code.mjs](../../.harness/src/workflow/providers/claude-code.mjs) `buildCommand`) |
| 2 | 프로젝트 지침 | consumer의 `AGENTS.md`(Codex), `CLAUDE.md`(Claude Code) | provider 기본 동작으로 읽힌다. Harness는 이를 끄거나 따로 넣지 않는다 |
| 3 | 실행 위치 안내 | — | prompt 첫 문장: workspace 경로, `input.json` 경로, runtime 디렉터리, plan set의 Spec·plan 디렉터리 |
| 4 | Stage GUIDE 전문 | `.codex/internal-skills/<skill>/GUIDE.md` | prompt에 `Current stage guide (...)`로 붙임 |
| 5 | Agent 프로필 전문 | `.codex/agents/<role>.toml` (Claude는 변환된 `.claude/agents/<role>.md`) | prompt에 `Current agent profile (...)`로 붙임. 역할 선언과 GUIDE 경로만 담는다 |
| 6 | 반환 계약 (2.6KB) | [`stage-return.md`](../../.codex/internal-skills/skill-execution/references/stage-return.md) | prompt에 `Current phase instructions (...)`로 항상 붙임 |
| 7 | 단계별 추가 지침 | `spec-me`: [`product-spec/GUIDE.md`](../../.codex/internal-skills/product-spec/GUIDE.md) + [`topics.md`](../../.codex/internal-skills/product-spec/references/topics.md). `product-spec`: `topics.md` | 6과 같은 방식. 다른 skill은 없음 |
| 8 | 상황별 문장 | — | 사용자 답변(`answers.json`)·feedback 경로, 현재 phase, compaction 복구 안내, read-only 실행 안내, 마지막 지시문 |
| 9 | 결과 schema | [`return.schema.json`](../../.codex/internal-skills/skill-execution/schemas/return.schema.json) + `flows/common`·`spec-review`·`plan-review` 중 하나 | Codex `--output-schema`, Claude `--json-schema`. 조립: [`output-schema.mjs`](../../.harness/src/workflow/output-schema.mjs) |

모델이 직접 읽는 파일:

- `input.json`: [`stage-input.mjs`](../../.harness/src/workflow/stage-input.mjs)가 만들고 [`input.schema.json`](../../.codex/internal-skills/skill-execution/schemas/input.schema.json) 형식을 따른다. `input_refs`(승인 Spec·plan·이전 결과)와 `context`(`worktree_ref`, `plan_set_id`, `execution_workspace`, `publication_drafts` 등)를 담는다.
- GUIDE가 링크한 reference 문서: prompt에는 넣지 않으며 필요할 때 모델이 읽는다.

이어서 실행(resume)할 때는 바뀌지 않은 GUIDE·프로필·추가 지침을 다시 넣지 않는다. provider가 context compaction을 기록했으면 다시 넣는다.

역할별 도구 제한도 같이 적용된다. Codex는 `stageConfigArgs`가 web search·이미지·MCP 서버를 역할별로 켜고 끈다. Claude는 `allowedToolsForRole`이 도구 목록을 정한다.

## 2. Workflow별 stage 입력

크기: GUIDE / 프로필 / 추가 지침(7번). 모든 stage에 worker-base 0.8KB와 stage-return 2.6KB가 더해진다.

### `implement-wrapper` ([manifest](../../.codex/workflows/implement-wrapper.yaml))

| stage | role · 프로필 | GUIDE | sandbox | tier | 크기 |
|---|---|---|---|---|---|
| implementation | [`implementation_agent`](../../.codex/agents/implementation_agent.toml) | [`implement`](../../.codex/internal-skills/implement/GUIDE.md) | workspace-write | implementation | 14.5 / 0.5 / 0 KB |
| standards | [`standards_reviewer`](../../.codex/agents/standards_reviewer.toml) | [`code-review`](../../.codex/internal-skills/code-review/GUIDE.md) | read-only | implementation | 17.5 / 0.7 / 0 KB |
| spec | [`spec_reviewer`](../../.codex/agents/spec_reviewer.toml) | [`code-review`](../../.codex/internal-skills/code-review/GUIDE.md) | read-only | implementation | 17.5 / 1.1 / 0 KB |

### `code-review` ([manifest](../../.codex/workflows/code-review.yaml))

| stage | role · 프로필 | GUIDE | sandbox | tier | 크기 |
|---|---|---|---|---|---|
| standards | [`standards_reviewer`](../../.codex/agents/standards_reviewer.toml) | [`code-review`](../../.codex/internal-skills/code-review/GUIDE.md) | read-only | implementation | 17.5 / 0.7 / 0 KB |
| spec | [`spec_reviewer`](../../.codex/agents/spec_reviewer.toml) | [`code-review`](../../.codex/internal-skills/code-review/GUIDE.md) | read-only | implementation | 17.5 / 1.1 / 0 KB |

### `spec-me` ([manifest](../../.codex/workflows/spec-me.yaml))

| stage | role · 프로필 | GUIDE | sandbox | tier | 크기 |
|---|---|---|---|---|---|
| product | [`spec_document_writer`](../../.codex/agents/spec_document_writer.toml) | [`product-spec`](../../.codex/internal-skills/product-spec/GUIDE.md) | workspace-write | low | 6.6 / 1.9 / 2.6 KB |
| define-system-targets | [`spec_document_writer`](../../.codex/agents/spec_document_writer.toml) | [`spec-me`](../../.codex/internal-skills/spec-me/GUIDE.md) | workspace-write | implementation | 11.0 / 1.9 / 9.2 KB |
| domain-baseline | [`code_researcher`](../../.codex/agents/code_researcher.toml) | [`code-research`](../../.codex/internal-skills/code-research/GUIDE.md) | read-only | low | 4.1 / 0.5 / 0 KB |
| architecture | [`spec_document_writer`](../../.codex/agents/spec_document_writer.toml) | [`architecture-spec`](../../.codex/internal-skills/architecture-spec/GUIDE.md) | workspace-write | low | 10.7 / 1.9 / 0 KB |
| review-architecture-decisions (Learning mode) | [`architecture_review_lead`](../../.codex/agents/architecture_review_lead.toml) | [`architecture-review`](../../.codex/internal-skills/architecture-review/GUIDE.md) | read-only | high_performance | 3.2 / 0.5 / 0 KB |
| verify-architecture-decisions | [`spec_document_writer`](../../.codex/agents/spec_document_writer.toml) | [`spec-me`](../../.codex/internal-skills/spec-me/GUIDE.md) | workspace-write | low | 11.0 / 1.9 / 9.2 KB |
| architecture-review | [`spec_adversarial_reviewer`](../../.codex/agents/spec_adversarial_reviewer.toml) | [`spec-review`](../../.codex/internal-skills/spec-review/GUIDE.md) | read-only | high_performance | 5.1 / 0.7 / 0 KB |
| product_diagram · architecture_diagram | [`diagram_creator`](../../.codex/agents/diagram_creator.toml) | [`plantuml-diagrams`](../../.codex/internal-skills/plantuml-diagrams/GUIDE.md) | workspace-write | low | 6.1 / 0.5 / 0 KB |

### `to-ticket` ([manifest](../../.codex/workflows/to-ticket.yaml))

| stage | role · 프로필 | GUIDE | sandbox | tier | 크기 |
|---|---|---|---|---|---|
| to-ticket | [`to_ticket`](../../.codex/agents/to_ticket.toml) | [`to-ticket`](../../.codex/internal-skills/to-ticket/GUIDE.md) | workspace-write | bindings 기본값 | 4.3 / 0.5 / 0 KB |
| tracker-publish | [`tracker_publisher`](../../.codex/agents/tracker_publisher.toml) | [`tracker-publish`](../../.codex/internal-skills/tracker-publish/GUIDE.md) | danger-full-access | bindings 기본값 | 2.7 / 0.5 / 0 KB |

### `frontend-design` ([manifest](../../.codex/workflows/frontend-design.yaml))

| stage | role · 프로필 | GUIDE | sandbox | tier | 크기 |
|---|---|---|---|---|---|
| design | [`frontend_designer`](../../.codex/agents/frontend_designer.toml) | [`frontend-design`](../../.codex/internal-skills/frontend-design/GUIDE.md) | read-only | high_performance | 16.5 / 0.6 / 0 KB |
| implementation | [`frontend_implementation_agent`](../../.codex/agents/frontend_implementation_agent.toml) | [`frontend-implement`](../../.codex/internal-skills/frontend-implement/GUIDE.md) | workspace-write | implementation | 5.5 / 0.5 / 0 KB |
| visual_review | [`frontend_visual_reviewer`](../../.codex/agents/frontend_visual_reviewer.toml) | [`frontend-visual-review`](../../.codex/internal-skills/frontend-visual-review/GUIDE.md) | workspace-write | high_performance | 7.2 / 0.5 / 0 KB |

### `knowledge-harvest-workflow` ([manifest](../../.codex/workflows/knowledge-harvest-workflow.yaml))

10개 stage 모두 [`knowledge-harvest`](../../.codex/internal-skills/knowledge-harvest/GUIDE.md) GUIDE(6.2KB)를 받고, 프로필만 다르다(각 0.5~0.6KB).

| stage | role · 프로필 | tier |
|---|---|---|
| discover · qualify · collect | [`knowledge_source_researcher`](../../.codex/agents/knowledge_source_researcher.toml) | low |
| extract | [`knowledge_claim_extractor`](../../.codex/agents/knowledge_claim_extractor.toml) | low |
| corroboration · countersearch · review | [`knowledge_principle_reviewer`](../../.codex/agents/knowledge_principle_reviewer.toml) | high_performance |
| synthesis · publish | [`knowledge_principle_synthesizer`](../../.codex/agents/knowledge_principle_synthesizer.toml) | implementation |
| humanapprove | [`human_approver`](../../.codex/agents/human_approver.toml) | implementation |

## 3. Stage 안에서 띄우는 하위 agent

runner를 거치지 않으므로 1번 표의 3~9가 없다. Codex `multi_agent`나 Claude `Agent` 도구가 프로필(`developer_instructions`)을 agent 정의로 쓰고, 호출한 stage가 작업 내용을 넘긴다. GUIDE는 프로필에 적힌 경로를 보고 agent가 직접 읽는다.

| agent | 띄우는 곳 | 읽는 GUIDE | 프로필에만 있는 것 |
|---|---|---|---|
| [`plan_reviewer`](../../.codex/agents/plan_reviewer.toml) | `to-ticket` stage ([review-routing](../../.codex/internal-skills/to-ticket/references/review-routing.md)) | [`plan-review`](../../.codex/internal-skills/plan-review/GUIDE.md) | 결과 JSON 형식 |
| [`spec_adversarial_reviewer`](../../.codex/agents/spec_adversarial_reviewer.toml) | `spec-me` stage ([spec-me](../../.codex/internal-skills/spec-me/GUIDE.md)) | [`spec-review`](../../.codex/internal-skills/spec-review/GUIDE.md) | 결과 JSON 형식 |
| [`execution_runner`](../../.codex/agents/execution_runner.toml) | `implement` stage의 runtime 검증 | [`implement`](../../.codex/internal-skills/implement/GUIDE.md)의 runtime 검증 경계만 | 실행·보고 규칙 전체 (소유 GUIDE가 없음) |
| [`e2e_test_runner`](../../.codex/agents/e2e_test_runner.toml) | 최종 E2E, `maintain-verification` | [`e2e-test`](../../.codex/internal-skills/e2e-test/GUIDE.md) | 없음 |
| [`diagram_creator`](../../.codex/agents/diagram_creator.toml) | `sync-contracts` | [`plantuml-diagrams`](../../.codex/internal-skills/plantuml-diagrams/GUIDE.md) | 없음 |

## 4. 규칙을 어디에 쓰는가

- 규칙은 해당 skill의 GUIDE에만 쓴다. 프로필에는 역할 선언, GUIDE 경로, 하위 agent의 결과 형식처럼 GUIDE를 읽기 전에 필요한 것만 둔다.
- 여러 skill을 오가는 `spec_document_writer`와 소유 GUIDE가 없는 `execution_runner`만 역할 규칙을 프로필에 둔다.
- 이 기준은 [`tests/prompt_budget.test.mjs`](../../tests/prompt_budget.test.mjs)가 검사한다. 모든 프로필은 존재하는 GUIDE를 가리켜야 하고 `developer_instructions`는 1KB(위 두 역할은 2KB) 이하여야 한다.
