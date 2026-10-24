# Harness 전체 Product 계약

공개 스킬은 사용자가 직접 시작하는 workflow와 독립 도구만 포함한다. Spec 작성·모델링·하위 리뷰·개별 구현·다이어그램·guidance·계약 동기화·worktree 관리의 내부 절차는 `.codex/internal-skills/*/GUIDE.md`로 배포하며 상위 workflow/agent가 읽어 호출한다. 사용자 스킬 목록에 노출하지 않고 기존 ID와 승인·검증 규칙은 유지한다. 설치·갱신은 관리되는 구형 공개 사본을 session backup 후 제거한다.

이 문서는 현재 제공하는 업무 동작의 통합 기준이다. ticket별 Spec은 변경 제안과 역사 근거로 보존한다. 코드를 실제로 대조한 범위의 계약이며 live end-to-end 성공을 의미하지 않는다. 용어 기준은 [CONTEXT.md](../../CONTEXT.md), 구조는 [DDD Architecture](architecture.md), 실행 상태는 [검증 지도](../verification/features.md)를 본다.

성능 수치는 미측정이다. 변경 시 영향받는 목표에만 workload·단위·환경·오류율·baseline·측정 증거를 연결한다. 임의의 개선율을 계약에 쓰지 않는다.

<a id="install"></a>
## 프로젝트 설치와 갱신
수정일: 2026-10-24
상태: implemented

### 설명
대상 저장소에 Harness skill·workflow·agent·runtime과 CI를 설치하고 변경분을 안전하게 갱신한다.

### 비즈니스 규칙
BR-install-recovery: `harness-recover`는 설치·ticket 동기화·workflow 기록·worktree 오류를 읽기 전용으로 진단한다. 파일·로그/백업·ticket·실행 상태·worktree 등 대상 프로젝트를 바꾸기 전에 정확한 대상·조작·보존/복원·검증을 제시하고 사용자 확인을 받는다. 승인한 범위만 기존 소유 CLI로 복구하고 원래 실패한 검사와 Git 가시성·프로젝트 변경 보존을 재확인한다. 정상 결정 대기와 실제 gate 실패는 필요한 재개 조건으로 보고한다. 이 승인 절차는 스킬 지침이며 runtime의 권한 enforcement를 대체하지 않는다.

