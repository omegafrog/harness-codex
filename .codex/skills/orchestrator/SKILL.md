---
name: orchestrator
description: Coordinate a Harness workflow only when the current user request starts with $orchestrator or /orchestrator. Do not invoke for unrelated requests or Harness installation and updates.
main_session: true
---

# orchestrator

사용자가 Codex의 `$orchestrator` 또는 Claude Code의 `/orchestrator`로 호출하면 메인 세션에서 workflow를 조율한다. 자유 텍스트 답변·발행 승인·재개에도 같은 호출어를 붙인다. 실행기에는 호출어 뒤의 사용자 원문을 넘긴다. 사용자가 일시정지·중단을 요청했으면 재개하지 않는다.

## 현재 요청에 맞는 경로

신규 요청이나 재개 시 현재 디렉터리에서 `node .harness/scripts/harness-context.mjs --entry`를 실행한다. Harness 유지보수와 아래의 독립 기능 요청은 해당 경로로 바로 진행한다. 실행기가 반환한 `next`가 현재 요청과 맞으면 우선한다. 구성 또는 재개에 필요한 세션이 `session_verified: false`이면 현재 대화를 확인할 수 없다고 알리고 멈춘다. 아래 링크는 해당 절차가 필요할 때만 연다. 같은 실행에서 새 답이나 결과를 받으면 기존 실행의 반환으로 이어간다.

| 상황 | 필요한 절차 |
|---|---|
| Harness 설치·업데이트·진단 | 현재 checkout의 [Harness Maintenance](../../../.harness/internal-skills/harness-maintenance/GUIDE.md). workflow를 만들지 않는다. |
| setup이 필요한 저장소 | 진입 명령이 안내한 `setup` |
| 새 workflow 시작 | [workflow-compose](../../../.harness/internal-skills/workflow-compose/GUIDE.md) |
| 다음 요구사항·전술 설계·구현 단계를 정할 정보가 부족함 | [workflow 지도](references/workflow-map.md)의 해당 절 |
| 실행 배정·결과 확인·중단된 실행 복구 | [실행과 결과](references/dispatch.md)의 해당 절 |
| 사용자 답변, 일부 수정 또는 명시적 롤백 | [실행 입력](references/input.md)의 해당 절 |
| Spec 기반 legacy 구현·리뷰·최종 E2E·계약 동기화 | [구현 workflow 조율](references/implementation.md)의 해당 절 |
| 제품 경로 검증, 독립 E2E 등 직접 요청 | [기능 라우팅](references/capability-routing.md) |

workflow 명령은 현재 working directory가 소유 worktree일 때만 실행한다. primary checkout에서는 기존 후보의 절대 경로만 안내하고, 여러 후보가 있거나 원래 요청을 확인할 수 없으면 후보 경로를 제시하고 사용할 worktree를 선택하게 한다. 사용자가 그 디렉터리로 이동한 뒤 orchestrator를 다시 호출하도록 한다. 새 worktree를 만들었으면 이번 호출의 결과를 검증한 뒤 경로를 안내하고 멈춘다. 현재 linked worktree에 새 workflow를 연결한 경우에는 같은 위치에서 계속한다.

## 실행과 확인

1. 단계가 정해졌으면 `node .harness/scripts/harness-native-stage.mjs launch --stage-id <stage>`에 필요한 준비 옵션만 전달한다. 사용자가 모델·reasoning effort를 지정하면 [실행 배정](references/dispatch.md#실행-배정)의 `--stage-binding`을 먼저 적용한다. 새 `execution_id`마다 반환된 profile과 binding으로 fresh native 서브에이전트를 시작한다. `guide`·`input_path`·`schema_path`와 제공된 답변·피드백 경로를 전달하고 `next.bind`를 실행한다. 메인 세션은 stage의 GUIDE·schema·산출물 본문을 읽지 않고 결과 요약과 참조로 조율한다. 사용자 승인에 필요한 산출물은 해당 승인 절차에서 확인한다.
2. 실제 에이전트 결과를 기다리고 `next.finish`로 검증한다. 정상 결과의 `next`를 따르고, `format_error`나 `gate_error`는 같은 작업자에게 돌려준다. `gate_error`이면 결과의 `retry_input` 전체와 `feedback_path`를 수정 요청의 다음 입력에 포함하고, 작업자가 피드백 파일을 읽도록 한다. `owner_stage`가 앞 단계면 [상위 stage 되돌아가기](references/dispatch.md#상위-stage-되돌아가기)를 따른다. 상태가 불명확한 실행을 중복으로 시작하지 않는다. 진입 결과에 재개 근거가 더 필요한 경우 `harness-context.mjs`를 한 번 실행한다.
3. 오류가 반환한 `why`·`next`·`user_decision`을 사용한다. Harness 소스나 state 파일을 읽지 않고 제공된 실행기 명령으로 확인한다. 다른 worktree의 결과와 이미 처리한 실행을 건너뛴다. 제품 코드·테스트·Spec·계획·통합 계약의 편집과 Git 작업은 소유 stage와 실행기에 맡긴다.

## 사용자 결정과 완료

- 결과에 포함된 실제 질문을 맥락(`context`)과 선택지별 `effect`·`example`까지 그대로 보여 주고 답을 기다린다. 사용자의 확인 질문에는 대화에서 답하고, 확정한 선택과 조건만 [입력 절차](references/input.md#사용자-답변으로-재개)에 따라 제출한다. 일괄 답변은 그 질문 묶음에 적용한다.
- 전술 설계 전에 [확정 요구사항 승인](references/workflow-map.md#요구사항과-승인)을, 발행 전에 [검토된 전체 계획의 발행 승인](references/coordination.md#계획-발행-승인)을 받는다. 실제 사용자 답과 독립 리뷰를 사용한다. E2E는 해당 [실행·실패 절차](references/implementation.md#최종-e2e-승인과-실패-처리)를 적용하고 실패 뒤 자동으로 재실행하지 않는다.
- 요청 범위에 남은 단계만 순서대로 진행한다. 마지막 단계 뒤 [완료 gate](references/dispatch.md#workflow-완료)를 통과하면 전체 완료를 보고한다. 일시정지 중이거나 사용자 대기가 남았으면 그 상태를 보고한다.
