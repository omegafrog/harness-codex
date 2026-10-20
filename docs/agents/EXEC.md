# 실행 환경 안내

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

- Harness 원본 저장소와 해당 worktree에서는 `.codex/skills/` 및 `.codex/agents/`를 직접 사용한다. `install`, `update`, `lock`은 설치 사본을 만들거나 원본 agent profile의 경로를 치환하지 않고 건너뛴다. 원본 갱신은 Git으로 관리한다.
- 원본 checkout 판별은 설치 도구와 대상이 같은 실제 경로이거나, 같은 package 이름과 Harness installer·소스·스킬 파일이 있는지를 확인한다.
- 외부 프로젝트에는 기존 방식으로 스킬을 `.agents/skills/`에, agent profile을 `.codex/agents/`에 설치한다. workflow·schema·script와 프로젝트 설정도 `.codex/`에 둔다.
- update는 스킬의 SKILL.md와 supporting reference/assets/scripts도 lock으로 관리한다. 관리 스킬 파일은 로컬 수정·충돌·untracked 경로 충돌 시 기존 내용을 session/runtime/installer-backups/<id>/에 먼저 백업하고 기본 교체한다. 그 밖의 관리 자산은 기존 충돌 보존 규칙을 따른다.
- workflow의 스킬 탐색은 외부 consumer에서 `.agents/skills/`를 먼저 확인한다. Harness 원본 checkout/worktree는 `.codex/skills/`를 우선해 오래된 설치 사본이 원본 변경을 가리지 않도록 한다. 원본 저장소에는 중복 스킬 사본이 필요하지 않다.

## Harness 검증 경로 실행

- 용어/구형 경로의 작은 Luna 검증 결과와 한계는 `docs/verification/luna-workflow-check.md`에 기록했다. 임시 프로젝트는 세션 디렉터리의 tmp/에서 실행하며 별도 서버/인프라가 필요하지 않다. 프로젝트를 재사용할 때 실제 존재와 Git root를 확인하고 `npm test`를 실행한다. 이름만으로 이전 결과나 현재 상태를 신뢰하지 않는다.

- 기준 Node.js 버전은 `package.json`의 `engines`를 따른다. 저장소에는 상시 실행하는 server/DB가 없다.
- 계약 회귀 검사: 저장소 루트를 cwd로 `node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile unit`. 사용자 경로 live 검증과 별개다.
- 외부 consumer 설치/갱신 검증은 소유한 임시 디렉터리에서 Git 저장소를 만들고, 원본 저장소를 cwd로 `node bin/harness-install.mjs install --project <절대 consumer 경로>`, `node bin/harness-install.mjs update --project <동일 경로>`를 실행한다. 설치기는 Ponytail plugin 준비를 위해 Codex/network를 사용할 수 있으므로 실제 실행 권한과 의존성을 먼저 확인한다. 사용자 저장소에 `--force`를 적용해 검증하지 않는다.
- 진단: 원본 루트를 cwd로 `node bin/harness-doctor.mjs --project <consumer 경로> --json`. `passed`, diagnostics와 exit code를 함께 확인한다.
- workspace 검사: 검사할 저장소를 cwd로 `node .codex/scripts/harness-workspace-preflight.mjs --expected-root <절대 worktree 경로> --json`. 관리형 spec-me는 등록된 linked worktree를 사용한다.
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

모든 workflow는 시작 시 캡처한 `git rev-parse HEAD`의 SHA를 보존하고, 정상 종료 직전에 `node .codex/scripts/harness-workflow-complete.mjs --root /absolute/project --workflow spec-me --base-ref <starting-commit-sha>`를 실행한다. workflow별 추가 완료 evidence는 `--state <session-relative-json>`으로 전달한다. 이 명령은 선언된 `before_complete` hook과 필수 `contract_docs`를 실제 실행하고 `<session_directory>/runtime/workflow-completion/` journal에 verdict를 보존한다. 해당 raw evidence를 tracker나 PR에 게시하지 않는다. 시작 SHA나 증거가 빠지면 완료되지 않는다.

## Tracker/Beads 공통 lifecycle 명령

새 tracker mirror를 연결한 뒤에는 개별 gh/bd status 명령 대신 다음 공통 명령을 사용한다. root는 실제 consumer worktree의 절대 경로이며 subprocess cwd도 같은 경로다. linked worktree에서는 Git common directory의 공유 Beads도 발견한다.

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