BR-install: install/update 종료 시 프로젝트 실행 계약과 통합 계약 준비 상태를 별도로 검사·보고한다. 런타임 설치 성공이 구현 준비 완료를 뜻하지 않는다. 부족하면 caller가 setup·sync-contracts로 실제 프로젝트를 조사해 보완하고 재검사한다. 관리 스킬의 SKILL.md와 supporting files는 기본 install/update에서도 기존 내용을 영속 세션에 백업한 뒤 교체한다. 그 밖의 관리 자산은 기본적으로 로컬 수정을 보존하며, 명시적 install/update --force만 선택한 자산 전체를 먼저 백업한 뒤 교체한다. 프로젝트 소유 harness.yaml과 업무 문서는 변경하지 않는다. 같은 native 동기화 경로를 사용하여 수동 skill 교체나 사전 lock 재승인에 의존하지 않는다. partial install은 다른 scope의 baseline을 보존한다. 일반 사라진 upstream 자산은 lock만 정리하고 파일을 보존한다. 명시한 폐기 managed SigNoz 설치 스킬은 backup 후 제거한다. source hash와 lock으로 관리 파일을 구분한다. linked worktree에 별도 Beads DB를 만들지 않는다. setup engine이 live schema·프로젝트 상태로 선택지를 제공하고 Codex CLI native 선택 UI에서 model·tracker·Beads·OTel 관측성 사용 여부·로그/메트릭/OTLP port·저장소별 보존 기간·프로젝트/서비스별 앱 기준 metrics_url과 컨테이너 기준 scrape_url을 수집한다. $setup은 request_user_input_async 또는 실제 사용 가능한 request_user_input 도구로 선택지를 표시하며 일반 채팅 번호 질문·숨은 PTY·별도 GUI·설치기 메뉴로 대체하지 않는다. --answers의 session JSON에 제출된 값만 저장하고 needs_input JSON은 질문 대기, configured/exit=0만 설정 적용 완료로 판정한다. 기본값·무응답은 제출로 보지 않는다. 잘못된 선택·stale configuration_hash·session 밖 답 파일은 거부하고 최종 적용 요약도 native UI에서 확인받는다. Beads 초기화는 CLI 승인 후 실제 local/remote workspace를 확인한다. VictoriaLogs 선택 시 compose·OpenTelemetry Collector→VictoriaLogs 로그·Actuator→VictoriaMetrics 메트릭·provider-neutral 공식 MCP 두 개 설정·infrastructure/check/stop 실행 profile을 준비하고 victorialogs-local-setup이 기존 Spring Boot 개발 실행에 native OTel SDK/appender 또는 외부 Java agent와 개발용 Actuator/Prometheus registry를 연결한다. 진단 v1의 논리 JSON은 실제 OTel 필드로 매핑하며 JSON 전체를 Body 문자열에 중첩하지 않는다. Vector/Fluent Bit을 설치하지 않는다. production build·image·dependency에는 수집 SDK를 추가하지 않는다. 로그와 메트릭 기본 보존은 각각 7일이며 데이터와 Collector queue는 원본 프로젝트 session directory에 저장한다. 기본 host 공개 port는 9428/8428/4318이며 127.0.0.1로만 publish한다. 내부 listener는 0.0.0.0의 고정 port이며 compose bridge의 service DNS로 통신한다. Desktop host networking은 필요 없다. Desktop/WSL의 앱→Collector는 공개 localhost, Metrics→앱은 명시적 scrape_url의 host.docker.internal 주소를 사용한다. 포트·path를 보존하고 Windows gateway IP나 모든 localhost의 동일성을 가정하지 않는다. 여러 명시적 프로젝트/서비스를 식별하고 서로 다른 개발 worktree가 같은 스택을 공유한다. SigNoz marketplace 자동 등록은 제거하며 관리 lock의 폐기 설치 스킬은 backup 후 제거한다. 이전 사용자 서버·데이터·전역 plugin은 보존한다. Spring Boot Diagnostic Log Schema v1(1.0)의 문서·기계 schema·예시·오프라인 원본 JSONL 검증 profile을 배포한다. setup은 같은 Git common directory의 공용 구현/테스트 지침에 해당 계약을 출처·범위와 함께 추가하고 기존 항목은 중복하지 않는다. 진단 이벤트의 typed 필수값·outcome·retry/state를 검증하며 framework 로그·OTLP wire 표현·VictoriaLogs 저장 표현을 혼동하지 않는다. 실제 context 전달·monotonic 시간·redaction과 emitter 구현은 해당 프로젝트 source와 집중 테스트로 검증한다.

### 수용 조건
AC-install: 대상이 실제 Git root인 경우에만 해당 저장소 exclude를 수정하고, Git 초기화 전 하위 디렉터리 설치가 부모 저장소 ignore를 바꾸지 않는다. 새 설치에 PR 템플릿과 지원 파일을 포함하고 기본 충돌 보존/명시적 force 교체·백업/동일 상태 재실행의 결과를 검사한다. 신규 파일과 reference가 배포되고, 충돌 파일은 보존·보고되며 lock이 실제 관리 목록을 나타낸다. 설치는 VictoriaLogs helper·스킬·모든 지원 assets를 배포하고 SigNoz plugin 등록을 호출하지 않는다. setup은 Codex native UI에서 제출된 선택·확인을 받아 포트/보존 기간과 MCP/수집 profile을 준비하며 설정만 준비한 상태를 수집 완료로 보고하지 않는다. 재실행은 다른 project config와 profile을 보존하고 managed 관측성 설정·profile은 backup 후 갱신한다. 구형 host network/Fluent Bit compose·Collector 설정은 backup 후 bridge로 교체하며 기존 데이터·offset은 보존한다. 실제 컨테이너 기준 scrape_url의 Actuator host/port/path를 scrape에 반영하고 config.json과 target이 어긋나면 실행 전 차단한다. backend 시작은 명시적 harness-exec profile 호출이며 setup이 임의 실행하지 않는다. 설치된 진단 검사 profile은 Docker 없이 정상 record를 받아들이고 필수값·타입·이벤트 outcome 오류를 거부한다. 재설정은 기존 공용 지침을 중복하지 않고 관측성 관리 항목과 OTel 저장 필드 설명을 갱신한다. setup과 API readiness만으로 실제 로그·메트릭 수집 완료를 주장하지 않는다. 폐기 managed skill만 backup 후 제거하고 다른 자산·사용자 데이터는 보존한다.

