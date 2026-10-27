# 실행 환경 안내

문서 기반 Architecture Decision 근거는 `documentary-evidence-check` profile로 검사한다. 문서 원문 snapshot의 SHA-256과 위치를 보존하고 실행·측정은 `not_applicable`로 기록하며, 기존 Evidence 승인·게시 검증을 적용한다. 설치된 runtime의 같은 검증과 프로젝트 문서의 Git 가시성도 함께 확인한다.

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

- 사용자 진입점만 `.codex/skills/*/SKILL.md`(소비자는 `.agents/skills/`)로 공개한다. workflow 전용 하위 절차와 supporting files는 원본·소비자 모두 `.codex/internal-skills/*/GUIDE.md`에 둔다. workflow loader는 내부 GUIDE를 먼저 해석한다. 관리 lock에 있는 구형 공개 사본은 설치·갱신 시 session backup 후 제거하며 사용자 소유 비관리 파일은 임의 제거하지 않는다.
- Spec의 session-worktree 분기·준비 참조 검사는 `harness-exec.mjs --root <workspace_root> --profile worktree-skill-routing-check`로 실행한다.
- 구현 worktree 지침은 `session-worktree/references/sequential.md`와 `parallel.md`로 분리한다. wrapper는 의존성·공유 자원 판단 후 선택한 파일 하나만 읽고 `workspace_mode`·절대 `workspace_reference`를 하위 단계에 전달한다. `spec-me`는 진입 시 `worktree-create` skill을 실행한다. CLI 입출력 표는 `session-worktree/references/worktree-cli.md`에 둔다. 이 내부 skill과 reference는 기존 내부 스킬 관리 자산으로 설치·업데이트·Doctor·Git 제외 검사를 받는다.
- 계획의 실행 위치(`workspace_root`, `workspace_branch`)는 per-plan 범위와 index에 기록한다. `internal-skills-check`는 설치·갱신된 consumer의 지침 배포, Issue renderer의 실행 위치 보존, Doctor inventory와 애플리케이션 변경의 Git 노출을 확인한다.
- 내부 스킬 설치·갱신·비노출·호출 링크 회귀 검사는 `node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile internal-skills-check`로 실행한다. 서버·외부 인프라는 필요하지 않다.

- Harness 원본 저장소와 해당 worktree에서는 `.codex/skills/` 및 `.codex/agents/`를 직접 사용한다. `install`, `update`, `lock`은 설치 사본을 만들거나 원본 agent profile의 경로를 치환하지 않고 건너뛴다. 원본 갱신은 Git으로 관리한다.
- 원본 checkout 판별은 설치 도구와 대상이 같은 실제 경로이거나, 같은 package 이름과 Harness installer·소스·스킬 파일이 있는지를 확인한다.
- 외부 프로젝트에는 기존 방식으로 스킬을 `.agents/skills/`에, agent profile을 `.codex/agents/`에 설치한다. workflow·schema·script와 프로젝트 설정도 `.codex/`에 둔다.
- update는 스킬의 SKILL.md와 supporting reference/assets/scripts도 lock으로 관리한다. 관리 스킬 파일은 로컬 수정·충돌·untracked 경로 충돌 시 기존 내용을 session/runtime/installer-backups/<id>/에 먼저 백업하고 기본 교체한다. 그 밖의 관리 자산은 기존 충돌 보존 규칙을 따른다.
- workflow의 스킬 탐색은 외부 consumer에서 `.agents/skills/`를 먼저 확인한다. Harness 원본 checkout/worktree는 `.codex/skills/`를 우선해 오래된 설치 사본이 원본 변경을 가리지 않도록 한다. 원본 저장소에는 중복 스킬 사본이 필요하지 않다.

## E2E 실패 학습 계약

E2E 실패를 확인하면 `e2e-test`의 실패 학습 절차에 따라 원인 근거와 반복 여부를 기록한다. 반복되거나 재사용할 예방 절차가 확인되면 원본 프로젝트의 `docs/agents/testing-guidance.md`를 반드시 갱신한다. 실행값·URL·포트·readiness profile은 `docs/agents/execution.json`, 운영자가 따라야 할 준비·진단 절차는 이 문서에 반영하고 서로 일치시킨다. 테스트 결과와 학습 상태를 분리하며 학습 pending은 테스트 통과나 workflow 완료를 막지 않는다. `e2e-learning-check` profile의 `config_inputs`에는 이 규칙, 검증 코드와 관련 테스트를 포함한다.

