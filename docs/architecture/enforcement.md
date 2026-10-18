# 규칙과 실제 검사

자동 검사와 의미적 리뷰를 구분한다. 새 오류를 발견하면 `correct`로 반복 사례와 기존 검사 누락을 확인하고, 같은 역할의 검사기를 새로 만들기보다 아래 seam을 활용한다. 이 표는 오류 발생 이력을 추측하지 않는다.

| 규칙 | 현재 enforcement | 남는 판단/한계 |
|---|---|---|
| 전달 workspace와 실제 Git worktree가 일치해야 한다 | `.codex/scripts/harness-workspace-preflight.mjs`, `tests/workspace_preflight.test.mjs`, dispatch의 before_dispatch hook | 작업별로 hook/명령을 실제 실행했는지 확인 필요 |
| 승인된 decision과 review만 인계한다 | `src/workflow/stage-gates.mjs`, `tests/decision_gate_cli.test.mjs`, `tests/workflow_system_targets.test.mjs` | decision opt-in이 없는 legacy artifact에는 같은 gate를 강제하지 않음 |
| tracker 구조 입력을 검증 후 렌더한다 | `src/tracker/contracts.mjs`, `src/tracker/render.mjs`, `tests/tracker_contract.test.mjs` | acceptance/test-contract 문자열의 의미적 요구사항 완전성은 reviewer 판단 |
| 원본 workflow가 오래된 설치 스킬을 선택하지 않는다 | `src/workflow/loader.mjs`, `tests/workflow_loader.test.mjs`의 source/consumer 우선순위 검사 | consumer의 설치 사본 최신화는 installer update가 담당 |
| 스킬의 supporting reference도 갱신된다 | `src/installer/update.mjs`, `tests/installer_update.test.mjs`의 reference 배포·변경·충돌 보존 검사 | 로컬 수정 충돌은 자동 덮어쓰지 않음 |
| checkpoint가 손상된 journal을 완료 증거로 사용하지 않고 status-only handoff에서 측정·추적 증거를 보존한다 | `src/wrapper/checkpoint.mjs`, `tests/wrapper_checkpoint.test.mjs` | measurements 값의 사실성·조건 동등성은 별도 검증 필요; 명시적 evidence 필드 교체는 허용 |
| 업무 규칙은 선언된 owner에서 보호한다 | `ddd-design/references/model-continuity.md`, Spec reviewer의 실제 source/caller/우회 경로 검토와 프로젝트별 domain/dependency 검사 | 범용 JavaScript 구조 검사로 DDD 의미를 자동 판정하지 않음 |
| 승인된 구형 경로 제거를 실제 파일로 확인한다 | `src/gates/lifecycle.mjs`의 `retirement`, wrapper completion의 실제 workspace 검사, `tests/lifecycle_gates.test.mjs` | 제거 목록은 승인 계획에서 전달하며 자동 추론하지 않음; 용어의 의미와 호환 예외는 독립 리뷰가 판단; 옵션 없는 legacy 직접 API는 기존 동작 |
| 성능 개선은 실제 작업·오류·조건·편차로 뒷받침한다 | `evaluate-harness/references/measurement.md`, plan의 실행 증거 계약, Standards/Spec review | 측정 계약은 자동 통계 gate가 아니며 raw 결과 확인 필요 |
| blind 실험은 신원과 rubric 누출을 확인한다 | `evaluate-harness/references/blinded-comparison.md` | 기존 suite 실행이 자동 blind가 되지 않으며 coordinator의 사전 확인 필요 |

## 통합 계약 완료 gate

`src/contracts/contracts.mjs`는 consumer 프로젝트의 `docs/contracts/` bundle을 검사한다. `contract_docs`는 모든 workflow의 `before_complete`에 등록되며 `harness-workflow-complete.mjs`가 이를 실제 호출해 pass/fail receipt를 기록한다. 시작 SHA 누락은 차단된다. `executeImplementPlan`도 실제 검증된 workspace에서 직접 검사하므로, agent가 누락하거나 pass를 주장해도 source/문서 snapshot이 어긋나면 완료 reconciliation과 종속 plan 해제가 차단된다. 순수 `evaluateCompletion`에도 pass verdict가 필수다.

문서에는 전체 Product 규칙과 DDD 구성요소별 상세를 보존한다. `.puml`의 모든 DDD 이름은 stable section으로 연결하고, renderer가 SVG에 원본 SHA를 붙인다. `seal`은 검토 사유와 변경 snapshot을 기록하고 revision을 올리며 `check`는 base보다 증가했는지 검사한다. source만 바뀌고 계약이 같으면 구체적인 영향 없음 근거를 요구한다. `architecture.html`은 같은 페이지 안에서 SVG 이름→상세 이동을 제공한다.

자동 검사가 증명하는 범위는 파일·형식·소유 관계·링크·버전·입력 정합성이다. 전체 기능 목록의 완전성, source_roots 축소의 타당성, DDD 규칙 캡슐화, 통신·분리 배포 결정의 근거와 실제 기능 회귀는 독립 reviewer와 실제 실행 evidence로 검증한다. receipt를 작성했다는 사실을 설계 승인이나 실제 제품 테스트 통과로 해석하지 않는다.

## Tracker lifecycle와 mirror gate

