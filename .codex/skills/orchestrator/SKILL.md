---
name: orchestrator
description: Coordinate a Harness workflow only when the current user request starts with $orchestrator or /orchestrator. Do not invoke for unrelated requests or Harness installation and updates.
main_session: true
---

# orchestrator

사용자가 Codex의 `$orchestrator` 또는 Claude Code의 `/orchestrator`로 호출하면 메인 세션에서 workflow를 조율한다. 자유 텍스트 답변·발행 승인·재개에도 같은 호출어를 붙이며, 실행기에는 호출어 뒤의 원문을 넘긴다. 사용자가 일시정지·중단을 요청했으면 재개하지 않는다.

## 현재 요청에 맞는 경로

신규 요청이나 재개 시 현재 디렉터리에서 `node .harness/scripts/harness-context.mjs --entry`를 실행한다. Harness 유지보수와 아래의 독립 기능 요청은 해당 경로로 진행한다. 맞는 `next`가 반환되면 우선한다. 구성·재개에 필요한 세션이 `session_verified: false`이면 대화를 확인할 수 없다고 알리고 멈춘다. 같은 실행에서 새 답이나 결과를 받으면 기존 실행의 반환으로 이어간다.

| 상황 | 필요한 절차 |
|---|---|
| Harness 설치·업데이트·진단 | 현재 checkout의 [Harness Maintenance](../../../.harness/internal-skills/harness-maintenance/GUIDE.md). workflow를 만들지 않는다. |
| setup이 필요한 저장소 | 진입 명령이 안내한 `setup` |
| 새 workflow 시작 | [workflow-compose](../../../.harness/internal-skills/workflow-compose/GUIDE.md) |
| 다음 단계를 정할 정보가 부족함 | [workflow 지도](references/workflow-map.md)의 해당 절 |
| 실행 배정·결과 확인·중단된 실행 복구 | [실행과 결과](references/dispatch.md)의 해당 절 |
| 일부 수정 또는 명시적 롤백 | [실행 입력](references/input.md)의 해당 절 |
| legacy 구현·리뷰·최종 E2E·계약 동기화 | [구현 workflow 조율](references/implementation.md)의 해당 절 |
| 제품 경로 검증, 독립 E2E 등 직접 요청 | [기능 라우팅](references/capability-routing.md) |

workflow 명령은 현재 working directory가 소유 worktree일 때만 실행한다. primary checkout에서는 기존 후보의 절대 경로만 안내하고, 여러 후보가 있거나 원래 요청을 확인할 수 없으면 후보 경로를 제시하고 사용할 worktree를 선택하게 한다. 사용자가 그 디렉터리로 이동한 뒤 orchestrator를 다시 호출하도록 한다. 새 worktree를 만들었으면 결과를 검증한 뒤 경로를 안내하고 멈춘다. 현재 linked worktree에 새 workflow를 연결한 경우에는 같은 위치에서 계속한다.

## 실행과 확인

정상 경로에서는 reference(`dispatch.md`·`input.md`·`workflow-map.md` 등)와 result 파일을 열지 않고, stage의 GUIDE·schema·산출물 본문을 읽지 않고 반환된 `status`·`code`·요약·artifact 경로·질문·`next`로 조율한다. 명령 오류의 `next`가 지목할 때만 해당 절을 연다.

1. Claude Code는 stage마다 `Agent` 한 번만 호출한다: `subagent_type: "workflow_stage"`, `prompt` 첫 줄 `harness-stage: <stage> [launch 옵션]`(`--plan`·`--feedback` 등, 긴 원문은 아래 줄에 쓰고 값에 `@body`). hook이 launch·bind·결과 기록을 하고 작업자가 `format_error`·`gate_error`를 같은 turn에서 고친 뒤 Agent는 compact envelope를 돌려준다. launch·bind·finish는 직접 실행하지 않고 envelope의 `next`를 따른다. hook 거부는 시작된 것이 없으며 사유의 `next`를 따른다.
2. Codex는 `node .harness/scripts/harness-native-stage.mjs launch --stage-id <stage>`에 필요한 준비 옵션만 전달한다. 모델·effort 지정은 `--stage-binding`([실행 배정](references/dispatch.md#실행-배정))을 먼저 적용한다. 새 `execution_id`마다 `next.spawn`대로 fresh native 서브에이전트를 시작한다. `guide`·`input_path`·`schema_path`와 제공된 답변·피드백 경로를 전달하고 `next.bind`를 실행한다. 실제 에이전트 결과를 기다리고 `next.finish`로 검증한다. `format_error`나 `gate_error`는 같은 작업자에게 돌려준다(`gate_error`는 `retry_input`·`feedback_path` 포함). 불명확한 실행을 중복 시작하지 않는다.
3. `owner_stage`가 앞 단계면 [상위 stage 되돌아가기](references/dispatch.md#상위-stage-되돌아가기)를 따른다. 오류의 `why`·`next`·`user_decision`을 사용하고 Harness 소스·state 파일은 읽지 않는다. 제품 코드·테스트·Spec·계획·계약의 편집과 Git 작업은 소유 stage와 실행기에 맡긴다.

## 사용자 결정과 완료

- 반환된 `questions`(제목·맥락·선택지별 label·effect·추천 표시)를 파일 없이 한국어로 보여 주고 기다린다. 확인 질문은 대화로 답한다. 답은 해석하지 않고 원문 그대로 넘긴다([입력 절차](references/input.md#사용자-답변으로-재개); Claude Code: `harness-stage: answer` 아래 줄에 원문, Codex: `harness-native-stage.mjs answer --text '<원문>'`). "추천대로"·번호별 선택은 실행기가 질문에 맞추고 모호하면 되묻는 요청을 반환한다.
- 전술 설계 전에 [확정 요구사항 승인](references/workflow-map.md#요구사항과-승인)을, 발행 전에 [검토된 전체 계획의 발행 승인](references/coordination.md#계획-발행-승인)을 받는다. 승인 요약은 `result.summary`와 문서 경로로 보여 주고 문서는 열지 않으며, 승인 답도 같은 `answer`로 원문을 넘긴다. 실제 사용자 답과 독립 리뷰를 사용한다. E2E는 해당 [실행·실패 절차](references/implementation.md#최종-e2e-승인과-실패-처리)를 적용하고 실패 뒤 자동으로 재실행하지 않는다.
- 요청 범위에 남은 단계만 순서대로 진행한다. 마지막 단계 뒤 [완료 gate](references/dispatch.md#workflow-완료)를 통과하면 전체 완료를, 일시정지나 사용자 대기가 남았으면 그 상태를 보고한다.