## Harness 검증 경로 실행

- 용어/구형 경로의 작은 Luna 검증 결과와 한계는 `docs/verification/luna-workflow-check.md`에 기록했다. 임시 프로젝트는 세션 디렉터리의 tmp/에서 실행하며 별도 서버/인프라가 필요하지 않다. 프로젝트를 재사용할 때 실제 존재와 Git root를 확인하고 `npm test`를 실행한다. 이름만으로 이전 결과나 현재 상태를 신뢰하지 않는다.

- 기준 Node.js 버전은 `package.json`의 `engines`를 따른다. 저장소에는 상시 실행하는 server/DB가 없다.
- 계약 회귀 검사: 저장소 루트를 cwd로 `node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile unit`. 사용자 경로 live 검증과 별개다.
- Harness eval 계약의 집중 검사는 `node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile harness-eval-contract`로 실행한다. 외부 서비스나 모델 인증은 필요하지 않다.
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

모든 실행은 시작 시 캡처한 `git rev-parse HEAD`의 SHA를 보존하고, 정상 종료 직전에 `node .codex/scripts/harness-workflow-complete.mjs --root /absolute/project --workflow spec-me --base-ref <starting-commit-sha>`를 실행한다. 소유 worktree의 ID와 원본 경로는 `<session_directory>/worktree.json`에서 읽는다. 단계별 완료 evidence는 `--state <session-relative-json>`으로 전달한다. 이 명령은 선언된 `before_complete` hook과 적용되는 `contract_docs`를 실행하고 `<session_directory>/runtime/workflow-completion/` journal에 verdict를 보존한다. 시작 SHA와 필수 evidence를 완료 입력에 포함한다.

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

구현 선호사항과 테스트 실행 선호사항은 각각 프로젝트 소유 문서 `docs/agents/implementation-guidance.md`와 `docs/agents/testing-guidance.md`에 기록한다. 관리 worktree에서는 호출자가 원본 프로젝트 루트를 절대 `shared_guidance_root`로 전달해야 하며, 이는 `session-worktree`의 `return_root`와 같다. `shared_guidance_root`와 활성 `workspace_root`의 Git common directory가 같은지 확인하고 worktree 내부 복사본 대신 공용 원본을 읽는다. 구현 agent는 편집 전에 구현 지침을, 테스트·서비스 실행 runner는 실행 전에 테스트 지침을 읽는다. 구현 agent도 검증을 실행할 때 테스트 지침을 함께 읽는다. 지침이 승인된 Spec이나 실행 계약과 충돌하면 진행하지 않고 호출자에게 보고한다.

테스트·서버·인프라 실행은 아래 공통 명령으로만 수행한다. 실행 프로필은 이 프로젝트의 `docs/agents/execution.json`에 Git으로 관리한다. 설치 대상에는 해당 프로젝트의 실제 명령·설정·의존성을 조사하여 작성한다. Harness 원본의 프로필을 복사하지 않는다. 프로필이 없거나 불완전하면 실행하지 않고 필요한 항목을 보완한다.

```sh
node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile <profile-id>
```

실행기는 매번 workspace 확인 → 필수 환경값과 전체 argv 확인 → 설정 준비 → 설정 검증 → 인프라 readiness → 설정 변경 재확인 → 정확한 command를 수행한다. 이전 실행의 준비 완료 receipt를 재사용하지 않는다. 같은 프로필의 prepare도 매번 실행한다. `--` 뒤에 임의 인자를 덧붙이거나 직접 npm/docker/server 명령으로 우회하지 않는다. 필요한 명령 변경은 프로필과 이 문서를 함께 갱신한다.

### 프로필 계약