## Workflow worktree 생성·종료·복구

소유 worktree lifecycle은 `src/workflow/worktrees.mjs`와 설치되는 공통 CLI가 관리한다. 도구를 호출하는 cwd는 살아 있는 source/return workspace다. main checkout과 임의 사용자 worktree는 삭제하지 않는다.

```sh
node .codex/scripts/harness-workflow-worktree.mjs list --root /absolute/repository
node .codex/scripts/harness-workflow-worktree.mjs create --root /absolute/repository --workflow spec-me
node .codex/scripts/harness-workflow-worktree.mjs create --root /absolute/repository --workflow to-ticket --branch harness/spec-me/preserved-branch
node .codex/scripts/harness-workflow-worktree.mjs finish --root /absolute/owned-worktree --repository /absolute/repository --workflow spec-me --outcome aborted
```

`create`의 workspace/branch/return_root를 보존한다. register를 별도로 사용할 때는 workflow가 직접 만든 linked worktree만 명시적으로 등록한다. Git add 전 reservation을 기록하므로 설치/preflight 이전 오류도 추적할 수 있다. `completeWorkflow`는 검증·기록의 outer finally에서 finish를 실행한다. 중간 종료·사용자 취소·설치 실패·handoff는 소유 agent/서버/writer 종료를 확인한 뒤 finish를 호출한다. 하위 단계/subagent는 상위 공유 session worktree를 정리하지 않는다.

복구 자료는 Git common directory의 `harness-workflows/sessions/<workspace-hash>/recovery/<id>`에 생성된다. 상위 directory는 0700이며 files/에 tracked/untracked/ignored 데이터를 보존한다. local runtime 증거는 같은 세션 디렉터리에 그대로 남아 경로가 바뀌지 않는다. index 파일과 HEAD/staged blob의 보호 ref도 유지한다. 민감한 ignored 파일이 포함될 수 있으므로 commit/push/외부 게시하지 않는다. cache도 포함되므로 보관 공간이 필요하다. 백업 공간이 부족하면 삭제하지 않고 실패로 보고한다.

중단 상태 복원은 보존 branch로 **새로 생성한 소유 worktree**에서만 수행한다. recovery receipt의 branch/HEAD/ref를 확인하고, 새 worktree의 `.git`을 제외한 파일을 snapshot files/와 동일하게 복원한 뒤 저장된 index를 새 worktree Git directory의 index에 복사한다. 다른 사람이 수정한 branch/기존 workspace를 덮어쓰지 않는다. 완료된 workflow 다음 단계는 branch를 재사용하되 제거된 이전 절대 경로를 cwd로 전달하지 않는다.

SIGINT/SIGTERM을 받은 CLI는 현재 안전한 종료 단계를 끝내고 cleanup 결과를 보고한다. SIGKILL·전원 종료는 handler를 실행할 수 없으므로 다음 진입에서 list 결과와 이전 agent/process 종료를 확인한 뒤 finish를 재시도한다. 살아 있는 PID의 cleanup lock이나 Git worktree lock은 자동 해제하지 않는다. Git 잠금/지원되지 않는 특수 파일·submodule/파일 변경 감지/백업 실패는 정확한 원인과 recovery 경로를 반환하며, cleanup 실패를 정상 완료로 보고하지 않는다. Git branch와 복구 자료는 자동 삭제하지 않는다.

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

`spec-review-check` profile은 새 Spec 리뷰 gate·workflow stage·설치형 완료 CLI 회귀 검사를 실행한다. 임시 Git/file fixture만 사용하여 별도 서버/DB·생성 설정이 없으며 prepare/dependencies는 빈 배열이다. `node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile spec-review-check`로 실행한다.

reviewer snapshot은 `harness-spec-review.mjs snapshot --root <workspace_root> --ticket <id> --axis product|architecture [--input <직접 읽은 source/ADR 상대 파일>]`로 구한다. raw request/확정 사용자 답변은 ticket의 request.md에 보존한다. caller는 실제 각 reviewer JSON과 spawn metadata를 session/runtime/spec-reviews/에 attempt별 저장한다. `harness-spec-review.mjs check --root <workspace_root> --ticket <id> --reviews <session-relative-json>`가 최신 전체 리뷰를 검사하며 completion state에는 ticket_id/spec_reviews를 전달한다. source/Spec/diagram/용어/계약 갱신 후에는 이전 pass를 재사용하지 않는다. canonical 내용은 최종 fresh 리뷰 전에 안정화하고 seal의 기계 산출물 갱신 후 완료 gate를 실행한다.

