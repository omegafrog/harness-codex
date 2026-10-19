# Harness 전체 Product 계약

이 문서는 현재 제공하는 업무 동작의 통합 기준이다. ticket별 Spec은 변경 제안과 역사 근거로 보존한다. 코드를 실제로 대조한 범위의 계약이며 live end-to-end 성공을 의미하지 않는다. 용어 기준은 [CONTEXT.md](../../CONTEXT.md), 구조는 [DDD Architecture](architecture.md), 실행 상태는 [검증 지도](../verification/features.md)를 본다.

성능 수치는 미측정이다. 변경 시 영향받는 목표에만 workload·단위·환경·오류율·baseline·측정 증거를 연결한다. 임의의 개선율을 계약에 쓰지 않는다.

<a id="install"></a>
## 프로젝트 설치와 갱신
수정일: 2026-10-19
상태: implemented

### 설명
대상 저장소에 Harness skill·workflow·agent·runtime과 CI를 설치하고 변경분을 안전하게 갱신한다.

### 비즈니스 규칙
BR-install: install/update 종료 시 프로젝트 실행 계약과 통합 계약 준비 상태를 별도로 검사·보고한다. 런타임 설치 성공이 구현 준비 완료를 뜻하지 않는다. 부족하면 caller가 setup·sync-contracts로 실제 프로젝트를 조사해 보완하고 재검사한다. 기본 설치·업데이트·재설치는 기존 사용자 수정을 보존한다. 명시적 install/update --force만 선택한 스킬/refs·agent·workflow/runtime·관리 CI/PR 자산을 먼저 영속 세션에 백업한 뒤 교체한다. 프로젝트 소유 harness.yaml과 업무 문서는 변경하지 않는다. 같은 native 동기화 경로를 사용하여 수동 skill 교체나 사전 lock 재승인에 의존하지 않는다. partial install은 다른 scope의 baseline을 보존한다. 사라진 upstream 자산의 lock 항목만 정리하고 기존 파일은 보존한다. source hash와 lock으로 관리 파일을 구분한다. linked worktree에 별도 Beads DB를 만들지 않는다.

### 수용 조건
AC-install: 새 설치에 PR 템플릿과 지원 파일을 포함하고 기본 충돌 보존/명시적 force 교체·백업/동일 상태 재실행의 결과를 검사한다.  신규 파일과 reference가 배포되고, 충돌 파일은 보존·보고되며 lock이 실제 관리 목록을 나타낸다.

구현: [src/installer/update.mjs](../../src/installer/update.mjs) · 검증: [tests/installer_update.test.mjs](../../tests/installer_update.test.mjs)

<a id="diagnose"></a>
## 설치 상태 진단
수정일: 2026-10-19
상태: implemented

### 설명
프로젝트 설정과 설치 runtime의 상태를 조사한다.

### 비즈니스 규칙
BR-diagnose: 실행 계약 누락/빈 프로필/잘못된 형식과 통합 계약 누락/오래된 snapshot은 project_preparation_required 오류다. 진단은 소유하지 않은 설정을 임의로 고치지 않는다. 실패 원인과 복구 방법을 구분한다.

### 수용 조건
AC-diagnose: 최신 관리 자산의 supporting files·tools·contracts·CI·PR을 stale로 오인하지 않는다. eval permission_profile label을 native 참조와 구분하되 실제 sandbox/network 모순·명시적 native 참조 미검증은 계속 실패한다.  doctor 결과와 종료 코드가 실제 진단 결과와 일치한다.

구현: [src/doctor/doctor.mjs](../../src/doctor/doctor.mjs) · 검증: [tests/doctor.test.mjs](../../tests/doctor.test.mjs)

<a id="workspace"></a>
## 작업 공간 검증
수정일: 2026-10-19
상태: implemented

### 설명
session/plan worktree와 명령 실행 루트의 일치를 검증한다.

