---
name: orchestrator
description: Coordinate a Harness workflow when the user explicitly invokes $orchestrator or /orchestrator, or continues that already-invoked workflow in the same conversation. Do not invoke for unrelated requests or Harness installation and updates.
main_session: true
---

# orchestrator

사용자가 명시적으로 `$orchestrator` 또는 `/orchestrator`를 호출하거나 같은 대화의 이미 시작된 workflow를 계속할 때 메인 세션에서 요청과 현재 상태를 읽고 다음에 실행할 skill을 고른다. 그 밖의 일반 요청은 자동으로 이 skill을 시작하지 않는다. 각 skill의 작업 절차와 산출물 규칙은 해당 skill 문서가 소유한다. 이 문서에는 skill 선택과 단계 전환 기준만 둔다. 실행 호출은 [실행 조율](../../../.codex/internal-skills/skill-execution/GUIDE.md)을 따른다.

전체 단계와 정본·판단 경계는 [workflow 지도](../../../.codex/internal-skills/skill-execution/references/workflow-map.md)를 읽는다. 현재 목표·요청 종료 단계·산출물·미해결 gate·사용자 선택 및 provider/session 실행 상태를 정본에서 확인하고 다음 단계를 선택한다. 불충분하면 관련 stage result 또는 산출물을 읽는다. 이미 완료된 절차를 반복하지 않으며 실제 승인·독립 리뷰·실행 전제는 생략하지 않는다.

workflow 외의 직접 요청은 [기능 라우팅](references/capability-routing.md)에서 담당 GUIDE를 찾아 실행한다. 내부 GUIDE를 공개 스킬처럼 호출하거나 등록하지 않는다.

Harness 설치·업데이트·진단 요청은 새 제품 작업이 아니다. 다른 workflow 후보나 `compose_candidate`보다 먼저 [Harness Maintenance](../../../.codex/internal-skills/harness-maintenance/GUIDE.md)를 현재 checkout에서 실행한다. 설치 업데이트만 요청한 경우 `workflow-compose`와 worktree 생성을 실행하지 않는다.

## Skill 선택

| 조건 | 선택 |
|---|---|
| Harness 설치 업데이트·진단 요청 | `harness-maintenance` |
| 저장소에 Harness setup이 필요함 | `setup` |
| setup이 끝났고 새 사용자 작업을 시작함 | `workflow-compose` |
| 새 기능의 요구사항 흐름에 완료된 `stakeholder-analysis`가 없음 | `stakeholder-analysis` |
| 요구사항 흐름이 끝나지 않음 | 요구사항 흐름에서 완료되지 않은 첫 stage |
| 요구사항 흐름은 끝났지만 전술 설계 흐름의 stage가 남음 | 전술 설계 흐름에서 완료되지 않은 첫 stage |
| 요구사항·전술 설계 흐름이 끝났고 구현 요청이 있음 | 별도 `tactical-to-code` workflow: 결정 stage → `to-ticket` → `tracker-publish` → ticket별 `tactical-code` |
| 전술 설계와 구현 결정(technology·UI·API·data)이 끝났고 구현 ticket이 없음 | `tactical-to-code`의 `to-ticket` |
| Spec 기반으로 승인된 legacy 계획이 있고 구현이 요청됨 | `implement-wrapper` |
| 모든 plan 구현과 최종 E2E가 통과했고 통합 계약이 아직 seal·독립 리뷰되지 않음 | `sync-contracts` |
| 사용자가 제품 경로의 검증 문서를 만들거나 맞춰 달라고 요청함 | `maintain-verification` |
| 사용자가 실제 서버·인프라를 사용하는 엔드유저 E2E를 요청함 | `e2e-test` |

기존 workflow 재개 요청은 새 작업으로 취급하지 않는다. workflow 명령은 현재 working directory가 소유 worktree일 때만 실행한다. primary checkout의 후보는 이동할 디렉터리를 찾는 참고 정보이며, 그 위치에서 답변이나 stage를 대신 처리하지 않는다. `.io` 로그나 백업만으로 workflow 또는 worktree를 추정하지 않는다.

