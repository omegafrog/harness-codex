---
name: orchestrator
description: Coordinate a Harness workflow only when the current user request starts with $orchestrator or /orchestrator. Do not invoke for unrelated requests or Harness installation and updates.
main_session: true
---

# orchestrator

사용자가 Codex의 `$orchestrator` 또는 Claude Code의 `/orchestrator`로 호출하면 메인 세션에서 workflow를 조율한다. 자유 텍스트 답변·발행 승인·재개에도 같은 호출어를 붙이며, 실행기에는 호출어 뒤의 원문을 넘긴다. 사용자가 일시정지·중단을 요청했으면 재개하지 않는다.

## 현재 요청에 맞는 경로

신규 요청이나 재개 시 현재 디렉터리에서 `node .harness/scripts/harness-context.mjs --entry`를 실행한다. 맞는 `next`가 반환되면 우선한다. 구성·재개에 필요한 세션이 `session_verified: false`이면 대화를 확인할 수 없다고 알리고 멈춘다. 같은 실행에서 새 답이나 결과를 받으면 기존 실행의 반환으로 이어간다.

사용자가 활성 workflow의 특정 단계를 다시 열거나 수정하라고 하면 [workflow-rewind](../workflow-rewind/SKILL.md)를 따른다. 사용자 revision과 dependency block 재개(`--reopen-for`), requirements rollback(`--restart-requirements`)을 구분하고, runner가 지원하지 않는 단계를 임의 재실행하지 않는다.

Harness 설치·업데이트·진단은 현재 checkout의 [Harness Maintenance](../../../.harness/internal-skills/harness-maintenance/GUIDE.md)를 따르며 workflow를 만들지 않는다. 새 workflow는 진입 명령이 안내한 `setup` 또는 [workflow-compose](../../../.harness/internal-skills/workflow-compose/GUIDE.md)로 시작한다. 제품 경로 검증·독립 E2E·legacy 구현 같은 직접 요청일 때만 `references/capability-routing.md`를 연다.

primary checkout에서 등록된 linked worktree가 있으면 먼저 기존 worktree에서 계속할지 새 workflow를 시작할지 묻는다. 기존을 선택하면 `linked_worktrees`의 절대 경로·branch·요청·상태를 보여 주고, 고른 경로로 이동해 orchestrator를 다시 호출하도록 안내한 뒤 멈춘다. 새 workflow를 선택하면 `primary_workspace_root`에서 compose를 실행한다. 문구 일치를 요구하지 말고 답의 뜻으로 선택을 판단한다.

이미 linked worktree 안에서 현재 workflow를 계속하라는 요청은 그 위치에서 이어간다. 새롭거나 별개의 workflow를 요청하면 `primary_workspace_root`를 사용해 primary checkout에서 새 worktree를 만든다. 새 workflow를 현재 linked worktree에 임의로 붙이지 않는다. 새 worktree를 만들었으면 결과를 검증한 뒤 절대 경로를 안내하고 멈춘다.

## 실행과 확인

정상 경로는 이 문서만으로 진행한다. reference와 result 파일은 열지 않고, stage의 GUIDE·schema·산출물 본문을 읽지 않고 반환된 `status`·`code`·요약·artifact 경로·질문·`next`로 조율한다. 명령 오류의 `next`가 특정 파일을 지목할 때만 그 파일을 연다. 사용자 문서의 문구를 찾으려고 파일을 grep·read하지 않는다.

