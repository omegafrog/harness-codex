---
name: orchestrator
description: Coordinate a Harness workflow only when the current user request starts with $orchestrator or /orchestrator. Do not invoke for unrelated requests or Harness installation and updates.
main_session: true
---

# orchestrator

사용자가 Codex의 `$orchestrator` 또는 Claude Code의 `/orchestrator`로 호출하면 메인 세션에서 workflow를 조율한다. 자유 텍스트 답변·발행 승인·재개에도 같은 호출어를 붙이며, 실행기에는 호출어 뒤의 원문을 넘긴다. 사용자가 일시정지·중단을 요청했으면 재개하지 않는다.

## 현재 요청에 맞는 경로

신규 요청이나 재개 시 현재 디렉터리에서 `node .harness/scripts/harness-context.mjs --entry`를 실행한다. 맞는 `next`가 반환되면 우선한다. 구성·재개에 필요한 세션이 `session_verified: false`이면 대화를 확인할 수 없다고 알리고 멈춘다. 같은 실행에서 새 답이나 결과를 받으면 기존 실행의 반환으로 이어간다.

Harness 설치·업데이트·진단은 현재 checkout의 [Harness Maintenance](../../../.harness/internal-skills/harness-maintenance/GUIDE.md)를 따르며 workflow를 만들지 않는다. 새 workflow는 진입 명령이 안내한 `setup` 또는 [workflow-compose](../../../.harness/internal-skills/workflow-compose/GUIDE.md)로 시작한다. 제품 경로 검증·독립 E2E·legacy 구현 같은 직접 요청일 때만 `references/capability-routing.md`를 연다.

workflow 명령은 현재 working directory가 소유 worktree일 때만 실행한다. primary checkout에서는 기존 후보의 절대 경로만 안내하고, 여러 후보가 있거나 원래 요청을 확인할 수 없으면 후보 경로를 제시하고 사용할 worktree를 선택하게 한다. 사용자가 그 디렉터리로 이동한 뒤 orchestrator를 다시 호출하도록 한다. 새 worktree를 만들었으면 결과를 검증한 뒤 경로를 안내하고 멈춘다. 현재 linked worktree에 새 workflow를 연결한 경우에는 같은 위치에서 계속한다.

## 실행과 확인

정상 경로는 이 문서만으로 진행한다. reference와 result 파일은 열지 않고, stage의 GUIDE·schema·산출물 본문을 읽지 않고 반환된 `status`·`code`·요약·artifact 경로·질문·`next`로 조율한다. 명령 오류의 `next`가 특정 파일을 지목할 때만 그 파일을 연다. 사용자 문서의 문구를 찾으려고 파일을 grep·read하지 않는다.

1. Claude Code는 stage마다 `Agent` 한 번만 호출한다(`subagent_type: "workflow_stage"`). 사용자 답·수정도 같은 호출이다. 긴 원문은 아래 줄에 쓰고 옵션 값에 `@body`를 둔다.
   - stage 실행: `harness-stage: <stage> [launch 옵션]`(`--plan`·`--feedback` 등)
   - 질문·승인에 대한 사용자 답: `harness-stage: answer` + 아래 줄에 원문
   - 완료된 결과에 대한 사용자 수정 요청: `harness-stage: revise` + 아래 줄에 원문. 소유 stage는 실행기가 고르며 고를 수 없으면 되묻는 요청을 반환한다. 사용자가 고칠 문구를 파일에서 찾아 옵션으로 만들지 않는다.

   hook이 launch·bind·결과 기록을 하고 작업자가 `format_error`·`gate_error`를 같은 turn에서 고친 뒤 Agent는 compact envelope를 돌려준다. launch·bind·finish는 직접 실행하지 않고 envelope의 `next`를 따른다. hook 거부는 시작된 것이 없으며 사유의 `next`·되묻는 요청을 따른다.
2. (Codex 전용) `node .harness/scripts/harness-native-stage.mjs launch --stage-id <stage>`에 필요한 준비 옵션만 전달한다. 모델·effort 지정은 `--stage-binding`을 먼저 적용한다. 새 `execution_id`마다 `next.spawn`대로 fresh native 서브에이전트를 시작한다. `guide`·`input_path`·`schema_path`와 제공된 답변·피드백 경로를 전달하고 `next.bind`를 실행한다. 실제 에이전트 결과를 기다리고 `next.finish`로 검증한다. `format_error`나 `gate_error`는 같은 작업자에게 돌려준다(`gate_error`는 `retry_input`·`feedback_path` 포함). 불명확한 실행을 중복 시작하지 않는다.
3. `owner_stage`가 앞 단계면 오류·envelope의 `next`(`--reopen-for`)를 따른다. 오류의 `why`·`next`·`user_decision`을 사용하고 Harness 소스·state 파일은 읽지 않는다. 제품 코드·테스트·Spec·계획·계약의 편집과 Git 작업은 소유 stage와 실행기에 맡긴다.

## 사용자 결정과 완료

- 반환된 `questions`(제목·맥락·선택지별 label·effect·추천 표시)를 파일 없이 한국어로 보여 주고 기다린다. 확인 질문은 대화로 답한다. 답은 해석하지 않고 원문 그대로 넘긴다(Claude Code: `harness-stage: answer`, Codex: `harness-native-stage.mjs answer --text '<원문>'`). "추천대로"·번호별 선택은 실행기가 질문에 맞추고 모호하면 되묻는 요청을 반환한다.
- 전술 설계 전에 확정 요구사항의, 발행 전에 검토된 전체 계획의 실제 사용자 승인을 받는다. 승인 요약은 `result.summary`와 문서 경로로 보여 주고 문서는 열지 않으며, 승인 답도 같은 `answer`로 원문을 넘긴다. 승인이 아닌 수정 요청은 `answer`가 소유 stage 재개로 돌리거나 되묻는다. E2E 실패 뒤에는 자동으로 재실행하지 않는다.
- 요청 범위에 남은 단계만 순서대로 진행한다. 마지막 단계의 `next`가 안내하는 완료 gate를 통과하면 전체 완료를, 일시정지나 사용자 대기가 남았으면 그 상태를 보고한다.