구현: [bin/harness-install.mjs](../../bin/harness-install.mjs) · [src/installer/update.mjs](../../src/installer/update.mjs) · 검증: [tests/test_project_local_installer.py](../../tests/test_project_local_installer.py) · [tests/installer_update.test.mjs](../../tests/installer_update.test.mjs)

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
수정일: 2026-10-24
상태: implemented

### 설명
Product→DDD Architecture→ticket→plan→구현·독립 리뷰·완료의 추적 가능한 흐름을 제공한다.

### 비즈니스 규칙
BR-delivery-review-coordination: 각 소유 리뷰의 독립성·Product→Architecture 순서·한도를 유지하면서, 실행 중인 관련 reviewer 결과를 모두 모아 동일 원인과 영향 경로를 한 수정표로 정리한다. 사용자 결정 요청에는 관찰된 Spec·계획·구현의 미해결 지적·pending·한도·필요 결정을 함께 제시한다. harness-review-status는 기존 원장과 선택한 현재 구현 리뷰만 읽어 파생 요약을 반환하며 파일·session·권한을 변경하지 않는다. 조회 성공은 업무 gate pass와 구분한다. 변경된 planning snapshot은 재승인됐어도 이전 코드 리뷰의 repair 예약·완료에 재사용할 수 없다. 실제 편집 중단·지적 묶음과 승인 범위 판정은 caller의 책임이다.

BR-delivery-review-input: 상태 보유 Architecture 변경은 정상·경쟁 저장·부분 실패·재시도·재시작·복구 전이와 다음 허용 명령을 함께 검토한다. 의미적 완전성은 작성자/reviewer가 판단한다. 구현 중 새 명령·업무 상태·규칙·경계 또는 Spec 결정이 필요하면 구현 repair 예약 전에 spec-me로 전환하고, 변경 Spec·영향 계획의 fresh 승인 뒤 기존 기준 commit으로 재개한다. reviewer 생성 전 canonical plan의 정본 참조·SHA-256·정규화 식별자를 검사하고 raw 파일 hash와 구분한다. Spec begin은 입력 snapshot과 같은 workspace·session·ticket·axis·attempt 대상을 반환한다.

BR-implementation-review: 개별 plan의 코드 리뷰는 두 축의 state와 kind·severity·근거를 기록하고 실제 결함/검증 부족, 결정 필요, 통합 계약 동기화, 권고를 구분한다. 수정 횟수는 원본 저장소의 plan별 실행 기록을 정본으로 기본 1회·승인 설정 최대 2회 예약한다. 같은 커밋의 중복 예약, 재개 시 한도 상향, worktree 교체에 따른 초기화와 이전 reviewer context 재사용을 차단한다. checkpoint의 review_fixed_point는 최초 기준을 유지한다. 변경 규칙의 최초·후속·직접 API·재시도·저장 복구 경로를 함께 수정·검증한 뒤 새 commit을 두 fresh reviewer가 검토한다. 한도 소진 뒤 명시적 사용자 범위/결정 변경은 원문과 위치를 기록해 재개한다. 개별 plan은 snapshot-only drift를 최종 통합으로 연결하며 계약 구조·실행 준비 실패는 계속 차단한다. 최종 feature 완료는 실제 계약 pass를 요구한다. canonical_plan.reference는 file/GitHub 정본을, input_key는 가상 hash 키를 나타낸다.

BR-review-admission: Spec의 ticket·축별, 계획의 plan set별로 최초 검토와 재검토 2회를 기록한다. begin은 실행 중 중복 요청, 입력 변경 없는 재요청과 한도 초과를 차단한다. record는 실제 fresh reviewer의 판정·지적과 현재 snapshot을 보존하며 입력 변경은 stale로 기록한다. 종료·취소는 사유와 함께 기록하고 횟수에 포함한다. Architecture 검토 시작은 현재 Product pass를 요구한다. 시작된 리뷰는 pass 결과 기록 뒤 다음 gate를 통과한다. 한도 도달 시 사용자에게 쟁점과 필요한 결정을 제시하고, 명시적 범위·결정 변경 원문을 기록해 새 검토 묶음을 시작한다. 사용자 결정의 진위·역할 선택·검토 중 문서 고정은 호출자의 검토 계약이며, 기존 receipt는 당시 검증 형식을 유지한다.