- `schema_version: 1`, `profiles.<id>`를 사용한다. ID는 영숫자·`_`·`-`다.
- `command`: 정확한 실행 파일과 필수 인자를 담은 argv 배열. `--config`, profile/env, port, host, URL 등이 필요하면 여기서 명시한다. 문자열 shell 조립은 하지 않는다. `${PORT}` 같은 환경값은 개별 argv 안에서 치환되며 빈 값은 시작 전에 차단한다. 비밀은 가능한 한 인자 대신 환경변수로 전달한다.
- `required_env`: 비어 있으면 안 되는 환경변수 이름. 실행기의 process 환경을 사용하며 자동 기본값을 추정하거나 기존 `.env`를 암묵적으로 읽지 않는다. dotenv가 필요한 프로젝트는 사용하는 실행 파일과 파일 선택 인자를 command에 명시하고 verify_config에서 실제 로딩 결과를 확인한다.
- `config_inputs`: 실제 설정 원본·환경 파일·생성 설정·실행 recipe의 workspace 상대 파일 경로. 최소 한 개가 필요하다. prepare 후 파일 hash를 기록하고 prepare 완료 후 검증/readiness 도중 변경되면 시작하지 않는다. manifest 자체도 함께 추적한다. 값이나 secret은 receipt에 저장하지 않는다.
- `prepare`: 설정 생성/동기화 등 **재실행 가능한** 준비 명령 argv의 배열. 프로젝트가 필요한 설정 갱신을 여기서 수행한다. 필요 없으면 `[]`를 명시하고 이 문서에 근거를 남긴다. destructive migration/reset은 준비 명령으로 자동 추가하지 않는다.
- `verify_config`: 하나 이상의 실제 설정 검증 argv. 실행 대상·환경·port·DB/queue URL·생성 결과가 현재 원본과 일치하는지 프로젝트 도구로 확인하고, 다르면 nonzero로 종료한다. 단순 파일 존재나 오래된 receipt 확인은 설정 최신성 검증을 대신하지 않는다.
- `dependencies`: `{ "id": "postgres", "check": ["project-readiness-command", "--target", "${DATABASE_URL}"] }` 목록. 해당 서비스/테스트가 실제 사용하는 인프라·선행 서비스 전체를 기록한다. 단순 port 열림 대신 인증·DB/schema·필요 queue 등 목적에 맞는 readiness를 확인한다. timeout까지 실패하면 command를 실행하지 않는다. 의존성이 없을 때만 `[]`와 근거를 남긴다.
- `timeout_ms`, `readiness_timeout_ms`, `poll_interval_ms`: 양의 정수. 실제 서비스의 준비 시간과 테스트 제한에 맞춘다.

인프라가 없다면 지정된 인프라 실행 프로필을 먼저 띄우고, 해당 프로세스를 유지한 채 서버/테스트 프로필을 실행한다. 실행기는 누락된 인프라를 임의 설치·대체·초기화하지 않는다. 인프라 자체도 별도 프로필로 정확한 config/profile/서비스 선택 인자를 고정한다. 서버 프로필에는 인프라 readiness, E2E 프로필에는 인프라와 대상 서버 readiness를 모두 둔다. foreground 실행을 사용하며 detach하는 daemon 명령은 사용하지 않는다. 외부에서 이미 관리 중인 인프라는 check만 수행하며 종료하지 않는다.

실패·timeout·취소에서는 실행기가 자신이 시작한 process group을 종료한다. 이 실행기가 시작하지 않은 서버/인프라를 지우지 않는다. SIGKILL/전원 종료 시 정리는 보장하지 못하므로 다음 실행에서 소유 프로세스를 확인한다. 로그·단계 결과·설정 hash는 session_directory/runtime/execution/<profile-id>-<run-id>/에 보존한다. 테스트 실패는 failed, 준비 실패는 blocked로 구분하며 정상 준비로 간주하지 않는다.

이 저장소의 `unit`, `harness-execution`은 Node.js 기반 파일/임시 Git fixture 검사라 서버·DB가 필요 없고 생성 설정도 없어 dependencies와 prepare가 빈 배열이다. package.json의 test 명령과 최소 Node 버전을 검증한다. 전체 suite에는 기존 실패가 있으므로 성공으로 간주하지 않는다. 이 프로필을 서비스가 있는 소비 프로젝트의 무인프라 근거로 사용하지 않는다.

### 유지보수 책임