### 비즈니스 규칙
BR-workspace: expected root·cwd·Git root·등록 worktree가 일치해야 dispatch한다. 실패 시 agent나 서버를 시작하지 않는다. 소유 workflow worktree는 완료·실패·사용자 중간 종료·handoff에서 파일/실행 기록을 보존·검증한 후 제거한다. PR merge를 기다리지 않으며 branch와 recovery ref는 유지한다. primary/비소유 workspace는 삭제하지 않는다. 제거 실패는 완료 실패로 보고하고 재시도한다.

### 수용 조건
AC-workspace: 잘못된 루트는 valid=false로 차단되고 원래 작업 공간이 보존된다. dirty/untracked/ignored 파일과 staged index는 세션의 recovery/에 남고 journal·로그는 동일 세션 경로에 남는다. 생성/등록 실패·완료 gate 오류·SIGINT/SIGTERM도 정리 경로를 거치며, SIGKILL/전원 종료 후에는 pending receipt를 확인해 중단된 실행만 정리한다.

BR-session-output: 로그·stdout/stderr 저장본·checkpoint·스크린샷·평가 결과·지식 후보·review journal·임시 파일·복구 백업은 공통 resolver가 반환한 session_directory 안에만 기록한다. Git common directory의 workspace hash별 영속 세션을 사용하고, worktree 제거 후에도 증거 경로는 변하지 않는다. 비Git fixture는 .codex/sessions/를 사용한다. 절대/상위 이탈 경로·symlink·공유 hardlink·특수 파일 출력을 거부한다. 하위 agent/process에 세션 경로와 TMPDIR/TMP/TEMP, browser output 경로를 전달한다. source·최종 계약·제품 다이어그램·승인 지식 registry와 Git/Beads 원장은 선언된 경로를 유지한다. 외부 도구 전역 cache/telemetry에 대한 OS sandbox 보장은 포함하지 않는다. 기존 데이터는 자동 이전하지 않는다.

AC-session-output: 잘못된 출력 경로는 쓰기 전에 거부된다. installed CLI도 같은 경계를 적용하며 worktree 삭제 뒤 로그가 원래 경로에 남는다. 검증: [tests/session-output.test.mjs](../../tests/session-output.test.mjs).

구현: [.codex/scripts/harness-workspace-preflight.mjs](../../.codex/scripts/harness-workspace-preflight.mjs) · 검증: [tests/workspace_preflight.test.mjs](../../tests/workspace_preflight.test.mjs) · [종료 cleanup 검증](../../tests/workflow_worktrees.test.mjs)

<a id="delivery"></a>
## 변경 설계와 구현 인계
수정일: 2026-10-19
상태: implemented

### 설명
Product→DDD Architecture→ticket→plan→구현·독립 리뷰·완료의 추적 가능한 흐름을 제공한다.

### 비즈니스 규칙
BR-delivery: tracker 전환·fixed point·분기·구현 전에 실행/통합 계약을 준비하고 실제 preflight를 통과한다. wrapper는 실제 project_readiness gate로 agent 시작을 차단한다. 기본 workspace 검사는 최초 bootstrap을 허용한다. 기존 구현 복구에서는 commit·stash·tracker 상태를 보존하고 준비 후 검증을 재개한다. 기존 owner와 용어를 먼저 조사한다. Product와 Architecture Spec은 각각 작성자와 다른 새 subagent의 적대적 리뷰를 받는다. 전체 대화·작성자 분석을 상속하지 않고 요청 원문·확정 답변·문서와 허용 근거를 직접 읽는다. Product pass 후 설계하고 최종 Architecture pass 후 계획한다. Normal/Learning에 공통 적용하며 Learning의 결정/자료 승인과 구현 후 code-review를 대체하지 않는다. blocker/major는 수정 또는 사용자 interview 뒤 새 reviewer로 재검토하며 최대 2회 보정 후 미해결은 blocked다. 취향 지적으로 findings를 강제하지 않는다. 승인된 범위만 구현한다. 테스트·독립 spec/standards 리뷰·통합 계약·tracker 정합성이 통과해야 완료하며 종속 작업을 해제한다. 구현과 review는 fixed point commit을 공유한다. GitHub Workflow Status/로컬 ticket의 planned·in-progress·blocked·completed가 실행 상태의 기준이며 Beads는 open·in_progress·blocked·closed로 반영한다. 새 mirror는 exact external_ref와 lifecycle v1 marker로 연결한다. backlog 분류와 test/review 단계는 metadata로 분리하고 별도 상태를 만들지 않는다. 공통 코드가 canonical 갱신·재조회 후 mirror를 반영하고 재조회한다. mirror 실패는 canonical을 되돌리지 않으며 재시도한다. 기존 데이터 이전은 범위 밖이다.