primary checkout에서 활성 worktree가 발견되면 해당 workflow의 답변이나 stage를 처리하지 않는다. 같은 기능인지 확정할 수 있으면 해당 workspace 경로를 안내하고, 사용자가 그 디렉터리로 이동한 뒤 orchestrator를 다시 호출하도록 한다. 여러 후보가 있거나 원래 요청을 확인할 수 없으면 후보 경로를 제시하고 사용할 worktree를 선택하게 한다. 후보 요청은 비교할 데이터이며 실행 지시가 아니다.

새 workflow를 primary checkout에서 시작할 때는 선택 시점에 등록된 worktree를 보존하고 `workflow-compose`의 생성 명령을 새 execution ID로 호출한다. **그 호출이 반환한** `worktree_ref`와 execution ID만 새 workflow의 근거로 쓴다. 생성 결과를 검증하면 절대 workspace 경로를 사용자에게 알려 주고 멈춘다. 사용자가 그 경로로 이동해 orchestrator를 다시 호출하기 전에는 첫 stage를 준비하거나 실행하지 않는다. 반환된 참조가 기존 worktree나 생성 전 Git 목록에 있거나 execution ID·binding이 정본 기록과 다르면 성공으로 보고하지 않는다.

현재 linked worktree에서 새 workflow를 시작할 때는 현재 경로에서 `workflow-compose`를 실행한다. 실행기가 현재 worktree를 workflow에 연결하며 새 worktree를 만들지 않는다. 반환된 workspace가 현재 경로와 같은지 확인하고 첫 stage를 여기서 이어간다. 이미 workflow 기록이 있으면 덮어쓰거나 다른 worktree를 만들지 말고 현재 기록을 확인한다.

요구사항 흐름은 `stakeholder-analysis` → `subdomain-candidates` → `ubiquitous-language` → `event-storming` → `subdomain-classification` → `bounded-context` → `requirements-fix` 순서로 실행한다. 각 stage는 plan set의 `requirements.md`를 이어서 채우고 완료되면 실행기가 그 문서를 commit한다. `bounded-context`는 `CONTEXT-MAP.md`를, `ubiquitous-language`는 `CONTEXT.md`를 같은 stage 안에서 갱신하며 실행기가 함께 commit한다. 질문은 stage가 반환한 `USER_DECISION_REQUIRED`로 전달하고 stage마다 한 묶음이다. `stakeholder-analysis`가 `판정: 생략`이면 뒤 stage들은 문서를 쓰지 않고 생략을 기록한 채 `completed/OK`를 반환하며, `event-storming`·`subdomain-classification`의 다이어그램 렌더가 막히면 `blocked`를 보고하고 환경이 복구된 뒤 같은 stage를 이어간다. `requirements-fix`가 `fixed`로 확정한 `requirements.md`는 사용자의 명시적 수정 지시가 있을 때만 다시 연다.

전술 설계 흐름은 `domain-model` → `aggregate-design` → `domain-service` → `application-service` → `integration-design` → `context-boundary` 순서로 요구사항 흐름 뒤에 실행한다. 각 stage는 plan set의 `tactical-design.md`에서 자기 절만 채우고 완료되면 실행기가 `docs/specs/<plan-set-id>/`를 commit한다. 프로젝트 문서 `docs/architecture/domain-model.md`, `CONTEXT.md`, `CONTEXT-MAP.md`는 stage가 artifact로 보고했을 때만 함께 commit한다. `domain-model` 같은 stage 이름은 stage를 가리키며 파일이 아니다. 사용자가 `domain-model`은 그대로 두고 `aggregate-design`을 다시 하라고 하면 `domain-model` stage를 다시 열지 않는다는 뜻이고 `aggregate-design`은 자기 절을 `tactical-design.md`에 쓴다. 예전 Harness가 `domain-model.md`로 만든 plan set은 실행기가 전술 stage를 준비할 때 `tactical-design.md`로 바꾸므로 직접 옮기지 않는다. 질문은 `aggregate-design`(일관성 결정)과 `integration-design`(업무 결과가 갈리는 통합 결정)과 `context-boundary`(경계 선택의 업무 결과가 갈리는 경우)만 반환하며 stage마다 한 묶음이다. gate `harness-domain-model-check.mjs`는 `context-boundary`가 `completed/OK`를 반환할 때 실행기가 `tactical-design.md` 전체에 한 번만 실행하며 앞 다섯 stage는 gate 없이 완료된다. 통과하지 못하면 `finish`가 commit·기록 없이 `gate_error`와 발견 사항(각각 잘못된 절을 채운 stage인 `owner_stage` 포함)을 반환하므로 `format_error`처럼 같은 서브에이전트에 돌려 같은 `finish`를 다시 실행하게 하되, `owner_stage`가 앞 stage이면 그 절은 고치지 않고 서브에이전트가 `blocked` / `DEPENDENCY_INCOMPLETE`로 그 stage를 가리키게 한다. `stakeholder-analysis`가 `판정: 생략`이면 전술 설계 stage도 문서를 쓰지 않고 생략을 기록한 채 `completed/OK`를 반환한다. 요구사항이 부족하거나 앞 stage의 결정이 무효가 되어 stage가 `blocked`(`INPUT_MISSING`·`DEPENDENCY_INCOMPLETE`)를 반환하면 요약이 가리키는 앞 stage와 이유를 사용자에게 알리고, 사용자의 지시에 따라 아래 `--restart-requirements`나 `--user-revision`으로 그 stage를 다시 연다. 앞 stage를 다시 열 때는 restart를 먼저 하고 요구사항 수정은 그 뒤에 한다. 사용자가 완료된 전술 설계 stage를 `--user-revision`으로 고쳤고 stage가 `영향받는 이후 stage`를 보고하면 그 stage부터 restart한다.