설계/구현에서 인자·환경·인프라·설정 파일이 바뀌면 해당 프로필·EXEC를 함께 고친다. 리뷰는 실제 entrypoint, compose/manifest, config loader, CI와 대조해 의존성 목록·필수 인자·최신성 검증의 충분성을 확인한다. 공통 실행기는 선언한 프로필의 준수를 강제하지만 누락된 비즈니스/인프라 요구 자체를 코드만으로 추론하지는 않는다. 직접 shell 실행을 OS 차원에서 금지하는 sandbox도 아니다.

설정 prepare가 생성 설정을 의도적으로 바꾸는 것은 허용한다. hash 기준점은 prepare 완료 직후이며, 그 이후 verify_config/readiness 중 변경을 차단한다. POSIX에서는 process group 전체를 정리하고 native Windows에서는 직접 child만 종료하므로 descendant 정리 보장이 필요한 실행은 WSL/POSIX를 사용한다.

## Fresh Spec 리뷰 검사

`spec-review-check` profile은 Spec·계획 리뷰의 중복 실행·입력 고정·재검토 한도, Spec 리뷰 후 diagram stage 순서, 최종 diagram 산출물 gate, 설치·업데이트된 CLI와 Git 가시성 회귀 검사를 실행한다. 임시 Git/file fixture만 사용하여 별도 서버/DB·생성 설정이 없으며 prepare/dependencies는 빈 배열이다. `node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile spec-review-check`로 실행한다.

reviewer snapshot은 `harness-spec-review.mjs snapshot --root <workspace_root> --ticket <id> --axis product|architecture [--input <직접 읽은 source/ADR 상대 파일>]`로 구한다. raw request/확정 사용자 답변은 ticket의 request.md에 보존한다. caller는 실제 각 reviewer JSON과 spawn metadata를 session/runtime/spec-reviews/에 attempt별 저장한다. `harness-spec-review.mjs check --root <workspace_root> --ticket <id> --reviews <session-relative-json>`가 최신 전체 리뷰를 검사하며 completion state에는 ticket_id/spec_reviews를 전달한다. source/Spec/diagram/용어/계약 갱신 후에는 이전 pass를 재사용하지 않는다. canonical 내용은 최종 fresh 리뷰 전에 안정화하고 seal의 기계 산출물 갱신 후 완료 gate를 실행한다.

## 설치·업데이트 회귀 검사와 스킬 갱신