BR-delivery: 프로젝트별 구현 지침과 테스트 지침을 각각 `docs/agents/implementation-guidance.md`, `docs/agents/testing-guidance.md`에 보존한다. 두 문서는 provider-neutral Markdown이며 재사용 가능한 사용자 선호와 확인된 테스트 교훈을 출처·범위·수정일과 함께 기록한다. spec-me/사용자 설계 대화에서 확정된 선호로 갱신하고 setup은 없을 때만 template로 만든다. managed worktree는 원본 project root(`return_root`)를 `shared_guidance_root`로 모든 구현/test worker에 전달해 단일 문서를 읽고 갱신하며, branch-local 사본은 쓰지 않는다. 구현자는 구현 지침을 편집 전, 테스트 실행 전 두 문서를 읽고, test runner는 테스트 지침을 읽는다. ticket Spec 및 execution profile과 충돌하면 임의 우선순위를 정하지 않고 중단한다. E2E 실패는 시도별 원본 증거와 고유 ID로 보존한다. 테스트 결과와 실패 학습 상태를 분리하며 학습 pending이나 지침 갱신 미완료로 테스트 성공·workflow 완료를 막지 않는다. 원인이 확인되고 재사용 가능한 교훈이 있을 때만 지침을 갱신하고, 교훈이 없으면 파일 수정 없이 판단 근거를 남긴다. caller가 확인된 원인을 실제 프로필/readiness/회귀 검사에 반영하고 정책에 맞는 가장 저렴한 관련 경로를 재검증한 뒤 프로젝트 현행 lesson을 갱신한다. E2E 실패 해결을 주장할 때는 실제 해당 E2E 경로를 재검증하며, E2E와 무관한 lower-level 변경에 불필요한 E2E를 실행하지 않는다. 다음 실행은 관련 lesson과 예방 검사를 읽는다. runner는 증거만 수집하고 가설을 확정하지 않는다. 변경 없는 재시도/기대값 약화로 실패를 숨기지 않는다. 검증 기본값은 focused unit/integration/contract 검사이며, E2E/full-stack/browser end-to-end 명시 요청 또는 저비용 검사로 실패를 확인할 수 없는 변경 critical cross-boundary 경로에만 E2E를 계획한다. 일반 테스트/검증 요청이나 서비스 실행 요청만으로 E2E를 추정하지 않는다. E2E plan은 requirement/risk, 저비용 검사 부족 사유, 최소 시나리오/oracle, profile, timeout, 시도 budget을 기록한다. agent 응답 검증은 동적 prose·비계약 순서/수를 고정하지 않고 trace 기반 goal/state/tool/permission/persistence/side effect를 확인한다. 이 선택·분류는 의미적 수동 정책이며 runtime 자동 집행이라고 주장하지 않는다. tracker 전환·fixed point·분기·구현 전에 실행/통합 계약을 준비하고 실제 preflight를 통과한다. wrapper는 실제 project_readiness gate로 agent 시작을 차단한다. 기본 workspace 검사는 최초 bootstrap을 허용한다. 기존 구현 복구에서는 commit·stash·tracker 상태를 보존하고 준비 후 검증을 재개한다. 각 plan set은 source ID 요구사항을 canonical split plan의 수용 조건·검증 사례에 연결하고, 여러 계획에 걸친 규칙은 통합 owner와 시나리오를 둔다. 전체 원문을 읽은 독립 fresh plan reviewer의 승인이 없거나 입력/계획이 바뀌면 dispatch와 완료를 차단한다. 구현 완료는 requirement별 구현/verification 파일 hash와 지정 profile의 실제 session receipt를 요구한다. `workflow_completion`은 `completion_kind`로 단계 산출물을 구분한다: `spec_ready_for_planning`, `plan_set_ready_for_implementation`, `plan_implemented`, `feature_implemented`. `completed`는 해당 범위만 완료한 것이며 전체 기능 구현 완료로 추정하지 않는다. 사용자/외부 조건 대기는 세션을 유지하고, handoff·취소·실패는 `handoff`·`aborted`·`failed` outcome으로 완료와 분리한다. 기계 검사는 연결과 현재성만 보장하며 요구사항 inventory의 의미 완전성은 reviewer가 판단한다. 기존 owner와 용어를 먼저 조사한다. Product와 Architecture Spec은 각각 작성자와 다른 새 subagent의 적대적 리뷰를 받는다. 전체 대화·작성자 분석을 상속하지 않고 요청 원문·확정 답변·문서와 허용 근거를 직접 읽는다. Product pass 후 설계하고 최종 Architecture pass 후 계획한다. Normal/Learning에 공통 적용하며 Learning의 결정/자료 승인과 구현 후 code-review를 대체하지 않는다. blocker/major는 수정 또는 사용자 interview 뒤 새 reviewer로 재검토하며 최대 2회 보정 후 미해결은 blocked다. 취향 지적으로 findings를 강제하지 않는다. 승인된 범위만 구현한다. 테스트·독립 spec/standards 리뷰·통합 계약·tracker 정합성이 통과해야 완료하며 종속 작업을 해제한다. 구현과 review는 fixed point commit을 공유한다. GitHub Workflow Status/로컬 ticket의 planned·in-progress·blocked·completed가 실행 상태의 기준이며 Beads는 open·in_progress·blocked·closed로 반영한다. 새 mirror는 exact external_ref와 lifecycle v1 marker로 연결한다. backlog 분류와 test/review 단계는 metadata로 분리하고 별도 상태를 만들지 않는다. 공통 코드가 canonical 갱신·재조회 후 mirror를 반영하고 재조회한다. mirror 실패는 canonical을 되돌리지 않으며 재시도한다. 기존 데이터 이전은 범위 밖이다.

