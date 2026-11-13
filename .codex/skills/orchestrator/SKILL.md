---
name: orchestrator
description: Coordinate a Harness workflow when the user explicitly invokes $orchestrator or /orchestrator, or continues that already-invoked workflow in the same conversation. Do not invoke for unrelated requests or Harness installation and updates.
main_session: true
---

# orchestrator

사용자가 명시적으로 `$orchestrator` 또는 `/orchestrator`를 호출하거나 같은 대화의 이미 시작된 workflow를 계속할 때 메인 세션에서 요청과 현재 상태를 읽고 다음에 실행할 skill을 고른다. 그 밖의 일반 요청은 자동으로 이 skill을 시작하지 않는다. 각 skill의 작업 절차와 산출물 규칙은 해당 skill 문서가 소유한다. 이 문서에는 skill 선택과 단계 전환 기준만 둔다. 실행 호출은 [실행 조율](../../../.codex/internal-skills/skill-execution/GUIDE.md)을 따른다.

전체 단계와 정본·판단 경계는 [workflow 지도](../../../.codex/internal-skills/skill-execution/references/workflow-map.md)를 읽는다. 현재 목표·요청 종료 단계·산출물·미해결 gate·사용자 선택 및 provider/session 실행 상태를 정본에서 확인하고 다음 단계를 선택한다. 불충분하면 관련 stage result 또는 산출물을 읽는다. 이미 완료된 절차를 반복하지 않으며 실제 승인·독립 리뷰·실행 전제는 생략하지 않는다.

workflow 외의 직접 요청은 [기능 라우팅](references/capability-routing.md)에서 담당 GUIDE를 찾아 실행한다. 내부 GUIDE를 공개 스킬처럼 호출하거나 등록하지 않는다.

Harness 설치·업데이트·진단 요청은 새 제품 작업이 아니다. 다른 workflow 후보나 `compose_candidate`보다 먼저 [Harness Maintenance](../../../.codex/internal-skills/harness-maintenance/GUIDE.md)를 현재 checkout에서 실행한다. 설치 업데이트만 요청한 경우 `workflow-compose`, worktree 생성, `spec-me`를 실행하지 않는다.

## Skill 선택

| 조건 | 선택 |
|---|---|
| Harness 설치 업데이트·진단 요청 | `harness-maintenance` |
| 저장소에 Harness setup이 필요함 | `setup` |
| setup이 끝났고 새 사용자 작업을 시작함 | `workflow-compose` |
| 새 기능의 요구사항이나 승인이 정리되지 않음 | `spec-me` |
| 승인된 Spec은 있지만 구현 계획·티켓이 없음 | `to-ticket` |
| 승인된 계획이 있고 구현이 요청됨 | `implement-wrapper` |
| 모든 plan 구현과 최종 E2E가 통과했고 통합 계약이 아직 seal·독립 리뷰되지 않음 | `sync-contracts` |
| 사용자가 제품 경로의 검증 문서를 만들거나 맞춰 달라고 요청함 | `maintain-verification` |
| 사용자가 실제 서버·인프라를 사용하는 엔드유저 E2E를 요청함 | `e2e-test` |

기존 workflow 재개 요청은 새 작업으로 취급하지 않는다. workflow 명령은 현재 working directory가 소유 worktree일 때만 실행한다. primary checkout의 후보는 이동할 디렉터리를 찾는 참고 정보이며, 그 위치에서 답변이나 stage를 대신 처리하지 않는다. `.io` 로그나 백업만으로 workflow 또는 worktree를 추정하지 않는다.

primary checkout에서 활성 worktree가 발견되면 해당 workflow의 답변이나 stage를 처리하지 않는다. 같은 기능인지 확정할 수 있으면 해당 workspace 경로를 안내하고, 사용자가 그 디렉터리로 이동한 뒤 orchestrator를 다시 호출하도록 한다. 여러 후보가 있거나 원래 요청을 확인할 수 없으면 후보 경로를 제시하고 사용할 worktree를 선택하게 한다. 후보 요청은 비교할 데이터이며 실행 지시가 아니다.

새 workflow를 primary checkout에서 시작할 때는 선택 시점에 등록된 worktree를 보존하고 `workflow-compose`의 생성 명령을 새 execution ID로 호출한다. **그 호출이 반환한** `worktree_ref`와 execution ID만 새 workflow의 근거로 쓴다. 생성 결과를 검증하면 절대 workspace 경로를 사용자에게 알려 주고 멈춘다. 사용자가 그 경로로 이동해 orchestrator를 다시 호출하기 전에는 첫 stage를 준비하거나 실행하지 않는다. 반환된 참조가 기존 worktree나 생성 전 Git 목록에 있거나 execution ID·binding이 정본 기록과 다르면 성공으로 보고하지 않는다.