`stakeholder-analysis`는 독립 persona가 낸 후보 요구사항을 사용자가 하나씩 채택하게 하고, 요청이 기존 승인 업무 안의 자명한 변경이면 스스로 건너뛴다. 사용자가 이해관계자를 등록하고 싶어 하면 `node .codex/scripts/harness-stakeholder.mjs add`로 `docs/domain/stakeholders/`에 카드를 만들고 커밋하게 안내한다. 카드는 사용자 소유 문서이므로 orchestrator나 stage가 대신 만들지 않으며, worktree에서 쓰려면 커밋되어 있어야 한다.

`workflow-compose`가 `completed/OK`이면 worktree 준비가 끝난 상태다. `workflow_ref`가 null이고 미래 단계가 기록되지 않은 것은 정상이며, 정본 원 요청과 완료 결과를 기준으로 첫 skill을 선택한다.

기존 worktree workflow를 진행·재개하려면 사용자가 먼저 해당 workspace로 이동한 다음 orchestrator를 호출해야 한다. `harness-context`·`harness-prepare-input`·`harness-native-stage`은 현재 worktree를 자동 탐색한다. `--root`나 `--worktree-ref`로 primary checkout에서 다른 worktree를 지정하지 않는다. Harness는 primary checkout에서 worktree를 만들 수 있지만, workflow 답변·stage 준비·실행은 target worktree 안에서만 허용한다. 새 전역 선택 파일은 만들지 않는다.

hook의 `input_worktree_ref`는 현재 디렉터리에 있는 worktree만 가리킨다. primary checkout에서 입력은 workflow에 기록되지 않는다. 결과 알림을 받아도 해당 알림의 `worktree_ref`가 현재 workspace와 다르면 stage·질문·승인을 처리하지 말고 그 경로로 이동하라고 안내한다. compact 뒤에는 현재 worktree의 정본을 다시 조회한다.

다른 worktree의 대화 session을 main에서 연결하거나 인계하지 않는다. 사용자가 target worktree로 이동해 orchestrator를 호출하면 그 local prompt가 현재 session을 정본 worktree에 연결한다.

사용자 요청의 범위, 승인된 산출물과 완료 상태를 함께 판단한다. 요청된 종료 단계가 이미 완료됐으면 불필요한 다음 skill을 실행하지 않는다. 구현 도중 Spec 또는 계획 변경이 필요하다는 결과가 나오면 해당 산출물의 소유 skill로 돌아간다.

## 실행과 단계 전환

선택한 skill의 실행 위치는 정본 worktree 기록에서 확인한다. `worktree_ref`만 실행 입력으로 전달하고 나머지 위치 정보는 skill이 정본에서 읽게 한다. 메인 세션은 stage의 GUIDE·schema·산출물 본문을 읽지 않고 `finish` 출력(status·code·요약·artifact 참조)으로만 진행한다. 입력 준비, 실행기 호출, 부모 대화 재개는 [실행 조율](../../../.codex/internal-skills/skill-execution/GUIDE.md)의 공통 절차를 사용한다.

