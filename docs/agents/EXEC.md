# 실행 환경 안내

기술 선택의 일반 출처는 주장·위치·적용 조건·확인일을 기록한다. 공통 Knowledge 게시 시에만 기존 승인 절차를 적용한다. 설치된 runtime의 같은 검증과 프로젝트 문서의 Git 가시성도 함께 확인한다.

플랫폼별 설정과 실행 방법은 이 문서에 기록한다. `AGENTS.md`에는 공통 agent 규칙만 둔다.

## 기록 대상

- 플랫폼별 개발 환경 설정
- server 실행·중지 방법
- infra 의존성 준비와 정리 방법
- 플랫폼별 명령어 차이와 필요한 환경 변수

## 플랫폼별 실행 방법

플랫폼별 설정·실행 방법이 추가되면 아래에 기록한다.

### macOS / Linux

추가 지침 없음.

### Windows

추가 지침 없음.


## Harness 원본 저장소의 설치 동작

- 공개 Harness 진입점은 `orchestrator`, `eli5`, `setup`만 `.codex/skills/*/SKILL.md`에 둔다. 내부 절차와 지원 파일은 `.codex/internal-skills/*/GUIDE.md`에 두고 consumer에도 같은 경로로 설치한다. Native public copies는 `.agents/skills/`와 `.claude/skills/`에 생성한다. Loader와 agent runner는 internal GUIDE를 직접 읽는다. 관리 lock으로 확인한 과거 공개 Harness copies는 설치·갱신 시 session backup 후 제거하고, 사용자 소유 비관리 파일은 보존한다.
- Spec의 session-worktree 분기·준비 참조 검사는 `python3 -B -m unittest discover -s tests -p test_spec_diagram_workflow.py -k test_spec_me_prepares_the_session_worktree_before_spawning_agents`로 실행한다.
- 구현 worktree 지침은 `session-worktree/references/sequential.md`와 `parallel.md`로 분리한다. wrapper는 의존성·공유 자원 판단 후 선택한 파일 하나만 읽고 `workspace_mode`·절대 `workspace_reference`를 하위 단계에 전달한다. `spec-me`는 진입 시 `worktree-create` skill을 실행한다. CLI 입출력 표는 `session-worktree/references/worktree-cli.md`에 둔다. 이 내부 skill과 reference는 기존 내부 스킬 관리 자산으로 설치·업데이트·Doctor·Git 제외 검사를 받는다.
- 계획의 실행 위치(`workspace_root`, `workspace_branch`)는 정적 실행기가 worktree.json과 Git에서 확정하며 agent가 per-plan/index에 기록하지 않는다. `internal-skills-check`는 설치·갱신된 consumer의 지침 배포, Issue renderer의 실행 위치 보존, Doctor inventory와 애플리케이션 변경의 Git 노출을 확인한다.
- 내부 스킬 설치·갱신·비노출·호출 링크 회귀 검사는 `node --test tests/internal_skills.test.mjs tests/plan_review.test.mjs tests/wrapper_dispatch.test.mjs tests/wrapper_scheduler.test.mjs tests/tracker_contract.test.mjs tests/workflow_loader.test.mjs tests/installer_update.test.mjs tests/installer_exclude.test.mjs tests/doctor.test.mjs tests/workflow_worktrees.test.mjs tests/workflow_completion_retention.test.mjs tests/contracts.test.mjs tests/skill_execution.test.mjs tests/orchestrator_hook.test.mjs`로 실행한다. 서버·외부 인프라는 필요하지 않다.

- 이전 배포본과 정확히 일치하는 폐기 Harness 자산은 update가 백업 후 제거한다. 미확인·수정 파일은 보존하고 Git에서 프로젝트 소유 파일의 가시성을 확인한다.
- Harness 원본 저장소와 해당 worktree에서는 `.codex/skills/` 및 `.codex/agents/`를 직접 사용한다. `install`, `update`, `lock`은 설치 사본을 만들거나 원본 agent profile의 경로를 치환하지 않고 건너뛴다. 원본 갱신은 Git으로 관리한다.
- 원본 checkout 판별은 설치 도구와 대상이 같은 실제 경로이거나, 같은 package 이름과 Harness installer·소스·스킬 파일이 있는지를 확인한다.
- 외부 프로젝트에는 공개 세 skill만 `.agents/skills/`와 `.claude/skills/`에 설치하고 내부 GUIDE·agent profile·workflow/runtime은 `.codex/`에 둔다.
- update는 공개 SKILL.md, 내부 GUIDE 및 supporting reference/assets/scripts를 lock으로 관리한다. 관리 자산 교체 전 기존 파일을 session/runtime/installer-backups/<id>/에 백업하며 사용자 소유 비관리 파일은 보존한다.
- workflow skill 탐색은 `.codex/internal-skills/<id>/GUIDE.md`를 우선한다. 공개 세 skill은 native 사용자 목록 진입에만 사용한다. 원본 checkout도 internal GUIDE를 직접 읽고 중복 `.agents/skills` mirror를 두지 않는다.

## E2E 실패 학습 계약

E2E 실패를 확인하면 `e2e-test`의 실패 학습 절차에 따라 원인 근거와 반복 여부를 기록한다. 반복되거나 재사용할 예방 절차가 확인되면 활성 workspace의 `docs/agents/testing-guidance.md`를 갱신한다. 실행값·URL·포트·readiness profile은 `docs/agents/execution.json`, 운영자가 따라야 할 준비·진단 절차는 이 문서에 반영하고 서로 일치시킨다. 테스트 결과와 학습 상태를 분리하며 학습 pending은 테스트 통과나 workflow 완료를 막지 않는다. `e2e-learning-check` profile의 `config_inputs`에는 이 규칙, 검증 코드와 관련 테스트를 포함한다.

## Harness 검증 경로 실행

worktree cwd enforcement 회귀는 `node --import ./tests/support/isolated-codex-home.mjs --test tests/worktree_cwd_enforcement.test.mjs tests/cli_context.test.mjs tests/codex_orchestrator_user_hook.test.mjs tests/stage_result_events.test.mjs tests/orchestrator_write_guard.test.mjs`로 실행한다. 임시 installed-consumer에서 main의 `--root`·`--worktree-ref` 우회가 거부되고, worktree 내부의 입력 준비·실행·사용자 입력 기록은 성공하는지, update·Doctor·Git 가시성을 검사한다. 모델과 Wake는 test double을 사용하며 실제 Codex E2E로 보고하지 않는다.

운영 시 primary checkout에서 compose에 실제 `--orchestrator-provider`·`--orchestrator-session-id`를 전달한다. 생성 검증 후 절대 workspace 경로를 사용자에게 보여 주고 멈춘다. 사용자가 그 worktree로 이동해 같은 대화에서 orchestrator를 다시 호출한 뒤 첫 stage를 시작한다. workflow 명령은 현재 worktree에서 실행하며 primary checkout에서 `--root`·`--worktree-ref`로 다른 worktree를 지정하면 거부한다. 결과를 다른 cwd에서 받으면 결과의 worktree로 이동한 다음 이어 간다.

사용자 입력은 hook을 실행한 현재 worktree에만 기록한다. primary checkout에서는 다른 workflow로 입력을 전달하지 않으며, 답변·재개는 target worktree로 이동해 orchestrator를 호출한다. Codex 사용자 수준 write-guard hook 명령이 갱신되었으므로 실제 consumer 업데이트 후 Doctor에서 신뢰 상태를 확인하며 필요한 경우 `/hooks`에서 변경된 hook을 검토·신뢰한다.

아래 계산기 E2E는 primary checkout에서 첫 요청으로 worktree를 만들고, 첫 호출이 stage를 실행하지 않은 채 검증된 경로를 반환하는지 확인한다. 그 경로에서 두 번째 `codex exec`를 시작해 `spec-me`로 진입하는지 관찰한다. 실제 사용자 답변은 해당 worktree orchestrator 대화에서만 전달한다. 앱·모델 E2E는 별도 요청/실행 범위이며 관찰자의 승인 대행·실패 후 자동 재실행 금지와 source push 후 실제 consumer 갱신 순서를 유지한다.

- 용어/구형 경로의 작은 Luna 검증 결과와 한계는 `docs/verification/luna-workflow-check.md`에 기록했다. 임시 프로젝트는 세션 디렉터리의 tmp/에서 실행하며 별도 서버/인프라가 필요하지 않다. 프로젝트를 재사용할 때 실제 존재와 Git root를 확인하고 `npm test`를 실행한다. 이름만으로 이전 결과나 현재 상태를 신뢰하지 않는다.

