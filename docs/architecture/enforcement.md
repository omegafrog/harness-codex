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
| E2E 선택과 dynamic agent oracle은 필요한 경로에만 둔다 | `.codex/skills/e2e-test/references/verification-policy.md`, to-ticket/implement/runner 지침 | 의미적 수동 정책이다. 자동 runtime 판정/집행은 없다. Plan·Spec·oracle·budget을 사전 검토하고 결과 증거를 대조한다 |
| Harness 갱신 후 정리는 설치 산출물과 프로젝트 변경을 구분하고 미커밋 준비 문서를 보존한다 | `AGENTS.md`, `setup/SKILL.md`, `implement/GUIDE.md`의 정리 절차; 설치형 Harness 경로는 `git check-ignore -v`로 확인 | `.gitignore`/`.git/info/exclude`는 tracked modifications를 보호하지 않으므로 변경·미추적 파일 백업과 소유권 분류는 정리 주체가 확인한다 |

## 통합 계약 완료 gate

Spec·계획 리뷰의 반복 제한은 `src/workflow/review-attempts.mjs`와 두 리뷰 CLI의 `begin/record/abort/resolve`가 관리한다. 대상·축별 실행 중복, 미변경 입력 재요청, 최초 검토 후 재검토 2회 초과를 차단하고 원본 판정·지적·stale을 session에 보존한다. 시작된 검토의 pass 기록은 기존 Spec·계획 gate에서 확인한다. 사용자 결정의 진위, 리뷰 전 문서 일괄 반영과 reviewer 역할 선택은 호출자의 검토 계약이다. 근거: 세션 `01a1682e-92be-7642-94d2-e4ce85d070e5`의 반복 Spec·계획 리뷰 및 Learning 자료 승인 대기. 신규·업데이트 설치의 실행·Git 가시성은 `spec-review-check` profile로 확인한다. 기존 실행의 receipt는 당시 검증 형식을 유지하며 새 검토부터 실행 기록을 생성한다.

`src/contracts/contracts.mjs`는 consumer 프로젝트의 `docs/contracts/` bundle을 검사한다. `contract_docs`는 모든 workflow의 `before_complete`에 등록되며 `harness-workflow-complete.mjs`가 이를 실제 호출해 pass/fail receipt를 기록한다. 시작 SHA 누락은 차단된다. `executeImplementPlan`도 실제 검증된 workspace에서 직접 검사하므로, agent가 누락하거나 pass를 주장해도 source/문서 snapshot이 어긋나면 완료 reconciliation과 종속 plan 해제가 차단된다. 순수 `evaluateCompletion`에도 pass verdict가 필수다.

문서에는 전체 Product 규칙과 DDD 구성요소별 상세를 보존한다. `.puml`의 모든 DDD 이름은 stable section으로 연결하고, renderer가 SVG에 원본 SHA를 붙인다. `seal`은 검토 사유와 변경 snapshot을 기록하고 revision을 올리며 `check`는 base보다 증가했는지 검사한다. source만 바뀌고 계약이 같으면 구체적인 영향 없음 근거를 요구한다. `architecture.html`은 같은 페이지 안에서 SVG 이름→상세 이동을 제공한다.

자동 검사가 증명하는 범위는 파일·형식·소유 관계·링크·버전·입력 정합성이다. 전체 기능 목록의 완전성, source_roots 축소의 타당성, DDD 규칙 캡슐화, 통신·분리 배포 결정의 근거와 실제 기능 회귀는 독립 reviewer와 실제 실행 evidence로 검증한다. receipt를 작성했다는 사실을 설계 승인이나 실제 제품 테스트 통과로 해석하지 않는다.

## Tracker lifecycle와 mirror gate

`src/tracker/lifecycle.mjs`의 공통 코드가 신규 v1 mirror를 exact external_ref로 연결한다. GitHub project/field metadata는 한 번의 read/check/sync invocation 안에서만 resolve하며 해당 ref의 issue/item/status는 각 검증 시 다시 읽는다. 호출 간 캐시나 오류시 성공 fallback은 없다. `readTrackerStatus`는 mirror 없이 configured exact ref의 canonical 상태를 읽으며 incomplete pagination은 오류로 둔다. `syncTrackerStatus`는 canonical 상태 변경·재조회 후 Beads를 반영하고 재조회한다. phase/classification은 metadata로 분리한다. 부분 실패는 local journal에 남기며 canonical을 rollback하지 않는다. `inspectTrackerSync`는 mirror 일관성 gate다.

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

## 설치/업데이트의 반복 수동 수리 방지

사용자 보고에서 force가 agent에만 적용되어 스킬을 손으로 교체했고, PR 템플릿 누락·stale lock·내부 eval profile의 native 미검증 오류가 남았다. install/update를 `updateProject`의 공통 native 자산 경로로 연결했다. 명시적 force만 관리 파일을 세션에 먼저 백업 후 교체하며, 기본 재설치는 기존 baseline으로 로컬 수정을 보존한다. PR 템플릿을 inventory에 포함하고 supporting files/tools/contracts/CI의 doctor inventory도 정합화했다. upstream에 없는 lock 항목은 원장만 정리하고 이전 파일은 보존한다. `eval.permission_profile`은 event label이고 실제 sandbox/network를 검사하며, 실제 native 참조만 inventory 증명을 요구한다. 검사 자체를 생략하거나 이름만 주어 미검증 권한을 승인하지 않는다. 설치·업데이트 및 doctor 회귀 검사는 EXEC의 installer-maintenance 계열 profile로 수행한다.