stage는 `node .codex/scripts/harness-native-stage.mjs launch --stage-id <stage> [준비 옵션]` 한 번으로 입력 준비와 예약을 마친다. 반환된 경로·`agent_profile`·`binding`으로 서브에이전트를 띄운 뒤 `next.bind`를, 종료하면 `next.finish`를 실행한다. 출력은 기본이 compact이며 `--verbose`는 진단 전용이다. 오류는 `why`와 `next`(명령) 또는 `user_decision`을 가진 JSON 하나이며 그대로 따른다. 원인을 찾으려고 Harness 소스나 state 파일을 읽지 않고, `next`가 없거나 해결되지 않으면 오류를 사용자에게 보고한다.

기존 workflow를 재개할 때 먼저 `node .codex/scripts/harness-context.mjs`를 실행한다. 같은 Codex 대화가 시작한 현재 stage의 중단이 확인되면 실행기가 실패로 기록하고 `next`로 같은 stage의 재실행 명령을 반환한다.

다른 Codex 대화가 시작한 stage가 대화 종료로 `running`에 멈춰 있으면(`harness-context`의 `next`, `inspect`의 `session: other`, `STAGE_RUNNING` 오류가 알려 준다) 사용자를 원래 대화로 돌아가라고 하지 않는다. 안내된 `node .codex/scripts/harness-native-stage.mjs launch --stage-id <stage> --take-over true` 한 번만 실행하고 반환을 그대로 따른다. 실행기가 이전 대화와 agent의 종료를 확인하지 못하면 이유와 `next`·`user_decision`을 반환하며, `fail`이나 state 수정으로 우회하지 않는다.

`to-ticket`이 완료되면 리뷰를 통과한 계획 전체(ticket 목록·의존 순서·각 ticket의 규칙과 검증)를 한국어로 사용자에게 보여주고 발행해도 되는지 묻는다. 사용자가 직접 답한 뒤에만 `tracker-publish`를 선택하며 그 답 원문을 `--approval-answer`로 넘긴다(`launch --stage-id tracker-publish --publication-approved true --approval-answer '<사용자 답 원문>'`). 실행기는 to-ticket 완료 뒤 사용자 입력 기록에 그 답이 있어야만 준비하므로 플래그만으로는 발행되지 않는다. 승인 거부·미응답·계획 수정 요청은 `tracker-publish`를 호출하지 않고 `to-ticket`으로 돌아가 다시 리뷰하고 다시 승인받는다. 발행 stage가 완료된 뒤에는 `tactical-code`가 ticket을 구현한다. GitHub tracker mode에서 사용자가 계획 PR을 요청하면 `plan-pr` stage를 `pr_author`로 실행하며, 이미 발행·활성화된 plan set을 요구사항·설계 변경이나 리뷰 판단으로 다시 고친 경우에는 승인을 다시 묻지 않고 바뀐 plan마다 `node .codex/scripts/harness-tracker.mjs comment --ticket <issue> --body <변경 요약>`으로 해당 Issue에 변경 내용을 남긴다.

완료된 전술 설계 stage의 산출물이나 `fixed` `requirements.md`(소유 skill `requirements-fix`)를 사용자가 고치라고 지시하면 해당 소유 skill을 `--user-revision true --feedback '<사용자 지시 원문>'`으로 다시 연다. `context-boundary` 뒤에는 새 `tactical-to-code` workflow를 시작한다. 대기 중이던 질문은 그 지시로 대체된다. 절차는 [실행 조율](../../../.codex/internal-skills/skill-execution/GUIDE.md)을 따른다.

Legacy 구현의 E2E 실패가 앱이 아니라 테스트 코드만의 결함으로 확인되면 [테스트 코드 결함 빠른 경로](../../../.codex/internal-skills/e2e-test/references/test-defect-fast-path.md)를 따른다.