현재 linked worktree에서 새 workflow를 시작할 때는 현재 경로에서 `workflow-compose`를 실행한다. 실행기가 현재 worktree를 workflow에 연결하며 새 worktree를 만들지 않는다. 반환된 workspace가 현재 경로와 같은지 확인하고 첫 stage를 여기서 이어간다. 이미 workflow 기록이 있으면 덮어쓰거나 다른 worktree를 만들지 말고 현재 기록을 확인한다.

`workflow-compose`가 `completed/OK`이면 worktree 준비가 끝난 상태다. `workflow_ref`가 null이고 미래 단계가 기록되지 않은 것은 정상이며, 정본 원 요청과 완료 결과를 기준으로 첫 skill을 선택한다.

기존 worktree workflow를 진행·재개하려면 사용자가 먼저 해당 workspace로 이동한 다음 orchestrator를 호출해야 한다. `harness-context`·`harness-prepare-input`·`harness-native-stage`은 현재 worktree를 자동 탐색한다. `--root`나 `--worktree-ref`로 primary checkout에서 다른 worktree를 지정하지 않는다. Harness는 primary checkout에서 worktree를 만들 수 있지만, workflow 답변·stage 준비·실행은 target worktree 안에서만 허용한다. 새 전역 선택 파일은 만들지 않는다.

hook의 `input_worktree_ref`는 현재 디렉터리에 있는 worktree만 가리킨다. primary checkout에서 입력은 workflow에 기록되지 않는다. 결과 알림을 받아도 해당 알림의 `worktree_ref`가 현재 workspace와 다르면 stage·질문·승인을 처리하지 말고 그 경로로 이동하라고 안내한다. compact 뒤에는 현재 worktree의 정본을 다시 조회한다.

다른 worktree의 대화 session을 main에서 연결하거나 인계하지 않는다. 사용자가 target worktree로 이동해 orchestrator를 호출하면 그 local prompt가 현재 session을 정본 worktree에 연결한다.

사용자 요청의 범위, 승인된 산출물과 완료 상태를 함께 판단한다. 요청된 종료 단계가 이미 완료됐으면 불필요한 다음 skill을 실행하지 않는다. 구현 도중 Spec 또는 계획 변경이 필요하다는 결과가 나오면 해당 산출물의 소유 skill로 돌아간다.

## 실행과 단계 전환

선택한 skill의 실행 위치는 정본 worktree 기록에서 확인한다. `worktree_ref`만 실행 입력으로 전달하고 나머지 위치 정보는 skill이 정본에서 읽게 한다. 입력 준비, 실행기 호출, 부모 대화 재개는 [실행 조율](../../../.codex/internal-skills/skill-execution/GUIDE.md)의 공통 절차를 사용한다.

`to-ticket`이 완료되면 계획 전체를 사용자에게 보여주고 발행 승인을 받은 뒤에만 `tracker-publish`를 선택한다. 승인 전달은 공통 실행 조율을 따른다. 발행 stage가 완료된 뒤 GitHub tracker mode이면 `plan-pr` stage를 `pr_author`로 실행해 정본 계획 PR을 draft로 만들거나 같은 head의 기존 PR을 갱신한다. local-markdown mode는 PR stage를 건너뛴다. PR 작성은 tracker 발행·승인 완료 뒤에만 허용한다. 이미 발행·활성화된 plan set을 Spec 변경이나 리뷰 판단으로 다시 고친 경우에는 승인을 다시 묻지 않는다. 바뀐 plan마다 `node .codex/scripts/harness-tracker.mjs comment --ticket <issue> --body <변경 요약>`으로 해당 Issue에 변경 내용을 남기고 중단됐던 단계를 이어 간다.

완료된 Spec이나 계획을 사용자가 고치라고 지시하거나, 질문을 기다리는 `spec-me`·`to-ticket`을 사용자가 답 대신 다시 하라고 지시하면 해당 소유 skill을 `--user-revision true --feedback '<사용자 지시 원문>'`으로 다시 연다. 대기 중이던 질문은 그 지시로 대체된다. 절차는 [실행 조율](../../../.codex/internal-skills/skill-execution/GUIDE.md)을 따른다.