1. Claude Code는 stage마다 `Agent` 한 번만 호출한다(`subagent_type: "workflow_stage"`). 사용자 답·수정도 같은 호출이다. 긴 원문은 아래 줄에 쓰고 옵션 값에 `@body`를 둔다.
   - stage 실행: `harness-stage: <stage> [launch 옵션]`(`--plan`·`--feedback` 등)
   - 질문·승인에 대한 사용자 답: 뜻은 orchestrator가 판단한다. 승인하려는 뜻일 때만 `harness-stage: approve`, 열린 질문 전부 추천안이면 `recommended`, 그 밖의 질문 답은 `answer` + 다음 줄에 선택 JSON(`[{"question_id":"…","option_id":"…"}]`, 자유 답은 `option_id` 대신·함께 `text`) + 그 아래 줄에 원문
   - 완료된 결과에 대한 사용자 수정 요청: `harness-stage: revise <소유 stage-id>` + 아래 줄에 원문. 소유 stage가 없거나 맞지 않으면 실행기가 수정 가능한 stage 목록을 돌려준다. 사용자가 고칠 문구를 파일에서 찾아 옵션으로 만들지 않는다.

   hook이 launch·bind·결과 기록을 하고 작업자가 `format_error`·`gate_error`를 같은 turn에서 고친 뒤 Agent는 compact envelope를 돌려준다. launch·bind·finish는 직접 실행하지 않고 envelope의 `next`를 따른다. hook 거부는 시작된 것이 없으며 사유의 `next`·되묻는 요청을 따른다.
2. (Codex 전용) `node .harness/scripts/harness-native-stage.mjs launch --stage-id <stage>`에 필요한 준비 옵션만 전달한다. 모델·effort 지정은 `--stage-binding`을 먼저 적용한다. 새 `execution_id`마다 `next.spawn`대로 fresh native 서브에이전트를 시작한다. `launch`가 `assignment_path`를 반환하면 그 경로 하나와 `receive_command`만 전달하고(없을 때만 `guide`·`input_path`·`schema_path`와 제공된 답변·피드백 경로), `next.bind`를 실행한다. 실제 에이전트 결과를 기다리고 `next.finish`로 검증한다. `format_error`나 `gate_error`는 같은 작업자에게 돌려준다(`gate_error`는 `retry_input`·`feedback_path` 포함). 불명확한 실행을 중복 시작하지 않는다.
3. `owner_stage`가 앞 단계면 오류·envelope의 `next`(`--reopen-for`)를 따른다. 오류의 `why`·`next`·`user_decision`을 사용하고 Harness 소스·state 파일은 읽지 않는다. 제품 코드·테스트·Spec·계획·계약의 편집과 Git 작업은 소유 stage와 실행기에 맡긴다.

## 사용자 결정과 완료

- 반환된 `questions`(제목·맥락·선택지별 label·effect·example, 추천 표시와 `reason`)를 파일 없이 한국어로 보여 주고 기다린다. 확인 질문은 대화로 답한다. 답의 뜻은 orchestrator만 판단하고 선언(선택 JSON·`recommended`·`approve`·`revise <stage-id>`)과 원문을 넘긴다(Claude Code: `harness-stage: …`, Codex: `harness-native-stage.mjs answer --text '<원문>' [--choices '<JSON>' | --intent recommended|approve]`). 무엇으로 처리했는지 사용자에게 알리고, 확실하지 않으면 묻는다. 고정 문구를 요구하지 않는다. 실행기는 문구를 해석하지 않고 gate·열린 질문의 존재, 선택지·stage id, 승인의 실제 사용자 발화만 확인한다.
- `completed/OK`인 모든 stage가 끝나면 반환된 `result.summary`와 모든 artifact 경로를 한국어로 보여 주고 해당 stage 산출물의 최종 승인을 묻는다. 사용자가 승인할 때까지 다음 stage, 다음 ticket, 완료 gate를 실행하지 않는다. 답의 표현이 어떻든 뜻이 승인이면 `approve`(`--intent approve`)로 원문을 넘긴다. 승인 처리 결과의 다음 단계만 실행한다. 요구사항·전술 설계·계획 발행의 기존 특수 승인 gate도 그대로 따른다. 특히 requirements 승인 전에는 전술 설계를, 전체 계획 승인 전에는 tracker 발행을 시작하지 않는다. 승인이 아닌 수정 요청은 소유 stage를 골라 `revise`로 넘긴다(Codex: `launch --stage-id <stage> --user-revision true --feedback '<원문>'`). E2E 실패 뒤에는 자동으로 재실행하지 않는다.
- 요청 범위에 남은 단계만 순서대로 진행한다. 마지막 단계의 `next`가 안내하는 완료 gate를 통과하면 전체 완료를, 일시정지나 사용자 대기가 남았으면 그 상태를 보고한다.