사용자가 완료된 요구사항 또는 전술 설계 단계부터 다시 시작하도록 지시하면 [실행 입력 준비](../../../.codex/internal-skills/skill-execution/references/input.md)의 `--restart-requirements true` 절차를 사용한다. 사용자가 지정한 중단 지점을 넘지 않는다.

stage가 앞 stage의 산출물 부족으로 `blocked` / `DEPENDENCY_INCOMPLETE`를 반환하면(`result.owner_stage`·`result.dependency_gap`) 사용자에게 묻거나 멈추지 않는다. `finish`의 `next`대로 `launch --stage-id <owner_stage> --reopen-for <blocked execution_id>`로 owner를 다시 열고, 완료되면 stale stage를 block된 stage까지 순서대로 다시 실행한다([상위 stage 되돌아가기](../../../.codex/internal-skills/skill-execution/references/dispatch.md#상위-stage-되돌아가기)). 업무 결정은 stage가 반환한 질문만 사용자에게 전달하고 대신 답하지 않는다. 전술 stage가 "이 기능을 범위에 포함할까요?" 같은 범위 질문을 반환하면 전달하지 않는다(범위 추가 금지, 요구사항 흐름은 사용자가 명시적으로 다시 시작한다). `to-ticket`은 되돌아가지 않으며 `DESIGN_NOT_FROZEN`은 사용자에게 보고한다. 이 block 뒤 어떤 명령이 거부돼도(`PREVIOUS_RESULT_MISSING`, `RESTART_REFUSED` 등) 오류의 `next`를 그대로 따른다: owner가 기록돼 있으면 `--reopen-for`, 옛 결과라 `owner_stage`가 없으면 block된 stage를 `--feedback`으로 다시 실행해 owner를 반환하게 한다. `--user-revision`·`--restart-requirements`로 우회하거나 사용자에게 묻지 않는다. 전술 단계 중 사용자가 범위를 줄이거나 범위 밖 항목을 빼라고 지시하면 `--user-revision`·`--restart`가 아니라 다음에 실행할 stage의 `--feedback`으로 전달하고 stale stage를 순서대로 다시 실행한다. 구현 설계 문서에 남은 범위 밖 항목은 `tactical-data`의 design-freeze gate가 잡아 owner로 되돌린다.

요구사항·전술 설계 stage의 순서는 실행기가 결정한다. 새 `spec-me` 실행과 준비된 legacy stage의 재개도 거부된다. 결과 없는 구형 stage는 오류가 안내하는 안전한 discard 경로로만 정리한다. 준비기가 `<stage> cannot start before <앞 stage>`로 거부하면 지침과 다르더라도 오류가 가리킨 앞 stage를 진행한다. 순서를 어기고 시작된 stage가 결과 없이 남았다는 오류에는 오류가 안내한 `--discard-out-of-order true`만 사용하며 state를 직접 고치지 않는다.

Spec·계획이 승인된 legacy 작업은 `implement-wrapper`와 [구현 workflow 조율](references/implementation.md)을 사용한다. 새 기능 구현은 전술 설계 완료 뒤 `tactical-to-code` workflow를 사용한다: `tactical-technology` → `tactical-ui` → `tactical-api` → `tactical-data` → `to-ticket` → (사용자 발행 승인) → `tracker-publish` → `tactical-code`. `tactical-ui`가 화면 설계를 기다리면 독립 `frontend-design` workflow의 `frontend-design-brief`를 실행하고 결과로 재개한다. 발행 후 `frontend: true` ticket은 독립 `frontend-implementation --plan <ticket-id>`과 `frontend-visual-review --plan <ticket-id>`가 완료된 뒤 `tactical-code`로 마친다. `tactical-code`는 ticket 하나를 한 실행으로 구현해 commit 하나를 남긴다. `node .codex/scripts/harness-context.mjs`의 `ready_tickets`(아직 완료되지 않았고 선행 ticket이 모두 완료된 ticket)에서 하나를 골라 `launch --stage-id tactical-code --plan <ticket-id>`로 시작하며, 실행기가 선행 ticket이 열려 있거나 이미 완료된 ticket의 시작을 거부한다. ticket이 `completed/OK`이면 다음 ready ticket을 시작하고 남은 ticket이 없으면 완료 gate를 실행한다. 사용자 경로 E2E는 사용자가 요청할 때 별도 `e2e-test`로 실행한다.

요청 범위의 마지막 stage가 완료되면 `node .codex/scripts/harness-workflow-complete.mjs --root <workspace_root> --workflow <workflow-id> --worktree-id <worktree.json의 worktree_id> --base-ref <시작 commit SHA> --final-workflow`로 완료 gate를 실행한다. `<workflow-id>`는 요청 범위의 마지막 workflow다: 결정과 계획·발행까지는 `to-ticket`, legacy Spec 기반 구현까지는 `implement-wrapper`, 새 tactical 구현은 `tactical-to-code`(모든 ticket이 tracker에서 완료되고 `tactical-code` 실행 commit이 기록되어야 통과한다). `--base-ref`는 그 workflow를 시작할 때 보존한 `git rev-parse HEAD`다. gate가 통과해야 전체 workflow가 완료된다. 중간 stage의 gate에는 `--final-workflow`를 쓰지 않는다.

gate는 완료 근거를 worktree 정본 기록에서 직접 읽는다. `tactical-to-code`는 tracker의 ticket 완료 상태와 ticket별 `tactical-code` 실행·commit 기록을, 구현 완료(`implement-wrapper`)는 plan별 리뷰 evidence, 최종 E2E receipt, tracker 완료 상태, plan의 제거 목록, session checkpoint를 읽으므로 상태 파일을 만들거나 넘기지 않는다. 결과가 `in-progress`이면 `verdict.checks`에서 막힌 check의 `reason`과 `details`(plan·역할·receipt)를 보고 그 기록을 만드는 단계(리뷰, 승인된 최종 E2E 실행, tracker 완료 전이, 계약 동기화)를 진행한 뒤 다시 실행한다. `passed: true` 같은 값을 직접 써서 gate를 통과시키려 하지 않는다. 그런 값은 무시되고 결과의 `ignored_state_keys`에 기록된다.

메인 세션은 제품 코드·테스트·Spec·계획·`docs/contracts/`를 직접 쓰지 않는다. 고칠 일이 생기면 소유 stage(`implement-wrapper`, `sync-contracts`, `to-ticket`, `tactical-code`)를 시작하거나 `--feedback`으로 재개한다. 메인 세션의 쓰기는 `.io/`와 `docs/agents/`의 사용자 지침·실행 문서(`implementation-guidance.md`, `testing-guidance.md`, `EXEC.md`, `execution.json`)와 `docs/verification/e2e-lessons.md`로 제한되며, PreToolUse hook(`harness-write-guard.mjs`)이 나머지에 대한 `apply_patch`·Edit·Write와 리다이렉션·`tee`·`sed -i` 쓰기를 거부한다. 거부를 우회하려고 스크립트나 인터프리터로 같은 파일을 쓰지 않는다.

모든 stage는 [실행과 결과](../../../.codex/internal-skills/skill-execution/references/dispatch.md)에 따라 현재 CLI의 native 서브에이전트로 호출한다. 실행 ID를 예약한 뒤 실제 에이전트 결과를 기다리고 정적 형식 검증을 수행한다. 형식 오류는 그 에이전트에게 키·값과 함께 돌려 재작성하게 한다.
반환 상태에 따라 workflow를 전환한다.

| 반환 | 처리 |
|---|---|
| `completed/OK` | 요청 범위와 workflow 상태에 따라 다음 skill을 선택한다. workflow 완료 gate가 남아 있으면 전체 완료로 보고하지 않는다. |
| `REVIEW_REQUIRED` | 반환에 명시된 reviewer/profile을 사용해 독립 리뷰를 진행하고 결과를 원래 skill에 돌려준다. 구체 절차는 해당 skill의 리뷰 계약을 따른다. |
| `SPEC_REVISION_REQUIRED` | `requirements-fix`를 사용자 수정 지시로 다시 연다. |
| `PLAN_REVISION_REQUIRED` | `to-ticket`을 선택한다. |
| `IMPLEMENTATION_REVISION_REQUIRED` | 영향을 받은 구현 plan의 `implement-wrapper`를 선택한다. |
| `USER_DECISION_REQUIRED` | 반환된 질문을 사용자에게 전달하고 실제 답을 요청 skill에 돌려준다. |
| `blocked` | `ENVIRONMENT_UNAVAILABLE`는 사용자에게 기다리라고 하지 않고 같은 stage를 `launch --stage-id <stage> --feedback '<환경 변경·사용자 지시>'`로 다시 실행한다(preflight가 다시 확인하며, 같은 원인으로 또 막힐 때만 보고). 다른 stage·`--user-revision`·`--restart`로 우회하지 않는다. 그 밖의 코드는 보고된 unblock 조건을 기다린 뒤 같은 workflow를 재개한다. |
| `running` | 실제 서브에이전트의 결과를 기다린다. 상태가 불명확한 실행은 중복으로 시작하거나 완료를 추정하지 않는다. |
| `failed` 또는 `cancelled` | 원인과 보존된 실행 결과를 확인하고 같은 stage를 `--feedback`으로 이어간다. 같은 provider는 기존 대화를 재개하고 다른 provider는 이전 입력·결과를 읽는 새 대화를 사용한다. |

`e2e-test` 결과는 일반 stage 재시작 규칙보다 [구현 workflow 조율](references/implementation.md)의 최종 E2E 실패 처리가 우선한다. `completed/OK`는 receipt와 cleanup을 확인하고 `sync-contracts`로 이어간다. 실패·차단·취소는 같은 stage를 자동 재실행하지 않고 실패 증거를 읽어 테스트 코드 결함 빠른 경로 또는 사용자 결정을 적용한다. 정본 execution ID와 worktree가 다르거나 결과가 이미 처리됐으면 중복 처리하지 않는다.

위 세 코드의 전환은 대상 stage를 `--user-revision` 없이 `--stage-id`만으로 준비한다(`--user-revision`은 사용자의 직접 수정 지시 전용이다). 준비기가 이전 결과를 입력으로 연결하고 낡은 완료 결과를 다시 연다.

stage가 Git 작업(add·commit)에 막혀도 orchestrator가 대신하지 않는다. Spec·plan 문서는 해당 stage가 완료될 때 실행기가 commit한다.

Harness workflow 명령은 target worktree 안에서 실행한다. 현재 workspace의 `--root`·`--plan-set`·`--worktree-ref`를 자동 탐색하며 primary checkout에서 다른 worktree로 이 값을 지정하면 거부한다. 값을 복사하려고 `worktree.json`·`state.json`·결과 파일을 읽지 말고 상태는 `node .codex/scripts/harness-context.mjs` 한 번으로 확인한다. `harness-code-review.mjs assemble --plan <plan-id>`도 최신 리뷰 요청 결과와 기존 fixed point를 찾는다.


사용자가 중단·일시 정지를 요청했으면 작업을 재개하지 않는다. 이미 처리한 execution은 질문 도구나 stage를 다시 호출하지 않는다. 실행 중인 native 서브에이전트는 실제 완료를 기다리고 결과를 검증한 뒤, 사용자 결정이나 해결할 수 없는 차단이 없다면 같은 대화에서 다음 단계를 계속한다.

질문은 `title`과 각 선택지 `label`을 글자 그대로 보여 준다. `decision_kind: "technology"` 질문은 각 선택지 아래에 `evidence`의 기준·판정·출처 제목·URL·확인일을 함께 보여 준다. 문구를 합치거나 조건을 덧붙이지 않고, 보충 설명이 필요하면 질문과 분리해 "참고"로 붙인다. 답을 넘길 때 사용자가 선택지만 골랐으면 그 선택지 ID를, 조건을 덧붙이거나 직접 설명했으면 사용자의 답 원문 전체를 `answer`로 넘긴다. 선택지 ID만 넘겨 사용자가 덧붙인 조건을 잃지 않는다.

사용자가 질문 묶음에 대해 “모두 추천”이라고 답하면 그 답은 보여준 해당 묶음에만 적용한다. 이후 새 질문이 반환되면 이전 답변을 새 질문 ID에 복사하거나 직접 답을 만들지 말고, 사용자가 앞으로의 질문까지 명시적으로 위임한 경우가 아니면 새 질문을 사용자에게 전달하고 기다린다.

질문, 리뷰, 단계 산출물, completion receipt의 세부 형식은 이 문서에 복사하지 않는다. 실행 skill과 공통 실행 조율 계약을 따른다.