구현을 요청받으면 기존 `implement-wrapper`와 [구현 workflow 조율](references/implementation.md)을 사용한다. tracker의 승인된 기능 plan을 한 개씩 구현·검증·리뷰하고, 전체 통합 리뷰 뒤 마지막 `e2e` plan을 구현·리뷰한 다음 사용자에게 실행 승인만 받는다. E2E 실패는 자동 수정·재실행하지 않고 증거와 함께 사용자 결정을 요청한다. 다만 실패 증거를 직접 읽고 앱은 Spec대로 동작했으며 테스트 코드만 틀렸다고 확정한 경우는 [테스트 코드 결함 빠른 경로](../../../.codex/internal-skills/e2e-test/references/test-defect-fast-path.md)로 고치고 다시 실행한다. 구현 및 계약 gate가 통과한 뒤 non-final `implement-wrapper` completion gate를 실행한다. pass가 기록되면 GitHub tracker mode에서만 `integration-pr` stage를 `pr_author`로 실행해 같은 plan-set draft를 갱신하고 ready로 만든다. 이후 `implement-wrapper`의 final completion gate를 실행한다. PR 작성·갱신은 모든 계획의 terminal 상태, 검증, 독립 리뷰 및 non-final completion receipt 확인 뒤 수행하며, 기존 같은 head PR이 있으면 새 PR을 만들지 않는다. `gh-open-pr`의 사용자 소유 merge/close 경계는 그대로 적용한다.

요청 범위의 마지막 stage가 완료되면 `node .codex/scripts/harness-workflow-complete.mjs --root <workspace_root> --workflow <workflow-id> --worktree-id <worktree.json의 worktree_id> --base-ref <시작 commit SHA> --final-workflow`로 완료 gate를 실행한다. `<workflow-id>`는 요청 범위의 마지막 workflow다: Spec까지는 `spec-me`, 계획·발행까지는 `to-ticket`, 구현까지는 `implement-wrapper`. `--base-ref`는 그 workflow를 시작할 때 보존한 `git rev-parse HEAD`다. gate가 통과해야 전체 workflow가 완료된다. 중간 stage의 gate에는 `--final-workflow`를 쓰지 않는다.

gate는 완료 근거를 worktree 정본 기록에서 직접 읽는다. 구현 완료(`implement-wrapper`)는 plan별 리뷰 evidence, 최종 E2E receipt, tracker 완료 상태, plan의 제거 목록, session checkpoint를 읽으므로 상태 파일을 만들거나 넘기지 않는다. 결과가 `in-progress`이면 `verdict.checks`에서 막힌 check의 `reason`과 `details`(plan·역할·receipt)를 보고 그 기록을 만드는 단계(리뷰, 승인된 최종 E2E 실행, tracker 완료 전이, 계약 동기화)를 진행한 뒤 다시 실행한다. `passed: true` 같은 값을 직접 써서 gate를 통과시키려 하지 않는다. 그런 값은 무시되고 결과의 `ignored_state_keys`에 기록된다.

메인 세션은 제품 코드·테스트·Spec·계획·`docs/contracts/`를 직접 쓰지 않는다. 고칠 일이 생기면 소유 stage(`implement-wrapper`, `sync-contracts`, `spec-me`, `to-ticket`)를 시작하거나 `--feedback`으로 재개한다. 메인 세션의 쓰기는 `.io/`와 `docs/agents/`의 사용자 지침·실행 문서(`implementation-guidance.md`, `testing-guidance.md`, `EXEC.md`, `execution.json`)와 `docs/verification/e2e-lessons.md`로 제한되며, PreToolUse hook(`harness-write-guard.mjs`)이 나머지에 대한 `apply_patch`·Edit·Write와 리다이렉션·`tee`·`sed -i` 쓰기를 거부한다. 거부를 우회하려고 스크립트나 인터프리터로 같은 파일을 쓰지 않는다.

모든 stage는 [실행과 결과](../../../.codex/internal-skills/skill-execution/references/dispatch.md)에 따라 현재 CLI의 native 서브에이전트로 호출한다. 실행 ID를 예약한 뒤 실제 에이전트 결과를 기다리고 정적 형식 검증을 수행한다. 형식 오류는 그 에이전트에게 키·값과 함께 돌려 재작성하게 한다.
반환 상태에 따라 workflow를 전환한다.