## 구현 전 프로젝트 준비

`inspectProjectReadiness`는 공유 실행 manifest validator와 실제 `inspectContracts`를 호출한다. install/update가 준비 부족과 다음 skill을 출력하고 doctor는 `project_preparation_required` 오류를 보고한다. `implement`는 `--for-implementation` preflight를 적용하며 실제 wrapper dispatch는 `project_readiness` lifecycle check를 강제하므로 agent의 pass 주장으로 우회하지 않는다. 기본 workspace 검사에는 준비 조건을 추가하지 않아 최초 setup/spec/계약 bootstrap 자체를 막지 않는다.

파일이 없을 때 caller는 setup의 source 조사와 sync-contracts를 수행하고 재검사한다. 기존 사용자 프로필·구현 commit·stash·tracker 상태를 보존한다. 형식 검사만으로 실제 검증 범위·모델의 의미를 증명하지 않으며 이 부분은 caller/독립 reviewer가 검토하고 실행 launcher가 실제 readiness를 검사한다.

## E2E 실패 학습과 이력 보존

반복 실패를 원인 확인 없이 다시 실행하던 흐름을 e2e-test의 failure-learning reference로 연결한다. runner는 증거/cleanup, caller는 원인 조사·실제 profile/readiness/회귀 검사 수정·재검증·프로젝트 e2e-lessons 갱신을 소유한다. 매 시도는 새 세션 하위 run 경로를 사용하며 다음 실행은 현행 lesson/예방 검사를 먼저 읽는다. 같은 원인의 반복 발생은 두 증거를 기준으로 correct를 적용한다. 미확정 원인을 영구 규칙으로 승격하지 않는다. E2E 실행은 E2E/full-stack/browser end-to-end 명시 요청 또는 cheaper checks로 입증할 수 없는 변경 critical cross-boundary 위험으로 제한하고, 일반 검증/서비스 실행 요청은 E2E 요청으로 해석하지 않는다. UI 변경만으로 full-stack 실행을 요구하지 않는다. Agent 응답은 승인 oracle과 trace를 기준으로 검증하며, 동적 prose를 고정하거나 runner가 test/source를 수정하지 않는다. 최초 시도와 진단 후 최대 한 번 재실행 budget을 handoff 간 공유한다. 이 policy는 manual review이며 자동 강제되지 않는다.

`mergeTests`는 ID별 e2e_failures를 누적하고 원본 증거를 보존한다. 현재 테스트 결과는 lifecycle tests gate와 wrapper 완료 판정이 확인한다. `e2eLearningComplete`는 학습 상태만 별도로 보고하며 과거 실패의 원인 분석·지침 갱신 미완료로 테스트 통과나 workflow 완료를 막지 않는다. `not_reusable`은 판단 근거만 기록한다. `tests/e2e_learning.test.mjs`와 e2e-learning-check 프로필은 성공 결과와 학습 pending의 공존, 실제 테스트 실패 차단 및 이력 보존을 검증한다. 원인과 예방 효과의 타당성은 증거 리뷰로 판단한다.

## 요구사항·계획·구현 추적

`src/workflow/plan-traceability.mjs`는 `docs/plans/<plan-set-id>/traceability.json`의 요구사항 inventory를 Product/Architecture 및 자동 발견한 요청·결정·다이어그램·현행 계약과 대조한다. `to-ticket` 완료는 독립 `plan_reviewer`가 전체 canonical 계획을 읽은 현재 hash를 요구한다. wrapper dispatch는 workspace preflight 뒤 실제 ledger·Spec·계획·tracker body를 다시 읽고, 미통과 시 implementer spawn 전에 차단한다. completion은 구현/검증 파일 hash와 선택한 실행 profile의 성공 harness-exec receipt를 확인하며, receipt의 현재 설정 hash와 session log 위치도 확인한다. lifecycle completion도 원장 검사를 재실행한다.

`tests/plan_traceability.test.mjs`와 `plan-traceability-check` profile이 원장/coverage/review/impact/evidence 및 실제 dispatch 차단을 검사한다. 자동 검사는 구조·현재성·receipt 형식을 증명하지만 source 요구가 의미상 완전하게 inventory 되었는지, 분해된 acceptance criteria를 함께 만족해도 원래 규칙을 위반하는 구현이 가능한지는 증명하지 않는다. 독립 reviewer가 원문과 전체 계획에서 counterexample을 찾아 판단한다. Receipt 구조 검사는 작성 주체의 암호학적 신원을 증명하지 않는다.

## Spring Boot Diagnostic Log Schema v1

사용자가 제공한 정규화 LogRecord 계약을 victorialogs-local-setup assets의 JSON Schema/Markdown으로 배포한다. validateDiagnosticLog와 helper validate-logs는 일곱 이벤트의 필수 Resource/Attributes·typed 값·outcome·timestamp·Trace/Span을 원본 JSON/JSONL에서 검사한다. 설치 helper는 공용 구현/테스트 지침과 offline profile을 연결한다. diagnostic-log-check 및 installer-maintenance-python profile은 올바른 이벤트와 누락·타입·outcome 오류, 설치 후 profile 실행·중복 없는 지침 갱신·collector 보완을 검사한다. generic Logstash/OTLP wire format·저장 후 string 표현은 구분한다. 실제 context 유무·async 전파·MDC 정리·monotonic duration·redaction과 수집 의미는 emitter 관련 집중 검증/리뷰 범위이며 형식 검사로 자동 증명한다고 주장하지 않는다.