- 기준 Node.js 버전은 `package.json`의 `engines`를 따른다. 저장소에는 상시 실행하는 server/DB가 없다.
- 계약 회귀 검사: 저장소 루트를 cwd로 `npm test`. 사용자 경로 live 검증과 별개다.

- Wake 연동은 이미 설정된 Codex Wake MCP 또는 활성 plugin의 설치된 MCP 설정을 사용한다. 설치·업데이트는 Wake 또는 marketplace를 설치하지 않으며, Claude는 Wake를 사용하지 않는다. Wake가 없으면 결과 전달은 listener 경로를 사용한다. 설치·업데이트, Doctor, provider 구분과 기존 Wake 전송 회귀는 `node --import ./tests/support/isolated-codex-home.mjs --test tests/provider_install.test.mjs tests/stage_result_events.test.mjs`로 검사한다.

  활성 로컬 marketplace에 등록된 Wake는 plugin 목록에 없어도 기존 패키지의 실행 파일과 checksum을 확인해 사용한다. 실행 파일이 없거나 checksum이 다르면 다운로드하지 않고 listener 경로를 사용한다. 설치된 Doctor는 lock에 없는 Git 추적 프로젝트 스크립트를 Harness 소유로 오인하지 않는다.

- setup 질문 배치·부분/역순/중복 응답·호출 ID 연결·취소 후 늦은 응답·GitHub/관측성 조건부 생략·최종 확인 전 파일 보존·설치/업데이트/Doctor/Git 가시성은 `node --import ./tests/support/isolated-codex-home.mjs --test tests/setup_configuration.test.mjs`로 검증한다. 실제 관측한 async UI 메시지 형식의 fixture와 로컬 Git/외부 명령 stub을 사용한다. 서버·인프라는 필요 없고 live UI 검증을 대신하지 않는다. 로그와 TMPDIR은 source session의 `runtime/setup-answer-check/` 아래에 둔다. 수신 경로와 rollout 대조의 근거는 [setup 답변 전달](../../.codex/skills/setup/references/answer-delivery.md)에 있다.

  UI 응답의 제목이 바뀌거나 잘려도 연결된 호출 ID와 항목 번호로 답변을 수신한다. 다른 폼의 늦은 답은 무시하며, 최종 확인은 표시된 설정 요약 전체를 검증한다.

  저장소 내부 session을 TMPDIR로 사용할 때는 임시 루트에 `package.json`으로 `{"type":"commonjs"}`를 기록한다. 확장자 없는 fake CLI의 `require`가 source 저장소의 `type: module`을 상속하지 않게 하기 위한 테스트 실행 전제다. 제품 package.json이나 fixture 코드를 바꾸지 않는다.
- 완료된 Spec·계획의 사용자 수정 재개 경로는 `tests/worktree_record_contract.test.mjs`에서 함께 검사한다.
- Spec 밖 동작의 사용자 결정 분기와 `basis` 인용 대조 검사는 `node --test tests/review_scope_guard.test.mjs`로 실행한다.
- implement-wrapper 최종 완료 gate가 정본 기록(리뷰 evidence·E2E receipt·tracker·제거 목록·checkpoint)에서 도출되는지는 `node --import ./tests/support/isolated-codex-home.mjs --test tests/implement_wrapper_completion.test.mjs`로 검사한다. 임시 consumer에 설치하고 계획 리뷰·plan별 코드 리뷰·`harness-exec.mjs` receipt·계약 seal을 실제 코드로 만든 뒤 상태 파일 없이 통과, 기록별 누락 차단, 직접 쓴 `passed: true` 무시, 설치·갱신·Doctor·Git 가시성을 확인한다. 서버·인프라를 띄우지 않는다.
- implement-wrapper의 순차 실행·통합 리뷰·최종 E2E 승인/실패 중단 지침 배포 검사는 `node --test tests/implement_wrapper_consumer.test.mjs`로 실행한다. 임시 consumer의 신규 설치·구버전 관리 자산 갱신·native 링크·Doctor 누락 진단·프로젝트 파일 Git 가시성을 확인한다. 서버·인프라나 실제 E2E를 실행하지 않는다.
- Harness eval 계약의 집중 검사는 `node --test '--test-name-pattern=loads versioned suite|reports measured and unmeasured|pilot suite loads|artifact outcome|pilot reports quality' tests/eval_contract.test.mjs`로 실행한다. 외부 서비스나 모델 인증은 필요하지 않다.
- 외부 consumer 설치/갱신 검증은 소유한 임시 디렉터리에서 Git 저장소를 만들고, 원본 저장소를 cwd로 `node bin/harness-install.mjs install --project <절대 consumer 경로>`, `node bin/harness-install.mjs update --project <동일 경로>`를 실행한다. 설치기는 Ponytail plugin 준비를 위해 Codex/network를 사용할 수 있으므로 실제 실행 권한과 의존성을 먼저 확인한다. 사용자 저장소에 `--force`를 적용해 검증하지 않는다.
- 진단: 원본 루트를 cwd로 `node bin/harness-doctor.mjs --project <consumer 경로> --json`. `passed`, diagnostics와 exit code를 함께 확인한다.
- workspace 검사: 검사할 저장소를 cwd로 `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <절대 worktree 경로> --json`. 관리형 spec-me는 등록된 linked worktree를 사용한다.
- suite 검증: 원본 루트를 cwd로 `node bin/harness-eval.mjs run --suite <설정된 suite ID>`. `.codex/harness.yaml`, suite manifests, 인증 및 recording profile을 확인하고 `evaluate-harness`를 따른다. 모델 실행 비용이 발생할 수 있으며 일반 suite를 blind 비교라고 부르지 않는다.
- 실제 E2E/end-user 시나리오는 `e2e-test`와 전용 runner로 실행한다. 생성한 임시 consumer/worktree와 소유 프로세스만 정리하며 결과 증거는 해당 세션 디렉터리에 둔다. worktree는 Git worktree 명령으로 제거하고 사전 존재 파일은 보존한다.

## 통합 계약 버전과 CI

대상 프로젝트의 `docs/contracts/{product.md,architecture.md,manifest.json,architecture.html,diagrams/}`와 `.github/workflows/harness-contracts.yml`, `.harness/contracts.mjs`는 Git에 포함한다. 설치 runtime `.codex/`가 ignore되어도 CI는 관리되는 독립 표준 라이브러리 checker `.harness/contracts.mjs`를 실행한다. 설치/갱신은 기존 사용자 수정 workflow/checker를 덮지 않고 conflict를 보고하므로 해당 conflict를 해결하기 전 완료하지 않는다.

```sh
node .codex/scripts/harness-contracts.mjs seal --root /absolute/project --summary '영향 기능과 모델을 검토하여 통합 계약 갱신'
node .codex/scripts/harness-contracts.mjs check --root /absolute/project --base-ref HEAD
```

설치 대상의 PlantUML 도구는 `.codex/tools/plantuml-{bootstrap,render}.mjs`, source repo는 `bin/` 아래에 있다. bootstrap의 고정 버전/SHA 검증 cache를 사용하고 renderer 호출 시 `--workspace`, `--jar`, `--sha256`를 명시한다. HTML은 로컬 브라우저에서 연다. 정적 파일이므로 별도 서버가 필요하지 않다.