native `.codex/hooks.json`의 `UserPromptSubmit`에는 `harness-orchestrator-hook.mjs`가 등록된다. 명령 hook은 canonical `worktree.json`·같은 Codex session ID의 orchestrator 상태와 Git worktree 등록·경로·branch를 읽기 전용으로 대조하고 `resume_candidate`, `compose_candidate`, `inspect_required`를 전달한다. 기록 생성·legacy 이전·복구·Git 변경은 수행하지 않는다. 새 요청 여부는 메인이 메시지와 관측 상태를 함께 보고 판단하며, 생성 작업은 workflow-compose subagent에 맡긴다. installer는 다른 hook을 보존하고 해당 등록만 동기화하며 변경 전 설정을 session에 백업한다. Doctor가 등록 누락·손상을 진단한다. 새 hook은 Codex의 `/hooks`에서 신뢰 검토를 거쳐야 실행된다. protocol·신뢰 규칙은 [공식 hook 문서](https://learn.chatgpt.com/docs/hooks)를 따른다.

setup은 사용자에게 확인한 context window·plan 최대 예상 토큰·인계 예비 토큰을 프로젝트 소유 `.codex/context-budget.json`에 저장한다. `harness-skill-execution.mjs budget --root <shared_guidance_root> --estimate <tokens> [--used <observed-tokens>]`은 이 파일의 기준과 hash를 반환한다. 예상치와 관측 사용량을 구분하며 사용량이 없으면 runtime 판정을 반환하지 않는다. Doctor는 존재하는 budget 파일의 정합성을 검사하고 installer는 해당 설정 파일을 덮어쓰지 않는다.

`model-binding-check`는 공개 skill의 binding 등록과 설정·workflow tier inventory를 검사한다. `internal-skills-check`는 skill 설치·업데이트·Doctor·Git 가시성, model/effort binding, 작은 반환 envelope와 파일 기반 결과 검증을 포함한다. `harness-skill-execution.mjs binding`은 실제 설정을 해석하고 `validate-return`은 session의 입력·반환·상세 결과·산출물을 대조한다. 이 명령들은 agent를 생성하거나 외부 tracker를 변경하지 않는다. orchestrator skill이 실제 spawn 도구와 기존 workflow lifecycle을 사용한다.

`installer-maintenance`는 installer/doctor/exclude Node 회귀 검사를, `installer-maintenance-python`과 `installer-runtime-python`은 해당 CLI Python 검사를 실행한다. 로컬 Git/file fixture와 외부 명령 stub만 사용하며 서버/DB가 필요 없고 생성 설정도 없어 prepare/dependencies는 빈 배열이다. 모든 검사는 harness-exec의 해당 profile로 실행하고 임시 consumer·backup·로그는 세션 안에 둔다.

install/update 모두 같은 관리 자산 동기화를 사용한다. 관리 스킬과 refs/scripts는 기본 갱신에서도 기존 내용을 session/runtime/installer-backups/<id>/에 먼저 백업한 뒤 교체한다. `--force`는 스킬을 포함해 선택된 나머지 관리 자산의 로컬 변경도 백업 후 교체한다. agent, workflow/runtime, 관리 CI·PR template 등 나머지 자산은 기본적으로 로컬 변경을 보존한다. 재설치로 lock을 먼저 다시 만들거나 개별 스킬을 수동 복사하지 않는다. partial install은 다른 scope의 baseline을 유지한다. `.codex/harness.yaml`은 프로젝트 소유이므로 force에서도 변경하지 않는다. upstream에 없는 lock 항목은 원장만 정리하고 기존 파일은 보존한다.

doctor의 eval.permission_profile은 Harness 실행 event의 식별자이며 native profile 존재 증명이 아니다. 실제 eval 호출의 --sandbox와 sandbox_workspace_write.network_access 정책을 검증하고, eval.codex.command의 --permission-profile/-P 및 agent의 명시적 permission_profile 참조가 있으면 native inventory를 별도로 확인한다. 명시적 native 참조 누락/미검증과 위험하거나 모순된 sandbox/network 설정은 계속 실패한다. [공식 CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli)와 [설정 reference](https://learn.chatgpt.com/docs/config-file/config-reference)를 근거로 내부 label과 실제 native 설정을 구분한다.

## 구현 준비 회귀 검증

`node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile readiness-check`는 실행 프로필/통합 계약 누락·형식 오류·정상 bundle과 doctor/설치 회귀를 검사한다. Node 내장 테스트와 임시 Git fixture만 사용하므로 별도 서버·인프라·prepare는 필요 없다. fixture와 로그는 세션 경로에 저장한다. `tracker-lifecycle-check`는 tracker lifecycle/CLI 회귀, `plan-traceability-check`는 검토 snapshot의 현재성과 dispatch gate 회귀를 실행한다. 구현 준비 시 source snapshot drift만 마지막 통합 계약 동기화까지 지연하며, 계약 bundle 오류와 실행 준비 실패는 계속 차단한다. 프로젝트 진입 점검은 `harness-workspace-preflight.mjs --workspace-root <workspace_root> --for-implementation --json`으로 실행하며 명령을 시작하지 않는다.

## E2E 실패의 재발 방지

E2E caller/runner는 `.codex/skills/e2e-test/references/failure-learning.md`를 따른다. raw 증거는 세션 `runtime/e2e/<run_id>/`에 시도별로 보존하고, 확인된 재발 방지 지식은 소비 프로젝트의 `docs/verification/e2e-lessons.md`와 실제 EXEC/execution.json·회귀 검사에 반영한다. 다음 실행 전에 관련 현행 lesson과 예방 검사를 읽는다. checkpoint의 `tests.e2e_failures`는 실패 ID별로 유지하고, 원본 증거는 교체하지 않으며 예방 조치/재검증이 없는 항목은 테스트 요약이 passed여도 완료하지 않는다.

`e2e-learning-check`는 Node 내장 fixture 테스트로 실패 이력 보존, 테스트 성공/학습 pending의 분리와 현재 테스트 실패의 lifecycle/wrapper 완료 차단을 검증한다. 실제 앱·서버·DB를 시작하지 않으므로 dependencies/prepare가 없으며 임시 fixture와 로그는 세션 내부에 둔다.

## 명세·계획·구현 추적 회귀 검사

`node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile plan-traceability-check`로 source 규칙 선언, 요구사항별 수용 기준·검증 사례 연결, plan 간 producer/consumer handoff, 독립 리뷰의 현재성, impact report, 구현 파일 hash 및 실행 receipt gate를 검사한다. schema_version 2 계획은 단위 테스트 파일을 `verification_files`로 선언하고 선택 profile의 `config_inputs`에 포함해야 한다. profile 설정도 계획 snapshot에 묶여 정합성 오류는 리뷰/dispatch 전에 차단된다. Node 내장 fixture만 사용하며 서버·DB·prepare는 필요 없다. 임시 저장소와 실행 evidence는 세션 경로 아래에 생성한다. 연결된 문장의 의미상 충족 여부와 profile 명령의 실제 테스트 실행 여부는 독립 plan review가 확인한다.

## VictoriaLogs 개발 관측성 설치

setup CLI는 OpenTelemetry Collector·VictoriaLogs·VictoriaMetrics 사용 여부, 로그/메트릭 포트와 보존 일수, OTLP HTTP 포트, 프로젝트/서비스별 앱 기준 metrics_url·컨테이너 기준 scrape_url을 터미널에서 수집한다. `harness-victorialogs.mjs setup`이 compose·otel-collector.yaml·scrape.json·개발 Spring config·otel-javaagent.properties·공식 MCP 두 개·실행 profile·공용 지침을 준비한다. 기본 포트는 9428/8428/4318이고 저장소 보존은 각각 7일이다. 기본 compose bridge를 사용한다. host에는 127.0.0.1:<설정 port>만 publish하고 내부 listener는 0.0.0.0:4318/9428/8428이다. 앱→Collector는 공개 localhost, Collector/MCP→backend는 compose service DNS, Metrics→WSL 앱은 scrape_url의 host.docker.internal:<실제 port/path>로 연결한다. Desktop host networking 활성화나 WSL gateway IP에 의존하지 않는다. Collector는 native OTLP LogRecord를 받아 VictoriaLogs OTLP HTTP endpoint로 protobuf export한다. Vector·Fluent Bit은 설치하지 않고 session JSON 파일을 tail하지 않는다. `victorialogs-local-setup`이 실제 source의 개발 SDK/appender 또는 외부 Java agent와 Actuator/Prometheus registry를 연결한다. production artifact에서 개발 의존성을 제외하고 SDK/agent 중복 전송을 막는다. 일반 실행은 harness-exec infrastructure/check/stop과 기존 앱 profile을 사용한다. check는 세 API readiness이며 실제 수집은 앱 로그 검색과 project/service별 최신 up=1로 별도 확인한다. 이 Node 원본에는 Spring 앱이 없으므로 설치 fixture·오프라인 진단 검사와 설정 검증 범위를 보고하고 실제 앱 수집을 확인한 것으로 쓰지 않는다.

공식 MCP Docker 이미지는 stdio client subprocess로 필요 시 실행한다. 전역 provider 설정은 자동 수정하지 않으며 SigNoz marketplace 자동 등록은 제거한다. 관리 lock으로 식별된 폐기 skill만 session backup 후 제거하고 기존 사용자 데이터와 전역 plugin은 유지한다. 데이터/offset은 원본 프로젝트 session directory, linked-worktree 로그는 같은 Git common directory의 sessions에서 수집한다. Docker daemon과 Compose v2가 전제이며 서버·이미지 pull·Spring 앱을 검증 명목으로 자동 실행하지 않는다.

## Spring Boot diagnostic v1 검증

`diagnostic-log-check`는 사용자 v1의 일곱 이벤트, 필수 Resource/Attributes, outcome·숫자/boolean·Trace ID·timestamp 및 offline JSONL CLI를 집중 검증한다. `node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile diagnostic-log-check`를 사용하며 Docker/앱/인프라는 필요하지 않다. 소비 프로젝트 setup은 스키마·예시·수집 매핑과 공용 구현/테스트 지침을 설치하고 `victorialogs-diagnostic-logs` profile을 생성한다. 그 profile의 HARNESS_DIAGNOSTIC_LOG_FILE은 실제 emitter 원본 JSONL 경로다. 원본 타입 검사와 VictoriaLogs 저장 후 string 표현을 구분한다. 일반 unit 검증이나 실패 학습을 이유로 E2E를 추가 실행하지 않는다.


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

`$setup`은 session 내부 `runtime/setup/answers.json`에서 사용자 응답을 관리하고 `node .codex/scripts/harness-setup.mjs --root <workspace_root> --answers <절대 session JSON 경로>`를 실행한다. CLI는 stdin 대기 없이 needs_input과 live 선택지·안정적인 question ID·configuration_hash를 반환한다. 스킬은 사용 가능한 native request_user_input_async/request_user_input 도구에 표시하고 제출된 value만 저장해 다시 호출한다. 답·기본값을 agent가 추정하지 않고 도구 미지원 시 정확한 사유를 보고한다. needs_input은 완료가 아니며 configured와 exit=0 뒤 source 기반 준비를 이어간다. 잘못된 option·stale config snapshot·session 밖 답 파일은 거부한다. 별도 GUI/설치기 메뉴/agent-only PTY는 사용하지 않는다. 수동 CLI는 유지한다.

## 구현 리뷰 회귀 검사

`implementation-review-check` profile은 plan별 영속 수정 한도, 재개·worktree 교체, 지적 분류, 중간 plan과 최종 계약 gate, 설치·업데이트된 CLI와 Git 가시성, 읽기 전용 통합 리뷰 조회, 양쪽 결과 수집과 planning snapshot 변경 차단을 검사한다. 수정 한도 reset은 새 독립 계획 리뷰와 dispatch를 통과한 planning snapshot 변경이 있을 때만 허용하고, 일반 진행 지시로는 초기화되지 않는지도 검사한다. 임시 Git/file fixture를 사용하며 별도 서버·DB와 생성 설정이 없어 prepare/dependencies는 빈 배열이다. `node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile implementation-review-check`로 실행한다.


### Orchestrator 작업 실행

메인 orchestrator의 하위 작업은 `node .codex/scripts/harness-skill-exec.mjs --root <workspace_root> --session-directory <session_directory> --input <session-relative input.json>`으로 실행한다. 실행기는 `codex exec --output-schema`로 공통 반환 envelope를 받고 상세 결과를 검증한다. 각 실행은 새 execution ID를 사용하며 기존 반환 파일을 덮어쓰지 않는다. model·effort는 Harness binding에서, 인증·sandbox는 해당 Codex 실행 환경에서 가져온다. 중첩 작업의 startup hook 재진입은 `HARNESS_SKILL_EXECUTION_ID`로 생략한다. CLI 오류 로그는 해당 execution의 `exec.stderr.json`에 보존한다.


단계 실행기는 시작·결과·실패 상태와 진행률을 자동 기록한다. `context.codex_session_id`, `context.stage_id`와 필요한 제어 session 경로를 입력에 지정한다. 실제 모델 검증은 제품 변경 없는 입력과 새 execution ID를 사용해 임시 실행 프로필로 수행하고, 프로필과 receipt는 session에 보존한다.


구성된 workflow 실행은 `harness-skill-exec.mjs --root <작업 root> --session-directory <제어 session> --request-workflow runtime/orchestrator/workflow.json --stage <stage-id> --codex-session-id <메인 session ID>`를 사용한다. 입력 파일과 실행 ID는 실행기가 생성한다. 최초 workflow-compose만 기존 `--input` 진입을 사용한다.


workflow-compose 진입의 worktree 생성은 실행기에서 기존 lifecycle 코드로 수행한다. 원본 프로세스 권한은 이 결정적 준비 작업에 사용하고, 모델은 `workspace-write`를 유지한다. 생성된 작업 위치와 session 출력만 추가 쓰기 경로로 전달한다. agent는 `context.worktree_ref`의 정본 기록을 읽고 preflight·문서 작업을 수행한다.

exec worker의 질문은 `user_question` artifact로 저장하고 `USER_DECISION_REQUIRED`로 반환한다. 사용자 답변 JSON을 session에 보존한 뒤 같은 stage 실행 명령에 `--answer <session-relative answer.json>`을 추가한다. 실행기는 질문 ID와 답변을 확인해 이전 checkpoint와 함께 다음 호출에 전달한다.