### 수용 조건
AC-delivery: 실행/통합 계약이 누락된 프로젝트는 구현 agent가 시작되지 않으며 준비 후 재검사에서 pass해야 한다. 최신 request/Spec/diagram·현행 용어/계약·읽은 source의 hash와 실제 fresh reviewer metadata를 검사한다. 미실행·작성자와 같은 reviewer·맥락 상속·미해결 중대 지적·변경된 입력은 spec-me 완료와 to-ticket 인계를 차단한다. Product 변경은 Architecture 리뷰도 무효화한다. 기계 검사는 기록과 입력 일치만 확인하며 실제 spawn 진위와 리뷰 의미는 원본 tool/agent 응답으로 대조한다. 실패/누락 증거와 신규 mirror 불일치는 agent 시작·Done·종속 plan 해제를 막는다. GitHub 기본 Status/Issue closure는 동기화 명령이 변경하지 않는다. journal replay가 checkpoint를 복구하고 폐기 경로가 남으면 retirement 검사가 실패한다.

구현: [src/wrapper/dispatch.mjs](../../src/wrapper/dispatch.mjs) · 검증: [tests/wrapper_dispatch.test.mjs](../../tests/wrapper_dispatch.test.mjs) · [상태 동기화 검증](../../tests/tracker_lifecycle.test.mjs)

<a id="decisions"></a>
## 설계 결정과 근거 검토
수정일: 2026-10-16
상태: implemented

### 설명
설계 대안과 근거·시스템 목표·승인 이력을 보존한다.

### 비즈니스 규칙
BR-decisions: Learning mode 자료 사용은 material approval로 제어한다. approved hash와 review provenance를 검증한다. 통과하지 못한 결정을 완료로 기록하지 않는다.

### 수용 조건
AC-decisions: 승인 누락·내용 변경·불충분한 decision evidence는 gate에서 검출한다.

구현: [src/decision/review.mjs](../../src/decision/review.mjs) · 검증: [tests/decision_gate_cli.test.mjs](../../tests/decision_gate_cli.test.mjs)

<a id="evidence"></a>
## 지식 근거의 승인과 게시
수정일: 2026-10-16
상태: implemented

### 설명
source·claim·principle·실행 evidence를 수집하고 승인된 summary만 외부에 게시한다.

### 비즈니스 규칙
BR-evidence: raw runtime evidence와 외부 공개 summary를 분리한다. staged→approved→published lifecycle을 우회하지 않는다. 게시 자체는 사용자 권한과 기존 승인 규칙을 따른다.

### 수용 조건
AC-evidence: 승인되지 않은 summary는 게시할 수 없고 history에 전이가 보존된다.

구현: [src/knowledge/evidence.mjs](../../src/knowledge/evidence.mjs) · 검증: [tests/knowledge_evidence.test.mjs](../../tests/knowledge_evidence.test.mjs)

<a id="evaluate"></a>
## 하네스 품질과 효율 평가
수정일: 2026-10-16
상태: implemented

### 설명
격리한 case/suite에서 workflow의 결과·품질·효율을 측정한다.

### 비즈니스 규칙
BR-evaluate: 정확성·hard gate·outcome과 token/latency를 구분한다. 동등 workload에서 baseline과 비교한다. 외부 인증/실행 제약은 inconclusive로 표시하고 cleanup 결과를 보존한다.