## 설치·업데이트 회귀 검사와 스킬 갱신

`installer-maintenance`는 installer/doctor/exclude Node 회귀 검사를, `installer-maintenance-python`과 `installer-runtime-python`은 해당 CLI Python 검사를 실행한다. 로컬 Git/file fixture와 외부 명령 stub만 사용하며 서버/DB가 필요 없고 생성 설정도 없어 prepare/dependencies는 빈 배열이다. 모든 검사는 harness-exec의 해당 profile로 실행하고 임시 consumer·backup·로그는 세션 안에 둔다.

install/update 모두 같은 관리 자산 동기화를 사용한다. 관리 스킬과 refs/scripts는 기본 갱신에서도 기존 내용을 session/runtime/installer-backups/<id>/에 먼저 백업한 뒤 교체한다. `--force`는 스킬을 포함해 선택된 나머지 관리 자산의 로컬 변경도 백업 후 교체한다. agent, workflow/runtime, 관리 CI·PR template 등 나머지 자산은 기본적으로 로컬 변경을 보존한다. 재설치로 lock을 먼저 다시 만들거나 개별 스킬을 수동 복사하지 않는다. partial install은 다른 scope의 baseline을 유지한다. `.codex/harness.yaml`은 프로젝트 소유이므로 force에서도 변경하지 않는다. upstream에 없는 lock 항목은 원장만 정리하고 기존 파일은 보존한다.

doctor의 eval.permission_profile은 Harness 실행 event의 식별자이며 native profile 존재 증명이 아니다. 실제 eval 호출의 --sandbox와 sandbox_workspace_write.network_access 정책을 검증하고, eval.codex.command의 --permission-profile/-P 및 agent의 명시적 permission_profile 참조가 있으면 native inventory를 별도로 확인한다. 명시적 native 참조 누락/미검증과 위험하거나 모순된 sandbox/network 설정은 계속 실패한다. [공식 CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli)와 [설정 reference](https://learn.chatgpt.com/docs/config-file/config-reference)를 근거로 내부 label과 실제 native 설정을 구분한다.

## 구현 준비 회귀 검증

`node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile readiness-check`는 실행 프로필/통합 계약 누락·형식 오류·정상 bundle과 doctor/설치 회귀를 검사한다. Node 내장 테스트와 임시 Git fixture만 사용하므로 별도 서버·인프라·prepare는 필요 없다. fixture와 로그는 세션 경로에 저장한다. 프로젝트 진입 점검은 `harness-workspace-preflight.mjs --expected-root <workspace_root> --for-implementation --json`으로 실행하며 명령을 시작하지 않는다.

## E2E 실패의 재발 방지

E2E caller/runner는 `.codex/skills/e2e-test/references/failure-learning.md`를 따른다. raw 증거는 세션 `runtime/e2e/<run_id>/`에 시도별로 보존하고, 확인된 재발 방지 지식은 소비 프로젝트의 `docs/verification/e2e-lessons.md`와 실제 EXEC/execution.json·회귀 검사에 반영한다. 다음 실행 전에 관련 현행 lesson과 예방 검사를 읽는다. checkpoint의 `tests.e2e_failures`는 실패 ID별로 유지하고, 원본 증거는 교체하지 않으며 예방 조치/재검증이 없는 항목은 테스트 요약이 passed여도 완료하지 않는다.

`e2e-learning-check`는 Node 내장 fixture 테스트로 실패 이력 보존과 lifecycle/wrapper 완료 차단을 검증한다. 실제 앱·서버·DB를 시작하지 않으므로 dependencies/prepare가 없으며 임시 fixture와 로그는 세션 내부에 둔다.

## 명세·계획·구현 추적 회귀 검사

`node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile plan-traceability-check`로 source 규칙 선언, plan coverage, 독립 리뷰의 현재성, impact report, 구현 파일 hash 및 실행 receipt gate를 검사한다. Node 내장 fixture만 사용하며 서버·DB·prepare는 필요 없다. 임시 저장소와 실행 evidence는 세션 경로 아래에 생성한다.
