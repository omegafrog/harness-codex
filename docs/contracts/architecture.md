# Harness DDD Architecture 계약

[통합 Product 계약](product.md) · [DDD SVG](diagrams/ddd.svg) · [클릭 가능한 HTML 보기](architecture.html)

현재 배포는 단일 Node.js package이며 내부는 함수/모듈 호출을 사용한다. 조사한 구현은 객체형 Aggregate를 선언하지 않는다. 아래 서비스명은 실제 모듈 경로의 책임을 가리키며 별도 서버나 새로운 Aggregate 선언이 아니다. root/entity/VO를 임의로 추가하지 않는다. 향후 도입하면 실제 identity·불변식·transaction 경계와 함께 해당 kind를 등록한다. 변경 제안은 accepted-target과 승인 Spec 링크를 별도 기록하고 검증 후 전환한다. worktree lifecycle은 [workspace 상태](diagrams/workspace.state.svg), 현재 업무 상태는 [checkpoint 상태](diagrams/checkpoint.state.svg), 정적 클래스 관계는 [class](diagrams/runtime.class.svg), 설계부터 구현 인계까지는 [delivery sequence](diagrams/delivery.sequence.svg)를 본다.

<a id="control-plane"></a>
## harness/control-plane
수정일: 2026-10-20

### 설명
Harness의 단일 Bounded Context. workflow·review·evidence·실행 상태를 제어한다. 아래 내부 모듈은 독립 Context가 아니다.