### 수용 조건
구현 수정 횟수가 agent 재진입·worktree 교체 뒤에도 유지되고, 이전 reviewer context 재사용과 기준점 변경이 거부돼야 한다. 중간 plan의 snapshot drift만 deferred이며 최종 통합·구조 오류는 계속 차단돼야 한다. [구현 리뷰 검사](../../tests/wrapper_repair.test.mjs), [완료 판정 검사](../../tests/wrapper_reconciliation.test.mjs), [실행 검사](../../tests/wrapper_dispatch.test.mjs)와 설치 검사를 사용한다.

중복 실행·미변경 재요청·재검토 한도·입력 stale·미기록 pass의 진행을 차단한다. 설치·업데이트된 소비 프로젝트에서 같은 CLI 동작과 프로젝트 변경의 Git 가시성을 확인한다. [리뷰 검사](../../tests/spec_review.test.mjs), [계획 검사](../../tests/plan_traceability.test.mjs), [설치 검사](../../tests/installer_update.test.mjs)를 사용한다.

AC-delivery: 프로젝트별 구현/test 지침은 original project root의 두 `docs/agents/*-guidance.md` 문서에서 관리되고 모든 linked worktree worker에 같은 absolute `shared_guidance_root`가 전달된다. implement/implementation agent는 둘 다 읽고 test runner는 testing 지침을 읽는다. Spec/execution profile 충돌은 해결 전 구현·테스트 실행을 막는다. checkpoint의 tests.e2e_failures는 빈 배열/성공 요약/인계로 사라지지 않으며 원본 evidence_path를 교체할 수 없다. 미해결/unknown/예방 조치·재검증 근거가 불완전한 실패가 있으면 tests gate와 wrapper 완료 판정이 passed 요약도 차단한다. 기계 검사는 기록 형식/상태이며 실제 근거/예방 충분성은 독립 리뷰가 확인한다. 실행/통합 계약이 누락된 프로젝트는 구현 agent가 시작되지 않으며 준비 후 재검사에서 pass해야 한다. 최신 request/Spec/diagram·현행 용어/계약·읽은 source의 hash와 실제 fresh reviewer metadata를 검사한다. 미실행·작성자와 같은 reviewer·맥락 상속·미해결 중대 지적·변경된 입력은 spec-me 완료와 to-ticket 인계를 차단한다. Product 변경은 Architecture 리뷰도 무효화한다. 기계 검사는 기록과 입력 일치만 확인하며 실제 spawn 진위와 리뷰 의미는 원본 tool/agent 응답으로 대조한다. 정상 Spec 완료 receipt는 `spec_ready_for_planning`, 계획 발행 완료 receipt는 `plan_set_ready_for_implementation`, 최종 통합 구현 완료 receipt는 `feature_implemented`를 기록한다. `waiting`은 종료가 아니며 session/worktree를 유지한다. `handoff`·`aborted`·`failed`는 `completed`와 구별해 recovery receipt에 남긴다. E2E 여부/의미 oracle 선택은 공통 수동 정책이며 runtime 자동 판정이 아니다. E2E/full-stack/browser end-to-end 명시 요청이 없으면 저비용 검사로 입증 불가한 변경 critical cross-boundary에만 E2E를 요구한다. 일반 테스트/검증 요청이나 서비스 실행 요청은 E2E 요청이 아니다. 공개 e2e-test skill/runner 설명도 승인된 E2E 실행에 한정되어 generic test/verification 요청을 불필요하게 full-stack으로 dispatch하지 않는다. 실패/누락 증거와 신규 mirror 불일치는 agent 시작·Done·종속 plan 해제를 막는다. 계획 추적 원장의 누락·stale review·coverage 오류는 dispatch와 완료를 막으며, 완료는 whole plan set의 requirement별 evidence/receipt를 검사한다. GitHub 기본 Status/Issue closure는 동기화 명령이 변경하지 않는다. journal replay가 checkpoint를 복구하고 폐기 경로가 남으면 retirement 검사가 실패한다.