`Harness contracts / contracts` Actions job은 PR head를 base commit과 비교하고 push에서도 직전 commit과 비교한다. secrets·쓰기 권한·외부 package 다운로드 없이 검사한다. Actions 비활성화나 필수 check 미설정은 코드가 강제할 수 없으므로 보호 브랜치에서 이 job을 required status check로 지정해야 merge 차단이 보장된다. workflow 완료 gate는 로컬에서도 별도로 적용된다. CI 버전은 [checkout](https://github.com/actions/checkout), [setup-node](https://github.com/actions/setup-node)의 공식 사용법을 기준으로 한다.

모든 실행은 시작 시 캡처한 `git rev-parse HEAD`의 SHA를 보존하고, 정상 종료 직전에 `node .codex/scripts/harness-workflow-complete.mjs --root /absolute/project --workflow spec-me --base-ref <starting-commit-sha>`를 실행한다. 소유 worktree의 ID와 원본 경로는 `<session_directory>/worktree.json`에서 읽는다. `spec-me`·`to-ticket`·`implement-wrapper`의 완료 evidence는 gate가 정본 기록(리뷰 history, 계획 snapshot, plan별 리뷰 evidence, E2E receipt, tracker 상태)에서 직접 읽으므로 상태 파일을 넘기지 않는다. `implement-wrapper`에서는 `--state`로 넘긴 `required_outcome`·`tests`·`reviews`·`retirement`·`evidence`·`plan_review`·`plan_set_id` 값을 무시하고 결과의 `ignored_state_keys`에 남긴다. 이 명령은 선언된 `before_complete` hook과 적용되는 `contract_docs`를 실행하고 `<session_directory>/runtime/workflow-completion/` journal에 verdict를 보존한다. 시작 SHA와 필수 evidence를 완료 입력에 포함한다.

워크플로우 조율 효율 회귀는 `node --import ./tests/support/isolated-codex-home.mjs --test tests/stage_result_events.test.mjs tests/intent_and_excess_guidance.test.mjs tests/plan_review_spec_paths.test.mjs tests/spec_author_runner.test.mjs`로 검사한다. 임시 consumer의 신규 설치·갱신, Doctor, Git 가시성, listener의 관찰 기록과 Wake 재전달 억제, reviewer 생성 전 필수 기록 검사를 포함한다. 실제 모델 workflow E2E를 대신하지 않는다.

## Tracker/Beads 공통 lifecycle 명령

새 tracker mirror를 연결한 뒤에는 개별 gh/bd status 명령 대신 다음 공통 명령을 사용한다. root는 실제 consumer worktree의 절대 경로이며 subprocess cwd도 같은 경로다. linked worktree에서는 Git common directory의 공유 Beads도 발견한다.

기존 mirror 유무와 관계없이 exact ticket 상태를 읽을 때는 다음 read-only 명령을 사용한다. GitHub는 설정된 repository와 issue number를 직접 조회하고 Project/field/item pagination이 불완전하면 누락으로 단정하지 않고 오류를 반환한다. local-markdown은 설정된 ticket 경로를 읽는다.

```sh
node .codex/scripts/harness-tracker.mjs read --root /absolute/project --ticket owner/repo#123
```

```sh
node .codex/scripts/harness-tracker.mjs check --root /absolute/project
node .codex/scripts/harness-tracker.mjs sync --root /absolute/project --ticket owner/repo#123 --status in-progress --phase implementation --classification committed
node .codex/scripts/harness-tracker.mjs sync --root /absolute/project --ticket owner/repo#123 --phase test
node .codex/scripts/harness-tracker.mjs sync --root /absolute/project --ticket owner/repo#123 --phase review
node .codex/scripts/harness-tracker.mjs sync --root /absolute/project --ticket owner/repo#123 --status completed
```

GitHub mode는 configured Project/Workflow Status의 네 option을 확인하고 exact Issue project item만 변경한다. 기본 Status나 Issue closure를 변경하지 않는다. local-markdown mode는 configured directory 안의 ticket YAML frontmatter 상태를 바꾸고 본문을 보존한다. Beads metadata는 `harness_tracker_version: 1`, `harness_phase`, `harness_classification`이다. 참조 누락·중복·상태/metadata 불일치·권한/API 실패는 오류다.

부분 성공은 `<session_directory>/runtime/tracker-sync/` journal에 기록한다. canonical을 rollback하지 않고 같은 `sync --ticket <ref>`를 status 없이 실행하면 최신 canonical 상태를 Beads에 반영한다. 실패 기록에 phase/classification이 있으면 같은 flag로 재전달한다. `check`는 외부 상태를 변경하지 않는다. workflow 시작 preflight·dispatch와 종료 명령은 tracker_sync를 실제 검사한다. legacy 데이터는 migration하지 않는다.

GitHub 보드 UI는 group-by/filter를 configured Workflow Status로 선택하고 기본 Status 열을 숨긴다. view 설정은 `gh project item-edit`의 상태 갱신과 별개이며 이 CLI는 지원하지 않는 view 변경을 수행했다고 보고하지 않는다. 기존 보드·item 데이터는 이번 변경으로 재작성하지 않는다.

이 저장소의 Beads `status.custom`은 빈 문자열로 설정해 backlog/test/review custom 상태를 제거했다. `bd statuses --json`에서 custom_statuses가 없는 것을 확인했다. Issue 데이터는 이동하지 않았다. 이 환경에서는 unset만 하면 이전 custom 목록이 다시 보였으므로 명시적으로 빈 값을 기록했다. Beads 내장 deferred/pinned/hooked는 도구 기능으로 남지만 Harness tracker lifecycle에는 사용하지 않는다.

## 세션 파일 출력 경계

모든 로그·stdout/stderr 저장본·checkpoint·JSONL·스크린샷·평가 결과·E2E manifest·임시 파일·복구 백업은 절대 `session_directory` 아래에만 쓴다. 다음 resolver로 경로를 구하며 `/tmp`, 저장소 루트, 임의 외부 경로를 사용하지 않는다.

```sh
node .codex/scripts/harness-session-output.mjs --root <workspace_root>
node .codex/scripts/harness-session-output.mjs --root <workspace_root> --path runtime/e2e/artifacts.json
node .codex/scripts/harness-session-output.mjs --root <workspace_root> --path tmp
```

Git 프로젝트는 `<git-common-dir>/harness-workflows/sessions/<workspace-hash>/`, 비Git fixture는 `<project>/.codex/sessions/<workspace-hash>/`를 사용한다. worktree 삭제 후에도 같은 세션 경로가 남는다. 기존 데이터는 자동 이전하지 않는다. 세션은 로컬 전용이며 commit·push·tracker에 게시하지 않는다.

모든 하위 agent/tool에 `workspace_root`와 `session_directory`를 명시한다. `tmp/`를 만든 뒤 각 subprocess에 `HARNESS_SESSION_DIR=<session_directory>`, `TMPDIR`, `TMP`, `TEMP=<session_directory>/tmp`를 전달한다. 서버 로그 redirect와 browser screenshot/trace/download/output directory도 resolver가 반환한 `runtime/<작업>/` 아래로 지정한다. 출력 위치를 지정할 수 없는 도구는 task 소유 artifact가 경계 밖으로 생기는지 확인하고, 제어할 수 없으면 실행을 멈추고 제약을 보고한다. 외부 도구 자체의 전역 cache/telemetry까지 OS sandbox로 차단하는 기능은 아니다.

승인된 source·Spec·통합 계약·렌더된 제품 다이어그램·지식 registry는 선언된 최종 프로젝트 경로에 둔다. Git/Beads 원장과 설치 관리 metadata는 각 도구의 관리 경로를 유지한다. 이것을 로그 출력 우회로 사용하지 않는다. 경로 탈출·symlink·공유 hardlink 출력 대상은 공통 resolver가 거부한다.

## 테스트·서비스 실행 계약

구현 선호사항과 테스트 실행 선호사항은 각각 활성 프로젝트 workspace의 `docs/agents/implementation-guidance.md`와 `docs/agents/testing-guidance.md`에 기록한다. 관리 worktree에서는 실행 중인 `workspace_root`의 추적 파일을 읽고 갱신한다. 이 파일은 workflow branch와 함께 review·push되므로 원본 checkout의 사본을 대신 사용하지 않는다. 구현 agent는 편집 전에 구현 지침을, 테스트·서비스 실행 runner는 실행 전에 테스트 지침을 읽는다. 구현 agent도 검증을 실행할 때 테스트 지침을 함께 읽는다. 지침이 승인된 Spec이나 실행 계약과 충돌하면 진행하지 않고 호출자에게 보고한다.

일반 단위·회귀 검증은 아래 프로젝트별 명령을 저장소 루트에서 기본 CLI로 직접 실행한다. `docs/agents/execution.json`과 `harness-exec`는 명시적 사용자 흐름 E2E에만 사용하며, 이 저장소에는 현재 그런 E2E profile이 없다. E2E profile을 추가할 때는 `purpose: "e2e"`와 실제 실행 준비/readiness 검증을 포함한다.

```sh
node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile <e2e-profile-id>
```

E2E 실행기는 매번 workspace 확인 → 필수 환경값과 전체 argv 확인 → 설정 준비 → 설정 검증 → 인프라 readiness → 설정 변경 재확인 → 정확한 command를 수행한다. 이전 실행의 준비 완료 receipt를 재사용하지 않는다. 같은 E2E profile의 prepare도 매번 실행한다. E2E profile이 누락되면 E2E 실행을 중단한다. 필요한 명령 변경은 프로필과 이 문서를 함께 갱신한다.

`runtime/execution/<profile-id>-<run-uuid>/receipt.json`은 본 command 직전의 `head`(실행한 commit)와 `uncommitted_paths`(그때 커밋되지 않았던 변경), `started_at`·`finished_at`, `config_hashes`를 기록한다. `implement-wrapper` 완료 gate는 이 receipt로 최종 E2E를 판정한다: 각 profile의 마지막 verdict(`passed`/`failed`) receipt가 통과이고, `head`가 현재 HEAD 또는 그 조상이며, 그 이후 문서(`docs/`, `CONTEXT*.md`, `.harness/contracts.mjs`)가 아닌 파일 변경이 없고, `config_hashes`의 파일이 그대로여야 한다. `head`가 없는 이전 receipt는 증명으로 쓰지 않으므로 profile을 다시 실행한다.

### 프로필 계약

- `schema_version: 1`, `profiles.<id>`를 사용한다. E2E가 없으면 `profiles`는 빈 객체다. profile은 `purpose: "e2e"`로 표시하며 ID는 영숫자·`_`·`-`다.
- `command`: 정확한 실행 파일과 필수 인자를 담은 argv 배열. `--config`, profile/env, port, host, URL 등이 필요하면 여기서 명시한다. 문자열 shell 조립은 하지 않는다. `${PORT}` 같은 환경값은 개별 argv 안에서 치환되며 빈 값은 시작 전에 차단한다. 비밀은 가능한 한 인자 대신 환경변수로 전달한다.
- `required_env`: 비어 있으면 안 되는 환경변수 이름. 실행기의 process 환경을 사용하며 자동 기본값을 추정하거나 기존 `.env`를 암묵적으로 읽지 않는다. dotenv가 필요한 프로젝트는 사용하는 실행 파일과 파일 선택 인자를 command에 명시하고 verify_config에서 실제 로딩 결과를 확인한다.
- `config_inputs`: 실제 설정 원본·환경 파일·생성 설정·실행 recipe의 workspace 상대 파일 경로. 최소 한 개가 필요하다. prepare 후 파일 hash를 기록하고 prepare 완료 후 검증/readiness 도중 변경되면 시작하지 않는다. manifest 자체도 함께 추적한다. 값이나 secret은 receipt에 저장하지 않는다.
- `prepare`: 설정 생성/동기화 등 **재실행 가능한** 준비 명령 argv의 배열. 프로젝트가 필요한 설정 갱신을 여기서 수행한다. 필요 없으면 `[]`를 명시하고 이 문서에 근거를 남긴다. destructive migration/reset은 준비 명령으로 자동 추가하지 않는다.
- `verify_config`: 하나 이상의 실제 설정 검증 argv. 실행 대상·환경·port·DB/queue URL·생성 결과가 현재 원본과 일치하는지 프로젝트 도구로 확인하고, 다르면 nonzero로 종료한다. 단순 파일 존재나 오래된 receipt 확인은 설정 최신성 검증을 대신하지 않는다.
- `dependencies`: `{ "id": "postgres", "check": ["project-readiness-command", "--target", "${DATABASE_URL}"] }` 목록. 해당 서비스/테스트가 실제 사용하는 인프라·선행 서비스 전체를 기록한다. 단순 port 열림 대신 인증·DB/schema·필요 queue 등 목적에 맞는 readiness를 확인한다. timeout까지 실패하면 command를 실행하지 않는다. 의존성이 없을 때만 `[]`와 근거를 남긴다.
- `timeout_ms`, `readiness_timeout_ms`, `poll_interval_ms`: 양의 정수. 실제 서비스의 준비 시간과 테스트 제한에 맞춘다.

인프라가 없다면 지정된 인프라 실행 프로필을 먼저 띄우고, 해당 프로세스를 유지한 채 서버/테스트 프로필을 실행한다. 실행기는 누락된 인프라를 임의 설치·대체·초기화하지 않는다. 인프라 자체도 별도 프로필로 정확한 config/profile/서비스 선택 인자를 고정한다. 서버 프로필에는 인프라 readiness, E2E 프로필에는 인프라와 대상 서버 readiness를 모두 둔다. foreground 실행을 사용하며 detach하는 daemon 명령은 사용하지 않는다. 외부에서 이미 관리 중인 인프라는 check만 수행하며 종료하지 않는다.

실패·timeout·취소에서는 실행기가 자신이 시작한 process group을 종료한다. 이 실행기가 시작하지 않은 서버/인프라를 지우지 않는다. SIGKILL/전원 종료 시 정리는 보장하지 못하므로 다음 실행에서 소유 프로세스를 확인한다. 로그·단계 결과·설정 hash는 session_directory/runtime/execution/<profile-id>-<run-id>/에 보존한다. 테스트 실패는 failed, 준비 실패는 blocked로 구분하며 정상 준비로 간주하지 않는다.

이 저장소의 일반 Node.js 검증은 `package.json`의 기본 CLI 명령과 최소 Node 버전을 사용한다. 임시 Git/file fixture만 사용하므로 별도 서버·DB profile은 없다. 이 사실을 서비스가 있는 소비 프로젝트의 무인프라 근거로 사용하지 않는다.

### 유지보수 책임

일반 검증 명령이 바뀌면 EXEC를 고친다. E2E의 인자·환경·인프라·설정 파일이 바뀌면 E2E profile·EXEC를 함께 고친다. 리뷰는 실제 entrypoint, compose/manifest, config loader, CI와 대조해 의존성 목록·필수 인자·최신성 검증의 충분성을 확인한다. 공통 실행기는 선언한 프로필의 준수를 강제하지만 누락된 비즈니스/인프라 요구 자체를 코드만으로 추론하지는 않는다. 직접 shell 실행을 OS 차원에서 금지하는 sandbox도 아니다.

설정 prepare가 생성 설정을 의도적으로 바꾸는 것은 허용한다. hash 기준점은 prepare 완료 직후이며, 그 이후 verify_config/readiness 중 변경을 차단한다. POSIX에서는 process group 전체를 정리하고 native Windows에서는 직접 child만 종료하므로 descendant 정리 보장이 필요한 실행은 WSL/POSIX를 사용한다.

## Fresh Spec 리뷰 검사

`spec-review-check` profile은 Spec·계획 리뷰의 중복 실행·입력 고정·재검토 한도, Spec 리뷰 후 diagram stage 순서, 최종 diagram 산출물 gate, 설치·업데이트된 CLI와 Git 가시성 회귀 검사를 실행한다. 임시 Git/file fixture만 사용하여 별도 서버/DB·생성 설정이 없으며 prepare/dependencies는 빈 배열이다. `node --test tests/spec_review.test.mjs tests/contracts.test.mjs tests/workflow_loader.test.mjs tests/workflow_system_targets.test.mjs tests/plan_review.test.mjs tests/installer_update.test.mjs`로 실행한다.

reviewer snapshot은 `harness-spec-review.mjs snapshot --root <workspace_root> --ticket <id> --axis product|architecture [--input <직접 읽은 source/ADR 상대 파일>]`로 구한다. raw request/확정 사용자 답변은 ticket의 request.md에 보존한다. caller는 실제 각 reviewer JSON과 spawn metadata를 session/runtime/spec-reviews/에 attempt별 저장한다. `harness-spec-review.mjs check --root <workspace_root> --ticket <id> --reviews <session-relative-json>`가 최신 전체 리뷰를 검사하며 completion state에는 ticket_id/spec_reviews를 전달한다. source/Spec/diagram/용어/계약 갱신 후에는 이전 pass를 재사용하지 않는다. canonical 내용은 최종 fresh 리뷰 전에 안정화하고 seal의 기계 산출물 갱신 후 완료 gate를 실행한다. Architecture 리뷰 history는 재개·session 교체를 넘어 유지되며 substantive 회차는 최초 1회+재검토 최대 2회다. pre-dispatch 준비 실패만 최대 3회 abort로 기록할 수 있고, dispatch 이후 누락·중단·기록 실패는 회차를 소비하며 임의 receipt나 history 없는 legacy 결과로 완료하지 않는다. pre-dispatch abort 3회 뒤에는 복구 후 `resolve --reason 'preparation recovery: <복구 내용>'`으로 재개하고, substantive 3회를 소진하면 사용자 범위·결정 변경을 기록한 `resolve` 전에는 시작하지 않는다. Claude Code의 PreToolUse Agent hook이 유일한 활성 attempt에 대한 spec_adversarial_reviewer 위임을 허가하고 identity를 prompt에 주입한다. Reviewer의 실제 마지막 assistant 응답은 필수 필드가 있는 JSON으로 반환해야 native SubagentStop 기록과 대조할 수 있다.

## 설치·업데이트 회귀 검사와 스킬 갱신

native `.codex/hooks.json`의 `UserPromptSubmit`에는 `harness-orchestrator-hook.mjs`가 등록된다. 명령 hook은 canonical `worktree.json`·같은 Codex session ID의 orchestrator 상태와 Git worktree 등록·경로·branch를 읽기 전용으로 대조하고 `resume_candidate`, `compose_candidate`, `inspect_required`를 전달한다. 기록 생성·legacy 이전·복구·Git 변경은 수행하지 않는다. 새 요청 여부는 메인이 메시지와 관측 상태를 함께 보고 판단하며, 생성 작업은 workflow-compose subagent에 맡긴다. installer는 다른 hook을 보존하고 해당 등록만 동기화하며 변경 전 설정을 session에 백업한다. Doctor가 등록 누락·손상을 진단한다. Claude Code provider 설정은 `PreToolUse`의 Agent admission과 lifecycle hook을 설치하며, `harness-agent-admission.mjs`는 reviewer dispatch를, `harness-agent-event.mjs`는 native 시작/종료 identity와 최종 응답 기록을 담당한다. 두 CLI script는 managed assets로 fresh install/update되며 Doctor 필수 자산으로 검사된다. 새 Codex hook은 `/hooks`에서 신뢰 검토를 거쳐야 실행된다. protocol·신뢰 규칙은 [공식 hook 문서](https://learn.chatgpt.com/docs/hooks)를 따른다.

setup은 사용자에게 확인한 context window·plan 최대 예상 토큰·인계 예비 토큰을 프로젝트 소유 `.codex/context-budget.json`에 저장한다. `harness-skill-execution.mjs budget --root <workspace_root> --estimate <tokens> [--used <observed-tokens>]`은 이 파일의 기준과 hash를 반환한다. 예상치와 관측 사용량을 구분하며 사용량이 없으면 runtime 판정을 반환하지 않는다. Doctor는 존재하는 budget 파일의 정합성을 검사하고 installer는 해당 설정 파일을 덮어쓰지 않는다.

`model-binding-check`는 공개 skill의 binding 등록과 설정·workflow tier inventory를 검사한다. `internal-skills-check`는 skill 설치·업데이트·Doctor·Git 가시성, model/effort binding, 작은 반환 envelope와 파일 기반 결과 검증을 포함한다. `harness-skill-execution.mjs binding`은 실제 설정을 해석하고 `validate-return`은 session의 입력·반환·상세 결과·산출물을 대조한다. 이 명령들은 agent를 생성하거나 외부 tracker를 변경하지 않는다. orchestrator skill이 실제 spawn 도구와 기존 workflow lifecycle을 사용한다.

Installer/Doctor/exclude Node 회귀 검사는 `node --test`로, Python CLI 검사는 `python3 -m unittest`로 직접 실행한다. 로컬 Git/file fixture와 외부 명령 stub만 사용하며 임시 consumer·backup·로그는 세션 안에 둔다.

의도·충분한 수준에 따른 범위 제한은 `node --import ./tests/support/isolated-codex-home.mjs --test tests/intent_and_excess_guidance.test.mjs tests/review_scope_guard.test.mjs tests/implement_wrapper_consumer.test.mjs tests/legacy_installer_update.test.mjs`로 검사한다. 임시 `CODEX_HOME`을 세션 내부에 지정한다. 기능·규칙별 의무 목적 질문 제거, 출처를 표시한 요청 해석 허용, 필수 작업 기준의 단계 간 연결, fresh install/update된 지침·gate·Doctor inventory와 프로젝트 변경의 Git 가시성을 검증한다. 실제 모델의 질문 품질과 범위 판단은 이 회귀 검사로 증명하지 않는다.

install/update 모두 같은 관리 자산 동기화를 사용한다. 관리 스킬과 refs/scripts는 기본 갱신에서도 기존 내용을 session/runtime/installer-backups/<id>/에 먼저 백업한 뒤 교체한다. `--force`는 스킬을 포함해 선택된 나머지 관리 자산의 로컬 변경도 백업 후 교체한다. agent, workflow/runtime, 관리 CI·PR template 등 나머지 자산은 기본적으로 로컬 변경을 보존한다. 재설치로 lock을 먼저 다시 만들거나 개별 스킬을 수동 복사하지 않는다. partial install은 다른 scope의 baseline을 유지한다. `.codex/harness.yaml`은 프로젝트 소유이므로 force에서도 변경하지 않는다. upstream에 없는 lock 항목은 원장만 정리하고 기존 파일은 보존한다.

doctor의 eval.permission_profile은 Harness 실행 event의 식별자이며 native profile 존재 증명이 아니다. 실제 eval 호출의 --sandbox와 sandbox_workspace_write.network_access 정책을 검증하고, eval.codex.command의 --permission-profile/-P 및 agent의 명시적 permission_profile 참조가 있으면 native inventory를 별도로 확인한다. 명시적 native 참조 누락/미검증과 위험하거나 모순된 sandbox/network 설정은 계속 실패한다. [공식 CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli)와 [설정 reference](https://learn.chatgpt.com/docs/config-file/config-reference)를 근거로 내부 label과 실제 native 설정을 구분한다.

## 구현 준비 회귀 검증

`node --test tests/project_readiness.test.mjs tests/execution.test.mjs tests/doctor.test.mjs tests/installer_update.test.mjs tests/installer_exclude.test.mjs tests/wrapper_dispatch.test.mjs`는 실행 프로필/통합 계약 누락·형식 오류·정상 bundle과 doctor/설치 회귀를 검사한다. Node 내장 테스트와 임시 Git fixture만 사용하므로 별도 서버·인프라·prepare는 필요 없다. fixture와 로그는 세션 경로에 저장한다. `tracker-lifecycle-check`는 tracker lifecycle/CLI 회귀, `plan-review-check`는 검토 snapshot의 현재성과 dispatch gate 회귀를 실행한다. 구현 준비 시 source snapshot drift만 마지막 통합 계약 동기화까지 지연하며, 계약 bundle 오류와 실행 준비 실패는 계속 차단한다. 프로젝트 진입 점검은 `harness-workspace-preflight.mjs --workspace-root <workspace_root> --for-implementation --json`으로 실행하며 명령을 시작하지 않는다.

## E2E 실패의 재발 방지

E2E caller/runner는 `.codex/internal-skills/e2e-test/references/failure-learning.md`를 따른다. raw 증거는 세션 `runtime/e2e/<run_id>/`에 시도별로 보존하고, 확인된 재발 방지 지식은 소비 프로젝트의 `docs/verification/e2e-lessons.md`와 실제 EXEC/execution.json·회귀 검사에 반영한다. 다음 실행 전에 관련 현행 lesson과 예방 검사를 읽는다. checkpoint의 `tests.e2e_failures`는 실패 ID별로 유지하고, 원본 증거는 교체하지 않으며 예방 조치/재검증이 없는 항목은 테스트 요약이 passed여도 완료하지 않는다.

`e2e-learning-check`는 Node 내장 fixture 테스트로 실패 이력 보존, 테스트 성공/학습 pending의 분리와 현재 테스트 실패의 lifecycle/wrapper 완료 차단을 검증한다. 실제 앱·서버·DB를 시작하지 않으므로 dependencies/prepare가 없으며 임시 fixture와 로그는 세션 내부에 둔다.

## 명세·계획·구현 추적 회귀 검사

`node --test tests/plan_review.test.mjs tests/wrapper_dispatch.test.mjs tests/workflow_worktrees.test.mjs tests/workspace_preflight.test.mjs`로 Product/Architecture Spec과 전체 canonical plan의 독립 리뷰 current-input snapshot, impact report, dispatch gate를 검사한다. 별도 요구사항 inventory나 검증 파일 대응표는 만들지 않으며 테스트 계약은 각 plan 본문에 둔다. Node 내장 fixture만 사용하며 서버·DB·prepare는 필요 없다. 임시 저장소와 실행 evidence는 세션 경로 아래에 생성한다. 연결된 문장의 의미상 충족 여부와 profile 명령의 실제 테스트 실행 여부는 독립 plan review가 확인한다.

## VictoriaLogs 개발 관측성 설치

setup CLI는 OpenTelemetry Collector·VictoriaLogs·VictoriaMetrics 사용 여부, 로그/메트릭 포트와 보존 일수, OTLP HTTP 포트, 프로젝트/서비스별 앱 기준 metrics_url·컨테이너 기준 scrape_url을 터미널에서 수집한다. `harness-victorialogs.mjs setup`이 compose·otel-collector.yaml·scrape.json·개발 Spring config·otel-javaagent.properties·공식 MCP 두 개·활성 workspace 지침을 준비한다. 기본 포트는 9428/8428/4318이고 저장소 보존은 각각 7일이다. 기본 compose bridge를 사용한다. host에는 127.0.0.1:<설정 port>만 publish하고 내부 listener는 0.0.0.0:4318/9428/8428이다. 앱→Collector는 공개 localhost, Collector/MCP→backend는 compose service DNS, Metrics→WSL 앱은 scrape_url의 host.docker.internal:<실제 port/path>로 연결한다. Desktop host networking 활성화나 WSL gateway IP에 의존하지 않는다. Collector는 native OTLP LogRecord를 받아 VictoriaLogs OTLP HTTP endpoint로 protobuf export한다. Vector·Fluent Bit은 설치하지 않고 session JSON 파일을 tail하지 않는다. `victorialogs-local-setup`이 실제 source의 개발 SDK/appender 또는 외부 Java agent와 Actuator/Prometheus registry를 연결한다. production artifact에서 개발 의존성을 제외하고 SDK/agent 중복 전송을 막는다. 기본 관리 명령은 `harness-victorialogs.mjs start|check|stop`으로 직접 실행한다. 최종 사용자 흐름 E2E만 별도 E2E profile을 사용한다. check는 세 API readiness이며 실제 수집은 앱 로그 검색과 project/service별 최신 up=1로 별도 확인한다. 이 Node 원본에는 Spring 앱이 없으므로 설치 fixture·오프라인 진단 검사와 설정 검증 범위를 보고하고 실제 앱 수집을 확인한 것으로 쓰지 않는다.

공식 MCP Docker 이미지는 stdio client subprocess로 필요 시 실행한다. 전역 provider 설정은 자동 수정하지 않으며 SigNoz marketplace 자동 등록은 제거한다. 관리 lock으로 식별된 폐기 skill만 session backup 후 제거하고 기존 사용자 데이터와 전역 plugin은 유지한다. 데이터/offset은 원본 프로젝트 session directory, linked-worktree 로그는 같은 Git common directory의 sessions에서 수집한다. Docker daemon과 Compose v2가 전제이며 서버·이미지 pull·Spring 앱을 검증 명목으로 자동 실행하지 않는다.

## Spring Boot diagnostic v1 검증

`diagnostic-log-check`는 사용자 v1의 일곱 이벤트, 필수 Resource/Attributes, outcome·숫자/boolean·Trace ID·timestamp 및 offline JSONL CLI를 집중 검증한다. `node --test tests/diagnostic_logs.test.mjs`를 사용하며 Docker/앱/인프라는 필요하지 않다. 소비 프로젝트 setup은 스키마·예시·수집 매핑과 workspace별 구현/테스트 메모리를 설치하고 `victorialogs-diagnostic-logs` profile을 생성한다. 그 profile의 HARNESS_DIAGNOSTIC_LOG_FILE은 실제 emitter 원본 JSONL 경로다. 원본 타입 검사와 VictoriaLogs 저장 후 string 표현을 구분한다. 일반 unit 검증이나 실패 학습을 이유로 E2E를 추가 실행하지 않는다.


## Beads 자동 백업의 table file 누락 복구

`auto-backup failed ... .beads/backup/<table-file>`가 발생하면 작업 상태 변경 성공과 백업 실패를 구분한다. 운영 DB를 재초기화하거나 원격 sync/migration으로 우회하지 않는다.

1. `bd export --output <session_directory>/runtime/beads-before-repair.jsonl`로 읽기 가능한 이슈를 보존하고 `bd backup status --json`, `.beads/backup/manifest`와 실제 파일을 대조한다.
2. manifest가 참조하는 table file이 없으면 손상된 `.beads/backup/` 전체를 `<session_directory>/runtime/beads-recovery/`에 보존한다. 운영 `.beads/embeddeddolt/`는 건드리지 않는다.
3. 로컬 Dolt-native 복구 사본은 `bd backup init <session_directory>/runtime/beads-recovery/backup`과 `bd backup sync`로 생성할 수 있다. 이 명시적 destination과 `.beads/backup/`의 자동 백업은 별도이므로 한쪽 성공만으로 다른 쪽 복구를 주장하지 않는다.
4. 자동 백업은 손상 저장소를 보존해 옮긴 뒤 정상 Beads 쓰기에서 재생성되는지 확인한다. 재현 검증 때문에 `backup.interval`을 일시 변경했다면 원래 설정으로 복구한다. 후속 자동 백업의 경고 부재와 `backup_state.json`의 commit/timestamp 갱신을 모두 확인한다.
5. 복구 후 다시 export해 이슈 ID와 비대상 이슈 내용을 비교한다. 명시적 backup sync도 재확인한다. 백업 실패를 숨기기 위해 `backup.enabled`를 끄지 않는다. 별도 원격 백업·이전·복원은 이 절차의 범위가 아니다.

### WSL·Docker Desktop 네트워크 검증 근거

2026-10-22 임시 nc HTTP listener의 컨테이너 내부 token 응답을 확인한 뒤 WSL→bridge localhost 공개 port와 bridge→WSL loopback 앱의 host.docker.internal 접근을 검증했다. 초기 Alpine httpd 검사는 해당 binary가 없어 서버가 뜨지 않았으므로 연결 실패 근거에서 제외한다. host network에서 WSL localhost와 Docker host localhost가 같다고 가정하지 않는다. probe는 session 내부의 실행 profile로 수행하고 임시 container/listener를 finally에서 제거한다.

같은 검증 세션에서 실제 OpenTelemetry Collector·VictoriaLogs·VictoriaMetrics를 bridge로 실행했다. WSL synthetic OTLP LogRecord → Collector → VictoriaLogs의 operation ID 검색과, Metrics → WSL loopback 임시 Prometheus endpoint의 up=1을 확인했다. 실제 Spring emitter·Java agent·MCP handshake 검증은 아니다. 임시 compose 스택·listener는 종료 후 제거했고 데이터·receipt는 session 안에 보존했다.

## Codex native setup UI

`$setup`은 요청마다 session 내부 `runtime/setup/<setup-id>/answers.json`을 새로 만들고 `node .codex/scripts/harness-setup.mjs --root <workspace_root> --answers <절대 session JSON 경로>`를 실행한다. 재사용 시 유효한 설정은 보존하고 누락·오류 항목만 묻는다. `needs_input`은 현재 조건이 확정된 배치만 반환하며 GitHub의 로컬 계획 디렉터리나 관측성 끔의 상세 설정은 생략한다. 스킬은 `ui_questions`를 그대로 표시하고 실제 대화 rollout을 `--bind-ui`로 연결한 뒤 항목별 응답 원문을 `--receive`로 즉시 전달한다. CLI는 setup·배치·호출·항목 대응과 누적 답을 session에 기록하고 누락 ID를 계산한다. `--status`가 `can_continue: true`일 때 추가 입력을 요구하지 않고 다음 배치를 조회하며, 최종 확인 전 프로젝트 설정·준비 파일은 쓰지 않는다. 중단·진행 금지는 `--cancel`로 기록하고 늦은 폼 응답으로 재개하지 않는다. 일반 workflow는 `--check`로 현재 설정을 읽기 전용 검사해 유효하면 setup 없이 계속한다. 수동 terminal CLI는 유지한다. 상세 절차는 [설정 선택](../../.codex/skills/setup/references/native-choices.md)을 따른다.

## 구현 리뷰 회귀 검사

`implementation-review-check` profile은 plan별 영속 수정 한도, 재개·worktree 교체, 지적 분류, 중간 plan과 최종 계약 gate, 설치·업데이트된 CLI와 Git 가시성, 읽기 전용 통합 리뷰 조회, 양쪽 결과 수집과 planning snapshot 변경 차단을 검사한다. 수정 한도 reset은 새 독립 계획 리뷰와 dispatch를 통과한 planning snapshot 변경이 있을 때만 허용하고, 일반 진행 지시로는 초기화되지 않는지도 검사한다. 임시 Git/file fixture를 사용하며 별도 서버·DB와 생성 설정이 없어 prepare/dependencies는 빈 배열이다. `node --test tests/wrapper_repair.test.mjs tests/review_status.test.mjs tests/session-output.test.mjs tests/wrapper_dispatch.test.mjs tests/wrapper_reconciliation.test.mjs tests/wrapper_checkpoint.test.mjs tests/plan_review.test.mjs tests/installer_update.test.mjs tests/tracker_contract.test.mjs`로 실행한다.


### 소비자 테스트 저장소의 workflow 재실행

Claude Code를 비대화식 메인 orchestrator로 실행하거나 기존 Claude 대화를 재개할 때는 대상 저장소 또는 worktree를 cwd로 두고 `node .codex/scripts/harness-claude-orchestrator.mjs '<요청>'` 또는 `node .codex/scripts/harness-claude-orchestrator.mjs --resume '<session-id>' '<계속할 요청>'`을 사용한다. 이 실행기는 매번 `claude -p --permission-mode bypassPermissions`를 명시한다. 메인 Claude의 승인 확인을 우회하므로 사용자가 승인한 작업에만 사용한다. 각 workflow stage의 sandbox와 permission mode는 별도 실행기·profile이 계속 결정한다.

사용자가 소비자 workflow 재실행을 요청하면 `/home/jiwoo/workspace/harness-test`가 Git `main`의 clean 상태인지, 설치된 Harness 버전과 Doctor 결과가 적절한지 먼저 확인한다. 기존 linked worktree 정리는 명시적으로 요청된 경우에만 수행한다. 삭제 전 각 worktree의 tracked·untracked 변경과 `.io`를 포함한 전체 내용을 백업하고 백업을 검증한다. 다른 저장소의 worktree는 건드리지 않는다.

workflow-compose는 Git 공통 디렉터리의 `.git/harness-reservations/`에 lock을 만들고 linked worktree를 생성한다. 이 테스트의 **상위 `codex exec`는 쓰기 제한이 없는 환경에서** `--sandbox danger-full-access`로 실행한다. 바깥 sandbox가 Git 공통 디렉터리 쓰기를 막으면 이 옵션만으로 해제되지 않으므로 실행 전 쓰기 가능 여부를 확인하고, 막혀 있으면 재시도나 상태 수정 없이 사유를 보고한다. stage 실행은 각 스킬의 기존 실행 계약을 따른다.

이 테스트에서는 `.codex/hooks.json`의 Harness hook이 신뢰되지 않으면 `codex exec`의 JSON `thread.started`에 ID가 있어도 orchestrator 대화에 startup hook의 `codex_session_id`가 전달되지 않을 수 있다. 2026-11-02 Codex CLI 0.166.0에서 일반 실행은 hook 관측값이 없었고, 같은 진단에 `--dangerously-bypass-hook-trust`를 추가하면 hook 관측의 ID가 `thread.started.thread_id`와 일치했다. 테스트 전에 hook 명령과 내용을 검토하고 Codex의 `/hooks`에서 신뢰를 승인한다. 명시적으로 검토한 자동화에서 신뢰 설정을 사용할 수 없다면 상위 `codex exec`에만 `--dangerously-bypass-hook-trust`를 추가할 수 있다. 이 옵션은 활성 hook 전체의 신뢰 확인을 우회하므로 검토하지 않은 hook이 있으면 사용하지 않는다. 로그의 `thread.started`만으로 hook이 실행됐다고 판단하거나 ID를 임의 주입하지 않는다.

## Harness workflow E2E 정본 시나리오

2026-11-05 사용자 지시: Harness를 테스트하라고 요청받으면 아래 black-box E2E를 기본 실행한다. 단위 테스트·설치 fixture·eval replay로 대체하지 않는다. 테스트 대상·원문 프롬프트·시작/종료 단계를 임의로 줄이거나 다른 작은 기능으로 바꾸지 않는다.

1. Harness 소스의 승인된 변경을 커밋하고 configured upstream에 push한다. 원격 branch에서 해당 commit이 조회되는지 확인한 뒤 `/home/jiwoo/workspace/harness-test`의 Harness를 갱신하고 Doctor를 확인한다.
2. 사용자가 기존 worktree 삭제를 요청한 경우 테스트 저장소에 등록된 linked worktree 전부를 조사한다. 각 경로의 HEAD·branch·Git status·전체 tracked/untracked/ignored 내용과 `.io`를 source session에 백업하고 hash를 검증한 뒤 제거한다. primary checkout과 다른 저장소는 삭제하지 않는다. 새 테스트가 만든 worktree는 종료 뒤 산출물 검증을 위해 보존한다.
3. `/home/jiwoo/workspace/harness-test`가 `main`이고 `git status --short`가 빈 상태인지 확인한다. 시작 HEAD, 설치 버전/lock hash, 실행 설정과 hook 내용을 기록한다. 설정이 다른 provider여도 아래 명시적인 Codex workflow binding으로 전체 테스트를 고정하고 consumer 설정을 임의로 바꾸지 않는다.
   실행 환경은 이 문서의 아래 값을 정본으로 사용한다. 최초 실행과 두 번째 실행뿐 아니라 질문 후 `codex exec resume`을 포함한 **각 독립 shell**에서 매번 아래 환경을 export하고, 실제 session 경로와 binding이 일치하는지 확인한 뒤 실행한다. workflow 생성 전 질문에서 중단된 경우에도 resume에 binding이 필요하다. 별도 환경 파일은 만들지 않는다.

   ```bash
   export HARNESS_WORKFLOW_BINDING='{"provider":"codex","model":"gpt-6-luna","reasoning_effort":"medium"}'
   export HARNESS_SESSION_DIR='<session resolver로 확인한 절대 session_directory>'
   export TMPDIR="$HARNESS_SESSION_DIR/tmp" TMP="$HARNESS_SESSION_DIR/tmp" TEMP="$HARNESS_SESSION_DIR/tmp"
   node -e 'const p=require("node:path"),e=process.env,b=JSON.parse(e.HARNESS_WORKFLOW_BINDING); if(b.provider!=="codex" || b.model!=="gpt-6-luna" || b.reasoning_effort!=="medium" || !p.isAbsolute(e.HARNESS_SESSION_DIR) || [e.TMPDIR,e.TMP,e.TEMP].some(x=>x!==p.join(e.HARNESS_SESSION_DIR,"tmp"))) process.exit(1)' || exit 1
   mkdir -p "$TMPDIR" || exit 1
   ```
4. 아래 첫 `codex exec`를 테스트 저장소 workspace에서 실행한다. 프롬프트 원문은 `$orchestrator 계산기 웹 앱 만들어. 유저 인증과 커뮤니티 기능 있어야 해`다. 같은 기능의 기존 worktree가 있으면 이어가기와 새 workflow 선택 질문을 기대하며 관찰자가 답을 만들지 않는다. 실제 사용자가 새 시작을 선택하면 이번 생성 명령의 execution ID와 worktree 참조를 생성 전 Git 목록·canonical `worktree.json`·요청 binding과 대조한다. 관련 후보가 없으면 새 workflow가 준비되는지 확인한다. 응답 경로가 없거나 검증이 실패하면 추정 경로를 만들어 진행하지 않는다.
5. 반환된 worktree를 workspace로 두 번째 `codex exec`를 실행하며 프롬프트 원문은 `$orchestrator 계속 진행해`다. `spec-me`로 진행하는지 확인하고 정상 workflow의 계획·구현 경로를 관찰한다. implement 단계를 정상적으로 마치면 다음 제품 E2E를 시작하지 않고 멈춘 뒤 산출물을 검증한다.
6. 실행 중단·오류·사용자 질문·승인 대기 시 테스트 관찰자가 답변이나 위임을 만들거나 상태·Spec·plan·코드·설정을 수정하거나 재실행해 넘기지 않는다. 실제 중단 원문과 시점, stage, session, 실패 증거를 보존하고 사용자에게 보고한다. 자동 승인이 없는 한 성공을 위해 gate를 우회하지 않는다. 두 명령 이외 추가 진행 요청은 사용자의 실제 답변이나 명시적 지시가 있어야 한다.
7. 첫 실행의 workflow 생성과 응답 위치, 두 번째 실행의 spec-me 진입, Product/Architecture Specs·독립 리뷰, tracker의 전체 split plan·상태, plan별 commit/단위 테스트/코드 리뷰와 통합 리뷰, implement 완료 receipt와 남은 gate를 직접 확인한다. 파일 존재나 agent의 성공 문구만으로 구현 완료를 판정하지 않는다. 실패 시 자동 수정하지 않고 증거와 미검증 범위를 보고한다.

```bash
codex exec --json --model gpt-6-luna -c 'model_reasoning_effort="medium"' -c 'approval_policy="never"' --sandbox danger-full-access \
  -C /home/jiwoo/workspace/harness-test '$orchestrator 계산기 웹 앱 만들어. 유저 인증과 커뮤니티 기능 있어야 해'

codex exec --json --model gpt-6-luna -c 'model_reasoning_effort="medium"' -c 'approval_policy="never"' --sandbox danger-full-access \
  -C '<첫 응답으로 받은 생성 worktree 절대경로>' '$orchestrator 계속 진행해'
```

workflow 생성 전 질문에서 중단됐다면 아직 canonical binding이 없으므로 후속 resume에도 위 환경을 반드시 전달한다. 생성 후에는 `worktree.json`의 binding과 위 환경이 일치하는지도 확인한다. 두 명령의 원문 요청에 임의 요구나 자동 승인 문구를 덧붙이지 않는다. 위 사용자 지정 black-box 검증은 전용 `e2e_test_runner`가 실제 `codex exec`를 직접 실행한다. 일반 앱 E2E profile로 대체하거나, observer가 Harness 내부 stage CLI를 직접 호출해 경로를 조립하지 않는다. 검토한 hook에 대해서만 위의 `--dangerously-bypass-hook-trust`를 추가할 수 있다. 실행 환경의 session TMPDIR/TMP/TEMP와 중첩 Codex helper 쓰기 전제도 함께 적용한다.

같은 E2E의 승인·질문·대기 후속 입력은 `codex exec resume`으로 기존 orchestrator thread를 재개한다. `codex exec resume`은 `--sandbox`, `--add-dir`, `-C`를 받지 않으므로, sandbox는 `-c 'sandbox_mode="danger-full-access"'`로 지정하고 대상 worktree를 cwd로 둔다. 아래 명령에서 thread ID와 prompt는 실제 정본 기록과 사용자 답변으로 바꾼다. `--dangerously-bypass-hook-trust`는 위에서 검토한 hook에만 사용한다.

```bash
export HARNESS_WORKFLOW_BINDING='{"provider":"codex","model":"gpt-6-luna","reasoning_effort":"medium"}'
export HARNESS_SESSION_DIR='<session resolver로 확인한 절대 session_directory>'
export TMPDIR="$HARNESS_SESSION_DIR/tmp" TMP="$HARNESS_SESSION_DIR/tmp" TEMP="$HARNESS_SESSION_DIR/tmp"
node -e 'const p=require("node:path"),e=process.env,b=JSON.parse(e.HARNESS_WORKFLOW_BINDING); if(b.provider!=="codex" || b.model!=="gpt-6-luna" || b.reasoning_effort!=="medium" || !p.isAbsolute(e.HARNESS_SESSION_DIR) || [e.TMPDIR,e.TMP,e.TEMP].some(x=>x!==p.join(e.HARNESS_SESSION_DIR,"tmp"))) process.exit(1)' || exit 1
mkdir -p "$TMPDIR" || exit 1
codex exec resume --json --model gpt-6-luna \
  -c 'model_reasoning_effort="medium"' \
  -c 'approval_policy="never"' \
  -c 'sandbox_mode="danger-full-access"' \
  --dangerously-bypass-hook-trust '<orchestrator-thread-id>' '<사용자가 승인한 실제 후속 요청>'
```

실제 resume 인자, cwd, prompt, 반환 코드와 연결된 stage 실행 인자는 해당 E2E의 `resume-<stage>-invocation.json`에 기록한다. stage의 실제 provider/model/sandbox는 `.io/runtime/executions/<execution_id>/exec.stderr.json`을 함께 보존해 대조한다.

로그·stderr·마지막 응답·프로세스 종료 코드·artifact snapshot/cleanup 결과는 Harness source session의 `runtime/e2e/<run_id>/`에 단계별로 보존한다. 생성 worktree의 정본 `.io`와 최종 source·Spec·계획·계약·다이어그램은 테스트 산출물로 보존한다. 임의 timeout으로 살아 있는 workflow를 끊지 않고, 명시된 제한이 만료되면 timeout으로 보고하며 자동 재시도하지 않는다.

### Orchestrator 작업 실행

메인 orchestrator는 [실행 조율 지침](../../.codex/internal-skills/skill-execution/GUIDE.md)에 따라 입력 준비, model binding, 출력 스키마, 상태 기록, `codex exec`, 반환 검증을 각각의 명령으로 수행한다. 각 실행은 새 execution ID를 사용한다. linked worktree의 shared guidance는 같은 Git common directory인지 입력 검증으로 확인한다. 중첩 작업의 startup hook 재진입은 `HARNESS_SKILL_EXECUTION_ID`로 생략하고 오류 로그는 해당 execution의 session에 보존한다.

장기 stage는 `harness-agent-run.mjs --background true`로 독립 runner를 시작한다. `harness-prepare-input.mjs`가 guide/profile/phase instruction hash를 기록하며 same-session 재개는 unchanged instruction을 생략하고 delta만 전달한다. Compaction 감지 시 최신 instruction을 다시 읽어 필요한 규칙을 복구한다. task session은 결과 상세를, control session은 terminal 상태와 stage result event를 보유한다. `harness-stage-listen.mjs`가 두 session을 대조한다. 결과 이벤트 알림은 선택 기능이며 정확한 host agent session 일치 시 queued delivery를 시도한다. `runtime/executions/<execution_id>/process-events.jsonl`은 시작·heartbeat·Codex 이벤트 종류·수신 signal·종료 코드/신호를, `codex.stderr.log`와 `codex.errors.jsonl`은 하위 Codex stderr와 오류 이벤트를 실시간으로 기록한다. `runner.stdout.log`, `runner.stderr.log`, 완료 시 `exec.stderr.json`과 함께 확인한다. 종료 이벤트 없이 PID가 사라지면 원인 미상이며 SIGKILL이나 timeout이라고 추정하지 않는다. 상위 `codex exec`의 stderr는 별도 session 파일로 보존한다. 로그에는 오류 상세가 포함될 수 있으므로 session 내부에만 둔다.


runner는 task session의 결과 검증·정규화와 control session의 terminal stage 상태·결과 이벤트 기록을 소유한다. Orchestrator는 실행 상태 CLI를 중복 호출하지 않고 `harness-stage-listen.mjs --root <workspace> --worktree-ref <worktree_ref> --execution-id <execution_id>`로 task/control session 결과를 대조해 기다린다. Listener는 execution·stage·worktree identity를 검증하며 실패/누락을 완료로 추정하지 않는다. 선택적 host queue 알림은 정확히 일치한 현재 agent session에서만 요청하며 listener 연결 대기도 지원한다. 입력 준비기는 stage와 제어 session 경로를 기록한다.


구성된 workflow의 입력과 실행 ID는 `harness-prepare-input.mjs`가 생성한다. 최초 workflow-compose의 worktree는 `harness-compose-workspace.mjs`가 준비한다.


workflow-compose 진입의 worktree 생성은 실행기에서 기존 lifecycle 코드로 수행한다. 원본 프로세스 권한은 이 결정적 준비 작업에 사용하고, 모델은 `workspace-write`를 유지한다. 생성된 작업 위치와 session 출력만 추가 쓰기 경로로 전달한다. agent는 `context.worktree_ref`의 정본 기록을 읽고 preflight·문서 작업을 수행한다.

exec worker의 질문은 `user_question` artifact로 저장하고 `USER_DECISION_REQUIRED`로 반환한다. 사용자 답변 JSON을 session에 보존한 뒤 같은 stage 실행 명령에 `--answer <session-relative answer.json>`을 추가한다. 실행기는 질문 ID와 답변을 확인해 이전 checkpoint와 함께 다음 호출에 전달한다.

## Nested Codex workflow execution

연결된 worktree의 Codex `implement-wrapper`와 `implement`가 `workspace-write`로 실행되고 Beads가 활성화되어 있으면 실행기가 공유 DB와 `.beads.gate.lock`을 사용할 수 있도록 Git common directory의 상위 저장소 전체를 `--add-dir`로 전달한다. 이 권한은 해당 저장소의 다른 파일에도 쓰기를 허용한다. 읽기 전용 실행에는 쓰기 권한을 추가하지 않는다.

On Linux, a `codex exec` session that runs Harness stages must allow the Codex helper directory to be written by the **outer** session. Harness launches a nested Codex CLI for each stage; the nested CLI creates PATH aliases under `CODEX_HOME/tmp/arg0-linux` before its own workspace sandbox starts. The stage runner's `--add-dir` cannot expand the outer session's sandbox.

Add this option to the outer `codex exec` command:

```sh
--add-dir "${CODEX_HOME:-$HOME/.codex}/tmp/arg0-linux"
```

Keep the stage's own sandbox setting unchanged. This grants the outer session write access only to Codex's Linux helper directory.

GitHub tracker를 쓰는 `implement-wrapper`는 workspace 쓰기 sandbox를 유지하고 네트워크를 허용한다. Codex는 `sandbox_workspace_write.network_access=true`를 사용하고 Claude는 GitHub 도메인을 허용한다. 연결 실패를 토큰 무효로 단정하기 전에 같은 sandbox의 네트워크 접근을 확인한다. local-markdown mode에는 이 설정을 추가하지 않는다.

Harness black-box 관찰자는 내부 stage 실패나 모델 자체 복구를 이유로 outer Codex·timeout wrapper·stage runner·listener에 종료 신호를 보내지 않는다. 그 동작을 관찰·기록하며, 관찰자의 종료는 사용자의 명시적 취소 지시가 있을 때만 허용한다. 앱·인프라 cleanup 권한은 테스트 대상 workflow를 종료할 권한이 아니다.

정적 실행 위치·발행 본문 생성의 설치 소비자 회귀는 `node --test tests/execution_workspace.test.mjs`로 실행한다. 일반 회귀이며 실제 workflow E2E의 대체가 아니다.

발행 상태 회귀는 `node --test tests/execution_workspace.test.mjs`로 검사한다. configured Project를 유일한 발행 상태로 조회하며 기존 publish-state.json 변조·본문 끝 개행·중복 항목·본문 변조와 설치/업데이트 Git 가시성을 확인한다.