### 커뮤니케이션
다른 내부 Context는 현재 없다. 내부는 동기 함수 호출/Promise로 연결한다. 외부 [Codex](architecture.md#codex-external)는 subprocess/plugin CLI, [SigNoz](architecture.md#signoz-external)는 선택적으로 설정하는 MCP, [GitHub](architecture.md#github-external)와 [Beads](architecture.md#beads-external)는 adapter/CLI 경계다. 파일 journal의 append/replay와 tracker 상태는 별개 경계이며 분산 transaction이나 exactly-once를 가정하지 않는다. 실패는 checkpoint와 retry/unblock 근거를 남긴다.

### 내부 구성요소
[installer-service](architecture.md#installer-service) · [doctor-service](architecture.md#doctor-service) · [workspace-service](architecture.md#workspace-service) · [wrapper-service](architecture.md#wrapper-service) · [decision-service](architecture.md#decision-service) · [evidence-service](architecture.md#evidence-service) · [eval-service](architecture.md#eval-service) · [contracts-service](architecture.md#contracts-service) · [checkpoint-store](architecture.md#checkpoint-store) · [workflow-completion-service](architecture.md#workflow-completion-service) · [tracker-lifecycle](architecture.md#tracker-lifecycle) · [workflow-worktrees](architecture.md#workflow-worktrees) · [session-output-service](architecture.md#session-output-service) · [execution-service](architecture.md#execution-service) · [spec-review-service](architecture.md#spec-review-service) · [plan-traceability-service](architecture.md#plan-traceability-service)

### 배포
현재 package.json의 CLI가 같은 package로 배포된다. 측정된 독립 release·장애 격리·성능 요구가 현재 경계로 충족되지 않을 때 별도 배포를 검토한다. broker나 모듈별 서버를 선제 도입하지 않는다.

<a id="codex-external"></a>
## Codex CLI
수정일: 2026-10-16

### 설명
control-plane이 사용하는 외부 시스템.

### 인터페이스
codex exec: 격리 agent process 실행·결과 수집. 프로세스 실패와 사용자 코드 실패를 구분한다.

Codex plugin CLI: `plugin marketplace list/add`로 marketplace를 사용자 Codex 설정에 등록한다. Plugin 설치와 MCP endpoint 설정은 Codex UI/공식 setup skill이 담당한다.

### 외부 명세
[Codex CLI 인터페이스 명세](https://developers.openai.com/codex/cli/reference/)

<a id="signoz-external"></a>
## SigNoz
수정일: 2026-10-20

### 설명
Codex용 공식 agent skills/plugin과 선택적인 SigNoz MCP 관측 데이터 연동. Harness 설치는 SigNoz backend나 앱 instrumentation을 설치·실행하지 않는다.

### 인터페이스
SigNoz MCP: SigNoz Cloud 또는 사용자가 운영하는 self-hosted endpoint를 통해 logs·traces·metrics·alerts를 조회한다. Endpoint 설정과 인증은 Codex 공식 plugin/setup 절차에서 수행한다. MCP 결과는 외부 데이터로 취급한다.

### 외부 명세
[공식 SigNoz Agent Skills & Plugin](https://signoz.io/docs/ai/agent-skills/) · [공식 SigNoz MCP Server](https://signoz.io/docs/ai/signoz-mcp-server/)

<a id="github-external"></a>
## GitHub Issues
수정일: 2026-10-16

### 설명
control-plane이 사용하는 외부 시스템.

### 인터페이스
Issues/PR REST 및 gh CLI: 계획·상태·PR 본문을 읽고 권한 있는 변경을 전달한다. selected tracker가 상태의 기준이다.

### 외부 명세
[GitHub Issues 인터페이스 명세](https://docs.github.com/en/rest/issues/issues)

<a id="beads-external"></a>
## Beads
수정일: 2026-10-16

### 설명
control-plane이 사용하는 외부 시스템.

### 인터페이스
bd CLI: plan task·의존성·handoff를 보존하고 tracker 전이를 mirror한다. linked worktree에서 workspace를 공유한다.

### 외부 명세
[Beads 인터페이스 명세](https://github.com/steveyegge/beads)

<a id="installer-service"></a>
## src/installer/update.mjs
수정일: 2026-10-20

### 설명
설치 CLI가 프로젝트 자산 동기화와 SigNoz marketplace 등록을 조립한다. 프로젝트 자산 동기화는 src/installer/update.mjs가, marketplace 등록은 bin/harness-install.mjs가 담당한다. 구현 상태: implemented. [자산 동기화 소스](../../src/installer/update.mjs) · [설치 CLI](../../bin/harness-install.mjs).

### 메서드
[updateProject](architecture.md#update-method) · [registerSigNozMarketplace](architecture.md#register-signoz-marketplace-method)

### 필요 엔티티
사용자 파일·source descriptor·managed lock (현재 객체형 DDD entity는 별도 선언하지 않는다).

### 동작
관리 자산 발견→hash 비교→충돌 보존→허용된 파일 갱신과 lock 반영. install은 공식 SigNoz marketplace를 사용자 Codex 설정에 등록한다. Plugin 설치, MCP endpoint와 인증은 사용자가 Codex에서 구성한다. update는 plugin/MCP 상태를 변경하지 않는다.

<a id="update-method"></a>
## updateProject
수정일: 2026-10-19

### 설명
updateProject의 실제 public entrypoint. [소스](../../src/installer/update.mjs).

### 필요 엔티티
사용자 파일·source descriptor·managed lock

### 동작
관리 자산 발견→hash 비교→충돌 보존→허용된 파일 갱신과 lock 반영.

설치·업데이트는 updateProject의 initialize/force/scope로 같은 native 자산 동기화 경로를 사용한다. 선택한 스킬 및 supporting files·agent·workflow/runtime·CI·PR 템플릿을 관리하며 기본 충돌은 보존한다. 명시적 force는 교체 파일을 session/runtime/installer-backups/에 먼저 백업하고 경로를 반환한다. partial install은 다른 scope baseline을 변경하지 않고, 재설치가 로컬 수정을 먼저 lock으로 승인하지 않는다. upstream inventory에서 사라진 lock 항목은 원장만 제거하고 기존 파일은 보존한다. 프로젝트 harness.yaml은 교체하지 않는다. CLI는 동기화 후 [inspectProjectReadiness](../../src/workflow/project-readiness.mjs)를 호출해 런타임 설치와 소비 프로젝트 준비 상태를 구분하고 setup·sync-contracts 복구 행동을 출력한다.

<a id="register-signoz-marketplace-method"></a>
## registerSigNozMarketplace
수정일: 2026-10-20

### 설명
`bin/harness-install.mjs`의 SigNoz marketplace 등록 단계. [소스](../../bin/harness-install.mjs).

### 필요 엔티티
Codex marketplace 등록 상태

### 동작
공식 `SigNoz/agent-skills` marketplace를 등록한다. 같은 marketplace 이름이 다른 source를 가리키면 중단하며 동일 source가 있으면 재사용한다. 사용자는 Codex UI에서 plugin 설치와 MCP endpoint를 설정한다. Harness는 SigNoz backend와 앱 SDK를 설치하지 않는다.

<a id="doctor-service"></a>
## src/doctor/doctor.mjs
수정일: 2026-10-19

### 설명
현재 src/doctor/doctor.mjs 모듈의 책임. 구현 상태: implemented. [소스](../../src/doctor/doctor.mjs).

### 메서드
[runDoctor](architecture.md#doctor-method)

### 필요 엔티티
설치 설정·runtime·진단 결과 (현재 객체형 DDD entity는 별도 선언하지 않는다).

### 동작
프로젝트 설정을 읽고 진단을 조립하며 오류와 복구 항목을 반환한다.

<a id="doctor-method"></a>
## runDoctor
수정일: 2026-10-19

### 설명
runDoctor의 실제 public entrypoint. [소스](../../src/doctor/doctor.mjs).

### 필요 엔티티
설치 설정·runtime·진단 결과

### 동작
프로젝트 설정을 읽고 진단을 조립하며 오류와 복구 항목을 반환한다.

eval permission_profile은 실행 event label로 취급하고 실제 sandbox/network 설정과 일관성을 검사한다. 명시적 agent permission_profile 및 eval.codex.command의 --permission-profile/-P만 native inventory 확인 대상으로 둔다. 실제 미검증/누락 참조는 계속 실패한다. 최신 자산 inventory는 skill supporting files·tools·contracts·CI·PR을 포함해 잘못된 stale lock 경고를 방지한다.

실제 inspectProjectReadiness가 EXEC.md와 공유 readExecutionManifest의 schema/profile 검증, inspectContracts의 전체 snapshot 검증을 조립한다. 부족하면 project_preparation_required error와 next_steps를 반환한다. 진단은 명령 실행·문서 생성·사용자 설정 덮어쓰기를 하지 않는다.

<a id="workspace-service"></a>
## .codex/scripts/workspace-preflight-cli.mjs
수정일: 2026-10-19

### 설명
현재 .codex/scripts/workspace-preflight-cli.mjs 모듈의 책임. 구현 상태: implemented. [소스](../../.codex/scripts/workspace-preflight-cli.mjs).

### 메서드
[runWorkspacePreflightCli](architecture.md#workspace-method)

### 필요 엔티티
expected root·cwd·Git worktree 등록 (현재 객체형 DDD entity는 별도 선언하지 않는다).

### 동작
inspectWorkspace 결과를 CLI JSON/exit code로 전달한다. 불일치면 후속 실행을 차단한다. --for-implementation은 inspectProjectReadiness를 추가 실행하며 최초 bootstrap용 기본 검사는 유지한다.

<a id="workspace-method"></a>
## runWorkspacePreflightCli
수정일: 2026-10-19

### 설명
runWorkspacePreflightCli의 실제 public entrypoint. [소스](../../.codex/scripts/workspace-preflight-cli.mjs).

### 필요 엔티티
expected root·cwd·Git worktree 등록

### 동작
inspectWorkspace 결과를 CLI JSON/exit code로 전달한다. 불일치면 후속 실행을 차단한다. --for-implementation은 inspectProjectReadiness를 추가 실행하며 최초 bootstrap용 기본 검사는 유지한다.

<a id="wrapper-service"></a>
## src/wrapper/dispatch.mjs
수정일: 2026-10-20

### 설명
현재 src/wrapper/dispatch.mjs 모듈의 책임. 구현 상태: implemented. [소스](../../src/wrapper/dispatch.mjs).

### 메서드
[executeImplementPlan](architecture.md#execute-method)

### 필요 엔티티
plan·checkpoint·fixed point·review 결과·tracker snapshot (현재 객체형 DDD entity는 별도 선언하지 않는다).

### 동작
workspace 검증→구현→테스트 evidence 복구→독립 리뷰/repair→retirement·통합 계약 검사→완료 reconciliation→tracker/dependent 판정→cleanup. 규칙은 reviewer와 해당 gate에 위임한다.

<a id="execute-method"></a>
## executeImplementPlan
수정일: 2026-10-20

### 설명
executeImplementPlan의 실제 public entrypoint. [소스](../../src/wrapper/dispatch.mjs).

### 필요 엔티티
plan·checkpoint·fixed point·review 결과·tracker snapshot

### 동작
workspace 검증→구현→테스트 evidence 복구→독립 리뷰/repair→retirement·통합 계약 검사→완료 reconciliation→tracker/dependent 판정→cleanup. 규칙은 reviewer와 해당 gate에 위임한다.

dispatchImplementPlan의 before_dispatch는 workspace·tracker_sync와 실제 project_readiness를 검사한다. managed worktree caller는 source project root(`return_root`)를 absolute `shared_guidance_root`로 구현/test worker에 전달하고, 동일 Git common directory인지 검증한다. implementer는 공유 구현·테스트 지침을 읽고, test runner는 공유 테스트 지침을 읽는다. worker는 branch-local copy를 참조하지 않는다. 실패 시 spawn 이전에 중단하고 원인/다음 준비 행동을 남긴다. caller는 setup·sync-contracts로 누락을 보완하고 실행 기준 branch에 보존한 다음 fixed point와 분기를 확정한다. 이 준비는 기존 구현 commit·stash·tracker 상태를 되돌리지 않는다.

구현 caller는 현행 `docs/agents/implementation-guidance.md`를 구현 agent와 함께 읽는다. spec-me/사용자 설계 대화는 명시적이고 재사용 가능한 구현 지침을 출처·범위와 함께 갱신하며, 구현 지침과 ticket Spec이 충돌하면 구현을 보류한다. E2E caller는 현행 docs/verification/e2e-lessons.md와 연결된 profile/검사를 읽고 runner의 모든 실패를 tests.e2e_failures로 전달한다. 공통 completeWorkflow는 보고된 e2e_failures가 있으면 workflow manifest가 생략한 tests gate도 복원한다. 공유 [e2eFailuresResolved](../../src/eval/contracts.mjs)는 lifecycle tests gate와 wrapper testsPassed가 재사용한다. verified·확정 분류·원인·scenario/profile·원본/재검증 증거·lesson·예방 경로의 형식이 없으면 완료하지 않는다. 실제 증거 내용/원인/예방 충분성은 독립 reviewer 책임이며, 미보고 실패를 자동 탐지한다고 주장하지 않는다. E2E 선택도 `.codex/skills/e2e-test/references/verification-policy.md`의 의미적 수동 정책으로 관리하며 자동 runtime schema/판정기가 아니다. 기본은 focused unit/integration/contract 검사다. E2E는 E2E/full-stack/browser end-to-end 명시 요청 또는 저비용 검사로 확인할 수 없는 변경 critical cross-boundary에 한하며, 일반 테스트/검증이나 서비스 실행 요청만으로 E2E를 추정하지 않는다. agent 서비스는 trace/correlation ID 기반 goal/state/tool contract/permission/persistence/side effect를 확인하고 dynamic prose를 exact match하지 않는다. 첫 실행 전 oracle을 고정하고 scenario별 총 2회(최초+진단 재실행 1회)로 제한한다.

<a id="decision-service"></a>
## src/decision/review.mjs
수정일: 2026-10-16

### 설명
현재 src/decision/review.mjs 모듈의 책임. 구현 상태: implemented. [소스](../../src/decision/review.mjs).

### 속성
| 속성 | 타입 | 설명 |
|---|---|---|
| 인스턴스 상태 | 해당 없음 | 함수형 무상태 모듈이다. 입력 artifact의 상태를 검사하며 모듈 내부에 업무 객체 상태를 보유하지 않는다. |

### 메서드
[evaluateDecisionGate](architecture.md#decision-method)

### 비즈니스 규칙
BR-decisions: 승인·근거·review 상태의 충분성을 판단한다. 여러 artifact의 계약이어서 entity 없는 함수형 모델에서 이 모듈이 규칙을 소유한다.

<a id="decision-method"></a>
## evaluateDecisionGate
수정일: 2026-10-16

### 설명
evaluateDecisionGate의 실제 public entrypoint. [소스](../../src/decision/review.mjs).

### 비즈니스 규칙
BR-decisions: 승인·근거·review 상태의 충분성을 판단한다. 여러 artifact의 계약이어서 entity 없는 함수형 모델에서 이 모듈이 규칙을 소유한다. 기능 [decisions](product.md#decisions)의 규칙과 수용 조건을 적용하며 검증은 해당 Product section의 테스트를 참조한다.

<a id="evidence-service"></a>
## src/knowledge/evidence.mjs
수정일: 2026-10-16

### 설명
현재 src/knowledge/evidence.mjs 모듈의 책임. 구현 상태: implemented. [소스](../../src/knowledge/evidence.mjs).

### 속성
| 속성 | 타입 | 설명 |
|---|---|---|
| 인스턴스 상태 | 해당 없음 | 함수형 무상태 모듈이다. 입력 artifact의 상태를 검사하며 모듈 내부에 업무 객체 상태를 보유하지 않는다. |

### 메서드
[approveEvidenceSummary](architecture.md#evidence-method)

### 비즈니스 규칙
BR-evidence: 공개 summary 승인 전이를 검증한다. 게시와 승인 artifact의 관계를 이 모듈이 소유하며 호출자가 상태를 임의로 우회하지 않는다.

<a id="evidence-method"></a>
## approveEvidenceSummary
수정일: 2026-10-16

### 설명
approveEvidenceSummary의 실제 public entrypoint. [소스](../../src/knowledge/evidence.mjs).

### 비즈니스 규칙
BR-evidence: 공개 summary 승인 전이를 검증한다. 게시와 승인 artifact의 관계를 이 모듈이 소유하며 호출자가 상태를 임의로 우회하지 않는다. 기능 [evidence](product.md#evidence)의 규칙과 수용 조건을 적용하며 검증은 해당 Product section의 테스트를 참조한다.

<a id="eval-service"></a>
## src/eval/runner.mjs
수정일: 2026-10-16

### 설명
현재 src/eval/runner.mjs 모듈의 책임. 구현 상태: implemented. [소스](../../src/eval/runner.mjs).

### 메서드
[runSuite](architecture.md#suite-method)

### 필요 엔티티
suite·case·격리 workspace·grader 결과 (현재 객체형 DDD entity는 별도 선언하지 않는다).

### 동작
case 실행→측정·분류→report·event 보존→cleanup을 조립한다. 모델/인증 제약은 inconclusive로 보존한다.

<a id="suite-method"></a>
## runSuite
수정일: 2026-10-16

### 설명
runSuite의 실제 public entrypoint. [소스](../../src/eval/runner.mjs).

### 필요 엔티티
suite·case·격리 workspace·grader 결과

### 동작
case 실행→측정·분류→report·event 보존→cleanup을 조립한다. 모델/인증 제약은 inconclusive로 보존한다.

<a id="contracts-service"></a>
## src/contracts/contracts.mjs
수정일: 2026-10-16

### 설명
현재 src/contracts/contracts.mjs 모듈의 책임. 구현 상태: implemented. [소스](../../src/contracts/contracts.mjs).

### 속성
| 속성 | 타입 | 설명 |
|---|---|---|
| 인스턴스 상태 | 해당 없음 | 함수형 무상태 모듈이다. 입력 artifact의 상태를 검사하며 모듈 내부에 업무 객체 상태를 보유하지 않는다. |

### 메서드
[inspectContracts](architecture.md#inspect-method) · [sealContracts](architecture.md#seal-method)

### 비즈니스 규칙
BR-contracts-feature: 필수 구성·source/diagram 정합성·version을 판정한다. inspect는 읽기 전용이다. 의미적 DDD 적합성은 별도 reviewer 책임이다.

<a id="inspect-method"></a>
## inspectContracts
수정일: 2026-10-16

### 설명
inspectContracts의 실제 public entrypoint. [소스](../../src/contracts/contracts.mjs).

### 비즈니스 규칙
BR-contracts-feature: 필수 구성·source/diagram 정합성·version을 판정한다. inspect는 읽기 전용이다. 의미적 DDD 적합성은 별도 reviewer 책임이다. 기능 [contracts-feature](product.md#contracts-feature)의 규칙과 수용 조건을 적용하며 검증은 해당 Product section의 테스트를 참조한다.

<a id="seal-method"></a>
## sealContracts
수정일: 2026-10-16

### 설명
검토한 통합 계약 버전과 snapshot·HTML을 기록한다. [소스](../../src/contracts/contracts.mjs).

### 비즈니스 규칙
BR-contracts-feature: source만 바뀌면 계약 수정 또는 영향 없음의 구체적 검토 사유를 요구한다. 형식 검사 후 version 증가·원본 hash·HTML을 기록한다. 동일 입력은 버전을 올리지 않는다. 실패는 pass로 기록하지 않는다.

<a id="checkpoint-store"></a>
## PlanCheckpointStore
수정일: 2026-10-16

### 설명
append-only journal로 plan 상태를 보존하는 실제 class. Aggregate root로 선언하지 않는다. [소스](../../src/wrapper/checkpoint.mjs).

### 필요 엔티티
plan ID·workflow status·tests·lifecycle evidence·event writer.

### 동작
write는 event를 보존하고 read는 replay/projection을 복구한다. 이전 traceability/measurements는 생략 시 보존하되 새 테스트 실패는 이전 pass로 가리지 않는다.

### 메서드
[write](architecture.md#checkpoint-write) · [read](architecture.md#checkpoint-read)

<a id="checkpoint-write"></a>
## write
수정일: 2026-10-16

### 설명
PlanCheckpointStore.write public method.

### 필요 엔티티
plan checkpoint·append-only events.

### 동작
patch를 검증하고 journal append와 projection 보존을 조립한다.

mergeTests는 tests.e2e_failures를 ID별로 합친다. 성공 요약/빈 배열에서도 기존 항목을 유지하고 중복 ID·원본 evidence_path 교체·객체 아닌 요약으로 이력 삭제를 거부한다. 수정본은 같은 ID의 원인/조치/재검증을 보완하며, 새 발생은 새 ID로 남긴다. handoff/reconcile/replay는 이 checkpoint 증거를 보존한다. raw 로그는 workspace 세션에 남고, 다음 실행의 검증된 지식은 프로젝트 lesson과 실제 EXEC/profile/test에 반영한다.

<a id="checkpoint-read"></a>
## read
수정일: 2026-10-16

### 설명
PlanCheckpointStore.read public method.

### 필요 엔티티
plan checkpoint·append-only events.

### 동작
journal을 읽고 replay하여 checkpoint를 복원한다.

<a id="workflow-completion-service"></a>
## src/workflow/completion.mjs
수정일: 2026-10-17

### 설명
모든 manifest workflow의 정상 완료를 판정하는 공통 실행 경계. [소스](../../src/workflow/completion.mjs).

### 필요 엔티티
시작 commit SHA·workflow ID·검증된 workspace·기존 lifecycle evidence·journal writer.

### 동작
workspace preflight→manifest 로드→필수 tracker_sync·contract_docs와 선언된 before_complete 실행→pass만 completed→실제 verdict journal 보존. 로컬 manifest가 contract_docs를 지워도 필수 검사를 복원한다. 시작 commit과 evidence가 없으면 정상 완료하지 않는다.

### 메서드
[completeWorkflow](architecture.md#complete-workflow-method)

<a id="complete-workflow-method"></a>
## completeWorkflow
수정일: 2026-10-17

### 설명
전체 workflow 완료 명령이 호출하는 public 함수.

### 필요 엔티티
workflow_id·절대 workspace_root·base_ref(SHA)·outcome/test/review 등 state.

### 동작
공통 lifecycle hook과 계약 검사에 조립을 위임한다. pass/fail 모두 journal에 기록하고, preflight/manifest/hook/기록 오류를 포함한 outer finally가 소유 worktree를 archive·검증·제거한다. journal은 worktree 바깥 영속 session_directory/runtime/workflow-completion/에 직접 기록하며 삭제 후에도 경로를 유지한다. cleanup 실패도 in-progress이며 정상 완료가 아니다. 다음 단계는 보존 branch로 새 worktree를 만든다.

<a id="tracker-lifecycle"></a>
## src/tracker/lifecycle.mjs
수정일: 2026-10-16

### 설명
기존 tracker 모듈 내부에서 configured tracker와 Beads의 네 lifecycle 상태를 연결하는 조립 책임. 독립 Bounded Context·Aggregate·배포 서버를 만들지 않는다. [소스](../../src/tracker/lifecycle.mjs).

### 필요 엔티티
설정된 tracker·exact external_ref·v1 Beads mirror·phase/classification metadata·실행 결과·local journal. 객체형 DDD entity는 별도 선언하지 않는다.

### 동작
GitHub Workflow Status 또는 local YAML frontmatter가 canonical이다. 단일 exact ref를 확인한 후 canonical 갱신→재조회→Beads 반영→재조회한다. read-only 상태 조회는 Beads mirror를 요구하지 않고 설정된 repo+issue를 exact lookup하며 incomplete pagination은 오류로 반환한다. GitHub project/field metadata는 하나의 read/check/sync 호출 안에서만 한 번 resolve하며 각 issue/item/status 확인은 매번 다시 한다. 호출 사이에 재사용하거나 조회 실패를 우회하지 않는다. 실패는 journal에 기록하고 canonical을 되돌리지 않는다. 기본 Project Status와 GitHub Issue open/closed는 갱신하지 않는다. local ticket은 본문을 보존하고 같은 directory의 임시 파일을 rename하여 교체한다. 기존 데이터는 migration하지 않는다.

### 메서드
[inspectTrackerSync](architecture.md#inspect-tracker-sync) · readTrackerStatus · [syncTrackerStatus](architecture.md#sync-tracker-status)

<a id="inspect-tracker-sync"></a>
## inspectTrackerSync
수정일: 2026-10-16

### 설명
v1 managed mirror만 대상으로 실제 tracker와 Beads를 읽는 시작/종료 gate.

### 필요 엔티티
workspace_root·선택 ref 목록 또는 정수 harness_tracker_version=1이 있는 신규 mirror.

### 동작
네 상태 매핑과 phase/classification 유효성을 확인한다. missing/duplicate ref·알 수 없는 상태·통신 실패·mirror 불일치는 실패다. legacy/로컬 운영 Bead는 자동 연결하거나 재분류하지 않는다. workspace preflight, dispatch 직전, generic 완료 hook과 실제 wrapper completion에서 검사하며 실패 시 생성/완료/종속 해제를 차단한다.

<a id="sync-tracker-status"></a>
## syncTrackerStatus
수정일: 2026-10-16

### 설명
공통 CLI가 사용하는 멱등 상태 동기화 진입점.

### 필요 엔티티
workspace_root·ticket_ref·선택 status·phase·classification·injected execFile runner.

### 동작
status는 planned/in-progress/blocked/completed만 허용한다. backlog는 harness_classification, planning/implementation/test/review는 harness_phase로 보존한다. backlog를 실행하려면 committed로 분류해야 한다. ref 중복은 변경 전 차단하고, canonical 갱신 후 Beads 실패 시 업무 상태를 되돌리거나 Blocked로 덮지 않는다. local journal에 실패·요청한 phase/classification·재시도 방법을 남긴다. status를 생략한 재시도는 최신 canonical을 따르며 실패 기록의 metadata flag는 재전달하여 단계 변경 의도도 복구한다. 외부 CLI를 shell 없이 인자 배열로 호출하며 API/권한 실패를 성공으로 보고하지 않는다.

<a id="workflow-worktrees"></a>
## src/workflow/worktrees.mjs
수정일: 2026-10-17

### 설명
기존 control-plane의 workflow worktree 소유권·종료 조립 책임이다. 별도 Context/서버를 도입하지 않는다. [소스](../../src/workflow/worktrees.mjs).

### 필요 엔티티
Git common directory·소유 receipt·workflow ID·branch/HEAD·return_root·작업 파일과 staged index·종료 outcome.

### 동작
Git add 전에 경로 소유권을 예약한다. 완료/실패/사용자 중단/handoff는 writer 종료 후 session_directory/recovery/에 tracked/untracked/ignored 파일·index를 보존하고 tree/HEAD/index를 검증한 뒤 소유 linked worktree만 제거한다. branch와 HEAD/staged object recovery ref는 유지한다. 비소유/primary workspace는 제거하지 않는다. 동일 경로 reserve/register/finish는 PID lock으로 직렬화하고, 삭제 후 receipt 기록 실패도 재시도로 복구한다. archive 실패나 Git lock은 제거 실패로 보고하며 우회하지 않는다. SIGKILL/전원 종료는 다음 진입의 pending receipt 확인 후 finish로 복구한다.

### 메서드
[createWorkflowWorktree](architecture.md#create-workflow-worktree) · [reserveWorkflowWorktree](architecture.md#reserve-workflow-worktree) · [registerWorkflowWorktree](architecture.md#register-workflow-worktree) · [finishWorkflowWorktree](architecture.md#finish-workflow-worktree) · [listWorkflowWorktrees](architecture.md#list-workflow-worktrees)
<a id="create-workflow-worktree"></a>
## createWorkflowWorktree
수정일: 2026-10-17

### 설명
workflow worktree lifecycle의 public 진입점.

### 필요 엔티티
source workspace·workflow ID·선택 기존 branch·AbortSignal.

### 동작
깨끗한 source에서 새 sibling worktree/branch를 만들거나 보존 branch로 새 경로를 만든다. reservation을 Git add 전에 기록하고 생성/등록 오류·abort도 finish로 정리한다.

<a id="reserve-workflow-worktree"></a>
## reserveWorkflowWorktree
수정일: 2026-10-17

### 설명
workflow worktree lifecycle의 public 진입점.

### 필요 엔티티
예정 workspace 경로·repository_root·workflow ID·예정 branch.

### 동작
아직 존재하지 않는 경로의 allocating 소유 receipt를 공용 Git directory에 기록한다. 경로 lock을 잡고 확인하므로 중복 allocation의 패자가 승자 worktree를 정리하지 못한다.

<a id="register-workflow-worktree"></a>
## registerWorkflowWorktree
수정일: 2026-10-17

### 설명
workflow worktree lifecycle의 public 진입점.

### 필요 엔티티
실제 linked worktree·workflow ID·return_root.

### 동작
등록된 Git 경로·common directory·branch를 확인하고 active 소유권을 보존한다. primary worktree와 다른 활성 소유자/미해결 cleanup은 거부한다. 자동으로 임의 사용자 worktree를 채택하지 않는다.

<a id="finish-workflow-worktree"></a>
## finishWorkflowWorktree
수정일: 2026-10-17

### 설명
workflow worktree lifecycle의 public 진입점.

### 필요 엔티티
소유 workspace·살아 있는 repository_root·workflow ID·종료 outcome.

### 동작
파일/index snapshot과 보호 ref를 만들고 검증한 후 Git remove를 수행한다. 같은 요청 재시도는 idempotent이며 잠금/백업 실패는 실패로 반환한다. 복구 자료는 동일 session_directory/recovery/에 남고 Git 등록 해제를 확인한다. 로그·journal은 같은 세션의 원래 경로에 남는다.

<a id="list-workflow-worktrees"></a>
## listWorkflowWorktrees
수정일: 2026-10-17

### 설명
workflow worktree lifecycle의 public 진입점.

### 필요 엔티티
살아 있는 repository workspace.

### 동작
allocating/active/archived/cleanup-failed receipt를 조회한다. 이전 실행이 멈춘 것을 확인한 뒤에만 finish를 재시도하고 다른 활성 실행은 건드리지 않는다.


<a id="session-output-service"></a>
## src/workflow/session-output.mjs
수정일: 2026-10-17

### 설명
기존 control-plane 내부의 파일 출력 경계 조립 책임이다. 별도 Context·Aggregate·서버를 만들지 않는다. [소스](../../src/workflow/session-output.mjs).

### 필요 엔티티
절대 workspace_root·살아 있는 repositoryRoot·Git common directory·상대 출력 경로.

### 동작
worktree별 영속 세션 디렉터리를 결정하고 task 소유 로그·임시 파일·실행 증거·복구 백업의 경로를 검증한다. journal/completion/tracker, plan checkpoint/workspace, eval, knowledge staging, decision review, E2E manifest가 공통 경계를 호출한다. E2E cleanup은 untracked와 ignored 경로를 함께 snapshot하여 초기 파일을 보존하고 해당 실행에서 생긴 파일만 정리한다. resolver CLI와 agent prompt는 같은 session_directory를 전달한다. approved source·최종 문서·registry와 Git/Beads metadata는 별도 관리 경로를 유지한다. 도구 전역 cache/telemetry를 통제하는 OS sandbox는 아니다.

### 메서드
[sessionDirectory](architecture.md#session-directory-method) · [sessionOutputPath](architecture.md#session-output-path-method)

<a id="session-directory-method"></a>
## sessionDirectory
수정일: 2026-10-17

### 설명
worktree 제거 후에도 보존되는 canonical 세션 디렉터리를 반환한다.

### 필요 엔티티
절대 workspaceRoot와 선택 repositoryRoot(삭제되거나 예약 중인 workspace를 대신하여 Git common directory를 찾을 살아 있는 root).

### 동작
Git common directory/harness-workflows/sessions/SHA256(절대 workspace root)를 0700으로 생성한다. 비Git fixture만 project/.codex/sessions/hash를 사용한다. 경로 구성요소의 symlink와 비디렉터리를 거부한다. 기존 자료를 이동하거나 삭제하지 않는다.

<a id="session-output-path-method"></a>
## sessionOutputPath
수정일: 2026-10-17

### 설명
세션 아래의 출력 대상 경로를 구하는 공통 함수와 CLI의 경계다.

### 필요 엔티티
절대 workspaceRoot·상대 output·선택 repositoryRoot.

### 동작
절대 경로·빈 segment·상위 이탈·symlink·공유 hardlink·특수 파일 leaf를 거부하고 부모 디렉터리를 생성한다. 디렉터리 자체도 출력 위치로 사용할 수 있다. 로그/runtime 파일은 session/runtime/, 임시 파일은 session/tmp/, 소유 receipt는 session/receipt.json, 복구 자료는 session/recovery/에 둔다. 각 process의 TMPDIR/TMP/TEMP와 browser output directory도 이 경계를 사용한다. 최종 제품 문서의 저장 위치를 바꾸는 함수는 아니다.

<a id="execution-service"></a>
## src/workflow/execution.mjs
수정일: 2026-10-19

### 설명
기존 control-plane 안에서 테스트·서버·인프라의 실행 전제와 process lifecycle을 조립한다. 별도 Context·Aggregate·배포 서버를 추가하지 않는다. [소스](../../src/workflow/execution.mjs).

### 필요 엔티티
workspace_root·profile_id·process 환경·프로젝트 execution.json·설정 원본·readiness 명령·AbortSignal·session directory. 구성 데이터이며 DDD entity로 선언하지 않는다.

### 동작
workspace preflight, 전체 argv 사전 확정, 설정 prepare/verify, 의존성 readiness polling, 설정 hash 재확인을 조립하고 main을 foreground spawn한다. shell 없이 argv를 전달한다. 호출자가 선언하지 않은 필수 인프라/설정을 자동 추론하지 않으므로 실제 source/CI와 독립 리뷰로 충분성을 검토한다. config_inputs와 실행 manifest는 매번 새로 읽는다. readiness 실패와 stale 설정은 main을 시작하지 않는다. 설치 runtime 및 harness-exec CLI도 같은 경계를 사용한다. 각 단계 stdout/stderr와 receipt는 영속 session/runtime/execution/profile-run/에 둔다. timeout/취소/실패에 소유 process group을 정리하고 외부 인프라에는 check만 수행한다. SIGKILL/전원 종료의 즉시 cleanup은 보장하지 않는다.

### 메서드
공유 readExecutionManifest는 profile ID·argv·필수 필드·상대 config 경로를 검사하고 설치 진단과 실행 launcher가 재사용한다. 준비 검사에서는 실제 명령/환경 검증을 실행하지 않으며 launcher가 매 실행마다 수행한다.

[runExecution](architecture.md#run-execution-method)

<a id="run-execution-method"></a>
## runExecution
수정일: 2026-10-19

### 설명
테스트/서비스 실행 caller와 공통 CLI의 public 진입점이다.

### 필요 엔티티
절대 workspace_root·profile_id·선택 environment/AbortSignal.

### 동작
required_env와 모든 `${VAR}`를 prepare 전 검증한다. 재실행 가능한 prepare 다음 verify_config와 모든 dependency.check를 실행하고, prepare 완료 후 검증/readiness 중 설정 변경을 감지하면 blocked receipt를 반환한다. main exit 0만 passed, nonzero/timeout은 failed, 취소는 interrupted다. 필수값이나 준비가 실패하면 command를 spawn하지 않는다. 명령 인자·secret 값은 receipt에 복사하지 않고 단계·exit_code·local log 경로·config hash를 보존한다.

실행 정리의 process group 보장은 POSIX 대상이다. native Windows는 직접 child만 종료하며 descendant 정리가 필요한 흐름은 WSL/POSIX에서 수행한다. 설정의 의도적 prepare 갱신 후에 hash를 잡고, 그 이후 verify/readiness 도중 변경을 차단한다.

<a id="spec-review-service"></a>
## src/workflow/spec-review.mjs
수정일: 2026-10-17

### 설명
기존 control-plane 안에서 완성된 Product/Architecture Spec의 독립 적대적 리뷰 기록과 현행 입력의 일치를 검증하는 조립 책임이다. 새 Context·Aggregate·배포 서버는 추가하지 않는다. [소스](../../src/workflow/spec-review.mjs).

### 필요 엔티티
workspace root·ticket ID·review axis·사용자 원문 request.md·Spec/diagram·현행 계약/용어/모델·검토한 추가 근거 파일·실제 agent metadata·reviewer 판정/지적. 객체형 DDD entity로 선언하지 않는다.

### 동작
spec-me의 Product 작성/diagram 후 고성능 모델의 새 reviewer를 생성하고 pass 후 설계한다. 최종 계약/용어/diagram이 안정된 뒤 stale Product를 갱신하고 다른 새 reviewer가 Architecture를 검토한다. 매 수정본은 새 agent/fork_turns:none으로 보내며 의미 변경은 기존 interview로 돌아간다. reviewer는 읽기 전용으로 JSON 판정과 근거를 반환하고 caller가 원본 응답을 session/runtime/spec-reviews/에 attempt별 보존한다. 이 흐름은 Learning mode 여부와 무관하다. stage gate 및 lifecycle spec_reviews는 기록·입력 hash·작성자 독립성·미해결 중대 지적을 검사한다. completeWorkflow는 로컬 manifest가 spec_reviews를 제거해도 spec-me/to-ticket 필수 검사를 복원한다. to-ticket은 새 worktree의 현재 파일로 검증하고 stale/missing이면 계획 전에 중단한다. 실제 spawn의 진위나 의미적 완전성은 hash만으로 증명하지 않으며 caller가 실제 tool 결과와 대조한다.

### 메서드
[snapshotSpecReview](architecture.md#snapshot-spec-review-method) · [inspectSpecReviews](architecture.md#inspect-spec-reviews-method)

<a id="snapshot-spec-review-method"></a>
## snapshotSpecReview
수정일: 2026-10-17

### 설명
각 axis의 필수 입력과 직접 읽은 추가 근거를 hash snapshot으로 만든다.

### 필요 엔티티
root·ticketId·product/architecture axis·선택 input_paths.

### 동작
request/Product Spec을 필수 포함하고 Architecture는 Architecture Spec도 포함한다. 존재하는 현행 용어/Context map/관련 통합 계약/모델/System Targets와 해당 ticket의 diagram 파일도 포함한다. 직접 읽은 source/ADR는 input_paths에 추가한다. workspace 밖 참조와 diagram symlink를 거부한다. before/after snapshot이 바뀌면 검토를 다시 시작한다. 반환 snapshot은 읽은 내용의 일치를 추적하며 실제 읽기 행위 자체를 증명하지 않는다.

<a id="inspect-spec-reviews-method"></a>
## inspectSpecReviews
수정일: 2026-10-17

### 설명
stage/lifecycle/CLI가 사용하는 Spec 리뷰 완료 검사다.

### 필요 엔티티
root·ticketId·product/architecture review records·선택 axes.

### 동작
axis/ticket 일치, 서로 다른 reviewer ID, 모든 author ID와의 분리, fork_turns:none, pass verdict, 유효한 severity/근거, 미해결 blocker/major 부재, 필수/추가 입력의 현재 hash를 검사한다. Product 변경은 Product와 Architecture 양쪽 snapshot을 무효화한다. 위반이나 누락은 blocked이며 부모의 자기 검토·state의 pass 선언만으로 통과하지 않는다. 기계적 독립성 검사는 보존된 metadata를 대상으로 하므로 실제 tool 응답과의 대조 책임을 유지한다.

<a id="plan-traceability-service"></a>
## src/workflow/plan-traceability.mjs
수정일: 2026-10-20

### 설명
기존 control-plane에서 plan set의 요구사항 coverage, 독립 리뷰의 현재성, 구현 evidence를 조립하는 책임이다. 별도 Context·Aggregate·서비스를 추가하지 않는다. [소스](../../src/workflow/plan-traceability.mjs).

### 필요 엔티티
plan set ID·ticket ID·Spec/요청/결정/다이어그램/계약 입력·canonical plan·review metadata·실행 profile/receipt. 객체형 DDD entity로 선언하지 않는다.

### 동작
`docs/plans/<plan-set-id>/traceability.json`을 읽어 requirement 선언과 `source_path#ID` coverage, canonical per-plan 본문, 수용 조건·반례·검증 사례, 독립 리뷰와 snapshot freshness를 검사한다. impact는 stale coverage에서도 변경된 ID와 영향 계획을 보고하며 불확실 시 전체 계획을 보수적으로 지목한다. dispatch는 검증 전 spawn을 차단하고 completion은 선택 profile의 harness-exec receipt 및 현재 source/test hash를 확인한다. 해시는 의미적 정확성이나 reviewer/tool 신원을 증명하지 않는다.

### 메서드
[snapshotPlanTraceability](architecture.md#snapshot-plan-traceability-method) · [inspectPlanTraceability](architecture.md#inspect-plan-traceability-method) · [inspectTraceabilityImpact](architecture.md#inspect-traceability-impact-method)

<a id="snapshot-plan-traceability-method"></a>
## snapshotPlanTraceability
수정일: 2026-10-20

### 설명
현재 계획 검토에 필요한 선언 입력과 canonical plan 본문을 정규화해 hash한다.

### 필요 엔티티
workspace root·plan set ID.

### 동작
요청·Spec·결정·diagram·계약·plan 본문과 원장 planning content를 수집한다. implementation evidence와 일반 source 변경은 제외한다.

<a id="inspect-plan-traceability-method"></a>
## inspectPlanTraceability
수정일: 2026-10-20

### 설명
planning·dispatch·completion 단계별 추적 검사다.

### 필요 엔티티
workspace root·plan set ID·phase·선택 plan ID.

### 동작
planning은 독립 fresh review와 전체 coverage를 검사하고 dispatch는 통과 전에 spawn을 차단한다. completion은 requirement별 구현·검증 파일 hash와 성공한 선택 profile의 session receipt를 대조한다.

<a id="inspect-traceability-impact-method"></a>
## inspectTraceabilityImpact
수정일: 2026-10-20

### 설명
현재 요구사항·계획 입력과 저장된 review snapshot의 차이를 조회한다.

### 필요 엔티티
workspace root·plan set ID.

### 동작
변경 경로와 추가·수정·삭제된 qualified requirement ID 및 영향 계획을 반환한다. 불확실한 변경은 전체 계획을 보수적으로 무효화하며 입력이나 tracker 상태를 갱신하지 않는다.