검증: [E2E 실패 학습 회귀 검사](../../tests/e2e_learning.test.mjs).

구현: [src/wrapper/dispatch.mjs](../../src/wrapper/dispatch.mjs) · 검증: [tests/wrapper_dispatch.test.mjs](../../tests/wrapper_dispatch.test.mjs) · [상태 동기화 검증](../../tests/tracker_lifecycle.test.mjs)

<a id="decisions"></a>
## 설계 결정과 근거 검토
수정일: 2026-10-16
상태: implemented

### 설명
설계 대안과 근거·시스템 목표·승인 이력을 보존한다.

### 비즈니스 규칙
BR-decisions: Learning mode 자료 사용은 material approval로 제어한다. approved hash와 review provenance를 검증한다. 통과하지 못한 결정을 완료로 기록하지 않는다.

`spec-me`는 Architecture 대안 선택 전에 내부 근거 스킬로 결정 질문별 기존 승인 Principle과 durable Evidence의 적용 조건·충분성을 확인한다. 충분한 근거는 재사용하고 부족한 질문만 knowledge-harvest로 수집·검토·승인한 뒤 다시 평가한다. 부족하거나 승인 대기인 결정은 보류한다. 내부 스킬은 공개 스킬 목록이나 사용자 명령으로 등록하지 않는다. 충분성 판단과 수집 호출은 agent 지침이며 새로운 runtime gate가 아니다.

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
수정일: 2026-10-23
상태: implemented

### 설명
전체 Product·DDD Architecture 계약과 연결 다이어그램을 계속 갱신한다.

### 비즈니스 규칙
BR-contracts-feature: 현행 구현과 accepted-target을 구분한다. source/문서/모델 변경은 검토와 version receipt를 요구한다. local checkpoint는 snapshot에서 제외한다. diagram 원본과 SVG가 일치해야 한다. Spec 제안·티켓 계획·개별 plan 구현·리뷰·knowledge 작업은 통합 계약을 수정하거나 seal하지 않는다. 전체 구현을 통합하는 최종 구현 workflow만 계약을 갱신하며, 구현 중에는 source snapshot drift만 명시적으로 지연할 수 있다. 계약 bundle 오류와 실행 준비 실패는 계속 차단한다. 기계 검사만으로 의미 정확성을 승인하지 않는다.

### 수용 조건
AC-contracts-feature: 최종 구현 완료에서 stale snapshot·필수 필드·소유 링크·기능 sequence·SVG provenance·base revision 오류를 차단한다. `spec-me`, `to-ticket`, 개별 plan 구현·리뷰·knowledge workflow는 계약 검사를 요구하지 않으며 계획·ticket Spec만으로 계약을 수정하지 않는다. 구현 준비는 source snapshot drift만 최종 동기화까지 명시적으로 지연하고 구조 오류·실행 준비 실패는 차단한다. 최종 구현 workflow는 공통 완료 명령과 CI의 동일 검사를 통과해야 하며 시작 SHA가 없거나 hook이 실패하면 정상 완료 receipt를 발급하지 않는다.

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