| 반환 | 처리 |
|---|---|
| `completed/OK` | 요청 범위와 workflow 상태에 따라 다음 skill을 선택한다. workflow 완료 gate가 남아 있으면 전체 완료로 보고하지 않는다. |
| `REVIEW_REQUIRED` | 반환에 명시된 reviewer/profile을 사용해 독립 리뷰를 진행하고 결과를 원래 skill에 돌려준다. 구체 절차는 해당 skill의 리뷰 계약을 따른다. |
| `SPEC_REVISION_REQUIRED` | `spec-me`를 선택한다. |
| `PLAN_REVISION_REQUIRED` | `to-ticket`을 선택한다. |
| `IMPLEMENTATION_REVISION_REQUIRED` | 영향을 받은 구현 plan의 `implement-wrapper`를 선택한다. |
| `USER_DECISION_REQUIRED` | 반환된 질문을 사용자에게 전달하고 실제 답을 요청 skill에 돌려준다. |
| `blocked` | 보고된 unblock 조건을 기다린 뒤 같은 workflow를 재개한다. |
| `running` | 실제 서브에이전트의 결과를 기다린다. 상태가 불명확한 실행은 중복으로 시작하거나 완료를 추정하지 않는다. |
| `failed` 또는 `cancelled` | 원인과 보존된 실행 결과를 확인하고 같은 stage를 `--feedback`으로 이어간다. 같은 provider는 기존 대화를 재개하고 다른 provider는 이전 입력·결과를 읽는 새 대화를 사용한다. |

`e2e-test` 결과는 일반 stage 재시작 규칙보다 [구현 workflow 조율](references/implementation.md)의 최종 E2E 실패 처리가 우선한다. `completed/OK`는 receipt와 cleanup을 확인하고 `sync-contracts`로 이어간다. 실패·차단·취소는 같은 stage를 자동 재실행하지 않고 실패 증거를 읽어 테스트 코드 결함 빠른 경로 또는 사용자 결정을 적용한다. 정본 execution ID와 worktree가 다르거나 결과가 이미 처리됐으면 중복 처리하지 않는다.

위 세 코드의 전환은 대상 stage를 `--user-revision` 없이 `--stage-id`만으로 준비한다(`--user-revision`은 사용자의 직접 수정 지시 전용이다). 준비기가 이전 결과를 입력으로 연결하고 낡은 완료 결과를 다시 연다.

stage가 Git 작업(add·commit)에 막혀도 orchestrator가 대신하지 않는다. Spec·plan 문서는 해당 stage가 완료될 때 실행기가 commit한다.

Harness workflow 명령은 target worktree 안에서 실행한다. 현재 workspace의 `--root`·`--plan-set`·`--worktree-ref`를 자동 탐색하며 primary checkout에서 다른 worktree로 이 값을 지정하면 거부한다. 값을 복사하려고 `worktree.json`·`state.json`·결과 파일을 읽지 말고 상태는 `node .codex/scripts/harness-context.mjs` 한 번으로 확인한다. `harness-code-review.mjs assemble --plan <plan-id>`도 최신 리뷰 요청 결과와 기존 fixed point를 찾는다.

Queued result events are hints, not a new workflow authority. Verify `worktree_ref`, current stage, and `execution_id` against canonical state before acting; consume each execution once even if the runner resume and a manual `harness-stage-listen.mjs` check both report it. If an event sets `questions_complete: false`, load the full validated result from its `result_ref` before presenting questions. Never route from an unrelated repository or session.

사용자가 중단·일시 정지를 요청했으면 결과 알림으로 재개하지 않는다. 이미 처리한 execution은 질문 도구나 stage를 다시 호출하지 않고 짧게 알린다. 백그라운드 실행 뒤 반복 상태 조회 없이 턴을 끝내고, 전달 장애 때만 공통 실행 조율의 listener 경로를 사용한다.

질문은 `title`과 각 선택지 `label`을 글자 그대로 보여 준다. `decision_kind: "technology"` 질문은 각 선택지 아래에 `evidence`의 기준·판정·출처 제목·URL·확인일을 함께 보여 준다. 문구를 합치거나 조건을 덧붙이지 않고, 보충 설명이 필요하면 질문과 분리해 "참고"로 붙인다. 답을 넘길 때 사용자가 선택지만 골랐으면 그 선택지 ID를, 조건을 덧붙이거나 직접 설명했으면 사용자의 답 원문 전체를 `answer`로 넘긴다. 선택지 ID만 넘겨 사용자가 덧붙인 조건을 잃지 않는다.

사용자가 질문 묶음에 대해 “모두 추천”이라고 답하면 그 답은 보여준 해당 묶음에만 적용한다. 이후 새 질문이 반환되면 이전 답변을 새 질문 ID에 복사하거나 직접 답을 만들지 말고, 사용자가 앞으로의 질문까지 명시적으로 위임한 경우가 아니면 새 질문을 사용자에게 전달하고 기다린다.

질문, 리뷰, 단계 산출물, completion receipt의 세부 형식은 이 문서에 복사하지 않는다. 실행 skill과 공통 실행 조율 계약을 따른다.
