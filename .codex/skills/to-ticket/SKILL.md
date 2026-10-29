---
name: to-ticket
description: Split approved product and architecture specifications into vertical implementation plans, review them independently, and publish the passing plan set.
---

내부 절차는 연결된 GUIDE를 따른다:

# to-ticket

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 해당 tier를 우선한다. [정적 호출기](../../../.codex/internal-skills/static-caller/GUIDE.md)에 따라 `harness-static-call.mjs`가 스킬의 binding과 setup 설정을 읽어 model·effort를 선택한다. `execution_id`를 받은 호출은 해당 stage 파일에 지정된 작업을 수행하고 결과 파일과 공통 envelope를 반환한다.

## Stage별 절차

orchestrated workflow는 `context.stage_id`에 따라 한 단계만 수행한다.

| `stage_id` | 수행 파일 | 완료 뒤 orchestrator 처리 |
|---|---|---|
| `plan_split` | [split](references/split.md) | 결과의 `plan_set_draft`를 `plan_review`에 전달한다. |
| `plan_revision` | [revision](references/revision.md) | 최신 `plan_review_result`를 전달하고, 완료 뒤 fresh `plan_review`를 다시 실행한다. |
| `plan_finalize` | [finalize](references/finalize.md) | 최신 pass review를 확인하고 Beads 및 configured tracker 발행을 수행한다. |

독립 reviewer stage는 [plan-review GUIDE](../../../.codex/internal-skills/plan-review/GUIDE.md)를 사용한다. [리뷰 준비와 결과 처리](references/review-routing.md)에 따라 reviewer 실행은 각 회차마다 새 context로 시작하고, 결과와 gate를 기록한다. 리뷰 한도에 도달하거나 Spec 변경이 필요하면 해당 상태와 근거를 orchestrator에 반환한다.

Standalone 호출은 `split → fresh plan-review → revision/review 반복 → finalize` 순서를 직접 수행한다. reviewer 결과가 pass인 시점에만 finalization으로 진행한다.