`src/tracker/lifecycle.mjs`의 공통 코드가 신규 v1 mirror를 exact external_ref로 연결한다. `syncTrackerStatus`는 canonical 상태 변경·재조회 후 Beads를 반영하고 재조회한다. phase/classification은 metadata로 분리한다. 부분 실패는 local journal에 남기며 canonical을 rollback하지 않는다. `inspectTrackerSync`는 읽기 전용이다.

모든 workflow의 `tracker_sync`와 시작 workspace preflight, 실제 dispatch 전 검사, 실제 wrapper completion이 이를 호출한다. 중복/미연결 ref, 네 상태 밖의 값, metadata 누락, canonical/mirror 불일치는 실행·정상 완료·종속 plan 해제를 차단한다. 설치 runtime에도 같은 module/CLI가 배포된다. 기존 데이터는 이동·재분류하지 않고 새로 등록된 version1 mirror에 적용한다. GitHub 기본 Status와 Issue closure는 이 코드의 갱신 대상이 아니다.

## Workflow worktree 종료 gate

`src/workflow/worktrees.mjs`가 allocating 소유 receipt를 Git add 전에 기록하고 reserve/register/finish를 경로별 PID lock으로 직렬화한다. 일반 main checkout/비소유 linked worktree는 삭제하지 않는다. `completeWorkflow`의 outer finally는 preflight/manifest/검증/기록 실패도 처리한다. state JSON 파싱 오류와 CLI SIGINT/SIGTERM도 종료 경로로 연결한다. owned plan allocation 실패·실행/리뷰 오류·완료는 WorktreeManager의 같은 archiver를 사용한다.

미커밋·untracked·ignored 파일·staged index를 worktree 밖 영속 세션의 recovery/에 복사하고 hash/HEAD/index 일치를 확인한 후 제거한다. HEAD와 staged blobs를 별도 ref로 보호하므로 GC 이후에도 복구 근거를 유지한다. branch는 삭제하지 않는다. runtime journal·로그는 처음부터 같은 session_directory에 직접 기록하여 제거 후에도 경로를 유지한다. 제거 후 등록 해제와 receipt 상태를 확인하며, 삭제 후 receipt 실패도 다음 finish가 archive/ref를 검증하여 복구한다. 실패는 경로·복구 자료·재시도 원인을 반환하고 정상 완료가 아니다.

프로세스 강제 사망은 즉시 finally를 실행할 수 없다. 다음 시작의 pending receipt 확인과 중단된 writer 확인 후 finish 재시도로 처리한다. 다른 활성 실행, Git lock, 백업 실패는 강제로 우회하지 않는다. recovery의 민감 ignored 파일은 외부로 게시하지 않는다.

## 세션 출력 경계

`src/workflow/session-output.mjs`의 공통 resolver가 workspace별 Git common 세션 경로와 상대 출력 경로를 결정하고 이탈·symlink·공유 hardlink·특수 파일 대상을 거부한다. 재사용한 세션 root도 0700으로 제한한다. plan/completion/tracker/eval/external-port/knowledge/review/E2E manifest가 이를 호출한다. 완료 CLI의 --state 입력도 세션 상대 경로만 허용한다. agent/process의 TMPDIR/TMP/TEMP와 browser 출력 지정은 EXEC·skill·profile·dispatch 계약으로 적용한다. 외부 도구 전역 cache와 telemetry를 OS sandbox로 차단하지는 않는다. 최종 source·문서·registry와 Git/Beads 관리 metadata는 원래 경로를 유지한다.

## 실행 전제 누락

사용자가 보고한 인프라·필수 인자·설정 갱신 누락은 EXEC를 읽으라는 지침만으로 막지 못했다. `src/workflow/execution.mjs`와 `harness-exec.mjs`가 프로젝트 실행 프로필을 매번 읽고, 필수 환경/argv 검증→설정 prepare/verify→dependency readiness→설정 변경 재검증을 통과한 경우에만 main을 spawn한다. 실패는 blocked receipt와 단계 로그로 남긴다. 실행 프로필은 Git 관리하며 설치 runtime·E2E/실행/구현/시각 검토 agent도 같은 CLI를 사용한다. `tests/execution.test.mjs`가 missing value, stale config, missing infra, config drift의 main 미실행과 올바른 argv/순서를 확인한다. 프로필 자체에서 빠진 요구와 검증 명령의 충분성은 entrypoint·config loader·infra·CI 대조 리뷰 대상이며 임의 shell 실행을 OS 차원에서 가로막지는 않는다.

## Fresh Spec 적대적 리뷰

spec-me의 Product/Architecture 초안을 각각 새 reviewer로 검토한다. 요청 원문·확정 답변과 현행 프로젝트 근거만 전달하고 parent/writer 분석은 상속하지 않는다. `src/workflow/spec-review.mjs`가 필수/추가 입력 hash, reviewer ID/author 분리·fresh 옵션 기록, pass 판정과 미해결 중대 finding 부재를 검사한다. stage gate와 lifecycle spec_reviews가 같은 함수를 사용하며 completeWorkflow는 spec-me/to-ticket의 해당 hook 제거도 복원한다. `tests/spec_review.test.mjs`와 installed completion 검사가 누락·self/cross-axis author·상속·중대 지적·stale Spec/Product/source 및 hook 제거를 검사한다. hash는 실제 subagent 실행·읽기·의미적 판단을 증명하지 않는다. caller는 원본 tool/agent 결과를 보존·대조하며, 실제 fresh 리뷰를 부모 자기 검토로 대체하지 않는다.