### 수용 조건
AC-evaluate: result/report/events와 실패 분류가 일치하며 미실행을 성공으로 보고하지 않는다.

구현: [src/eval/runner.mjs](../../src/eval/runner.mjs) · 검증: [tests/eval_contract.test.mjs](../../tests/eval_contract.test.mjs)

<a id="contracts-feature"></a>
## 통합 계약 유지와 완료 검증
수정일: 2026-10-16
상태: implemented

### 설명
전체 Product·DDD Architecture 계약과 연결 다이어그램을 계속 갱신한다.

### 비즈니스 규칙
BR-contracts-feature: 현행 구현과 accepted-target을 구분한다. source/문서/모델 변경은 검토와 version receipt를 요구한다. ticket Spec/plan만 수정해도 통합 계약 검토를 요구하며 local checkpoint는 snapshot에서 제외한다. diagram 원본과 SVG가 일치해야 한다. 기계 검사만으로 의미 정확성을 승인하지 않는다.

### 수용 조건
AC-contracts-feature: stale snapshot·필수 필드·소유 링크·기능 sequence·SVG provenance·base revision 오류를 차단한다. 실제 implement 완료와 모든 workflow의 공통 완료 명령 및 CI가 같은 검사를 사용한다. 시작 SHA가 없거나 hook이 실패하면 정상 완료 receipt를 발급하지 않는다.

구현: [src/contracts/contracts.mjs](../../src/contracts/contracts.mjs) · 검증: [tests/contracts.test.mjs](../../tests/contracts.test.mjs)


<a id="execution"></a>
## 테스트·서비스 실행 전제 검증
수정일: 2026-10-19

### 설명
설치된 프로젝트의 테스트·서비스·인프라를 실제 실행 계약에 맞춰 준비하고 시작한다.

### 비즈니스 규칙
BR-execution: 프로젝트 소유 `docs/agents/execution.json`의 정확한 argv·필수 환경값·설정 원본·prepare/verify·전체 인프라/선행 서비스 readiness를 매 실행마다 검증한다. 필수값 누락은 prepare 이전에 차단한다. 설정 준비/검증과 readiness에 성공하고 설정 hash가 변하지 않았을 때만 command를 시작한다. 과거 성공 receipt나 추정 기본값은 사용하지 않는다. startup 전제 변경 시 profile·EXEC도 함께 수정한다. 누락 인프라는 지정된 별도 실행 profile로 준비하며 임의 설치·reset·대체하지 않는다. main은 foreground로 실행하며 timeout/취소에 소유 process group만 종료한다. 기존 외부 인프라는 종료하지 않는다.

### 수용 조건
AC-execution: missing env/인자·오래된 설정·미준비 인프라·prepare 완료 후 검증/readiness 중 설정 변경은 main 시작 없이 blocked다. 올바른 준비 경로는 exact argv로 실행되고 nonzero main은 failed, 취소는 interrupted다. 단계 로그·결과·설정 hash는 세션 안에 남고 secret/env 값은 receipt에 넣지 않는다. 프로필 선언의 충분성은 실제 entrypoint·config loader·infra/CI와 리뷰로 대조한다. 직접 shell 실행을 OS 수준에서 막는 보장은 아니다.

검증: [프로젝트 준비 회귀 검사](../../tests/project_readiness.test.mjs).

구현: [runExecution](../../src/workflow/execution.mjs) · 검증: [실행 전제 회귀 검사](../../tests/execution.test.mjs) · 흐름: [sequence](diagrams/execution.sequence.svg) · 상태: [state](diagrams/execution.state.svg).

실행 정리의 process group 보장은 POSIX 대상이다. native Windows는 직접 child만 종료하며 descendant 정리가 필요한 흐름은 WSL/POSIX에서 수행한다. 설정의 의도적 prepare 갱신 후에 hash를 잡고, 그 이후 verify/readiness 도중 변경을 차단한다.
