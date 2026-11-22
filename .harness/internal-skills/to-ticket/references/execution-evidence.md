# 계획 실행 위치와 검증 계약

이 문서는 계획 작성에 필요한 실행 위치와 검증 계약을 정의한다. 별도의 요구사항 대응표나 구현 결과 traceability/checkpoint payload를 만들지 않는다. plan에는 소유 요구와 기대 결과, 필요한 테스트 계약을 기록한다.

## 실행 위치

실행 경로와 브랜치는 정적 실행기가 정본 `worktree.json`과 실제 Git root·common directory·등록·branch를 대조해 생성한다. 입력의 `context.execution_workspace`와 plan-review 결과의 `details.execution_workspace`는 같은 코드에서 생성되며 agent가 직접 입력하거나 추측하지 않는다. `return_root`나 계획 문서의 문자열로 실행 위치를 선택하지 않는다.

계획 작성자는 canonical plan·index·GitHub 초안에 `workspace_root`·`workspace_branch`를 쓰거나 복사하지 않는다. 계획에는 업무 범위·요구·의존성·테스트만 작성한다. 정적 입력 준비기가 발행 본문의 실행 정보와 그 파일 경로를 생성해 publisher에 전달한다. Publisher는 제공된 파일을 그대로 사용하고 worker는 정적 입력의 workspace에서 실행한다.

기존 승인 계획의 경로 문자열은 과거 표시 정보로만 보존한다. 실제 소비자인 보존 workflow의 승인 snapshot을 임의로 덮어쓰지 않으며 runtime은 그 값을 읽어 실행하지 않는다. 다음 계획 재작성 때 이 구형 필드를 제거한다. 발행용 session 사본은 정적 실행기가 현행 실행 정보로 생성하며 canonical 업무 계획·리뷰 hash를 변경하지 않는다.

ticket의 테스트 계약은 소유한 규칙의 비즈니스 로직 단위 테스트와 전술 설계의 컨텍스트 경계 강제 검사만 정의한다. 사용자 경로 E2E는 ticket이 아니라 사용자가 요청한 별도 `e2e-test` stage가 소유하며 `.harness/agents/EXEC.md`와 `execution.json` profile을 쓴다. 실제 실행 준비와 필수 gate는 각 실행 단계에서 확인한다.

## 계획 시

각 ticket의 `소유 규칙과 검증` 표에는 소유 BIZ·INV·EX·AC, 강제 위치와 사용자가 확인할 기대 결과를 적는다. 별도 대응표, ledger, requirement-to-code/test chain은 만들지 않는다. 검증 테스트에는 소유 업무 규칙의 조건·행위·기대 결과를 검증하는 단위 테스트만 기록하고, 업무 로직 변경이 없으면 테스트를 추가하지 않는다. 컨텍스트 경계 검사는 `tactical-design.md`의 컨텍스트 경계 결정이 정한 방식으로 적는다. ticket에는 E2E를 배정하지 않는다. GitHub 구조 입력에서는 기존 `acceptance_criteria`, `test_contract.unit_policy` 문자열에 포함해 canonical renderer가 보존하게 한다.

Live agent 확인이 필요한 경우에는 사전 승인한 task와 task/environment budget, trace/correlation ID로 볼 결과를 함께 고정한다. UI stub은 request/stream/loading/done 같은 안정 상태만 검증하며 live 품질로 표시하지 않는다.

- 변경된 rule과 enforcement method/function, 허용·금지 의존성, 기존 검사 또는 도메인 테스트.
- 현행/폐기 용어와 호환 식별자 예외. 기존 구현 대체라면 old → new 경로, 이전할 소비자, 삭제할 구현/export/config/fixture와 잔존 검색·동작 검증. 제거할 수 없는 호환 경로는 소비자 근거·제거 조건·후속 tracker 참조를 포함한다.
- 제거하기로 승인된 파일/디렉터리는 해당 canonical plan의 `## 제거 대상` 절에 불릿 한 줄당 backtick 저장소 상대 경로(``- `src/old/Legacy.java` — 대체 경로``)로 적는다. 최종 완료 gate가 이 절을 읽어 `retirement.removed_paths`로 쓰고 경로가 실제로 없는지 확인하며, 절이 없으면 승인된 제거가 없는 것으로 본다. 이 절은 plan 리뷰 snapshot에 들어가므로 구현 중에 목록을 바꾸지 않는다. canonical tracker에는 기존 acceptance/test-contract 문자열에 같은 목록을 보존하고 새로운 structured-source key를 추가하지 않는다. 제거 대상이 없으면 절을 쓰지 않으며 gate가 빈 목록과 도출한 사유로 통과시킨다. 이 검사는 새 후보가 임의로 정한 목록이 아니라 승인된 계획의 제거 목록을 사용한다.
- 성능·용량·자원 사용·장기 실행 안정성이 관련되면 연결된 System Target, 실제 사용자 경로, 대표 workload 크기/분포/동시성, 지표·단위, 측정 명령, 환경, baseline commit, 허용 회귀와 성공 조건.
- baseline은 구현 전에 관측한다. 수치가 없으면 `미측정`과 수집 방법을 쓰며 예상치를 측정값으로 쓰지 않는다. 새 기능은 이전 동등 경로나 명시적 목표와 비교하고, 비교 불가능하면 전후 개선율을 계산하지 않는다.
- 성능과 무관한 작은 변경은 `해당 없음 — 근거`로 충분하다. 모든 slice에 benchmark나 runtime logging을 추가하지 않는다.
- 여러 slice가 같은 경로를 바꾸면 같은 workload와 지표를 유지하고 대표 checkpoint에서 누적 결과를 비교한다. 기준을 바꾸면 이전 결과와 비동등임을 기록한다.

## 실행 전제 변경

단위·회귀 검증은 `verification_files`와 실행 가능한 기본 CLI `verification_command`를 기록한다. 실행 인자·환경·설정·인프라가 바뀌는 plan-set의 최종 사용자 흐름 E2E만 execution.json profile과 EXEC 갱신 범위에 포함한다. 실제 entrypoint·config loader·infra/CI를 확인해 argv, 환경, 설정 검사, dependency readiness를 지정한다. E2E profile에는 `purpose: "e2e"`를 명시한다.

사용자 흐름 E2E에 필요한 실제 DB·브로커 등 인프라는 Docker로 준비하도록 계획한다. 해당 프로젝트가 소유하는 EXEC와 profile에 이미지·버전, 설정·네트워크·포트, readiness, 로그, 실행 소유 컨테이너의 정리와 실패 시 정리를 명시한다. 의존 서비스가 없으면 `해당 없음`과 이유를 기록한다. 앱과 브라우저의 실행 위치는 실제 프로젝트 계약을 따른다. 일반 단위·회귀 검증에 Docker를 추가하지 않는다.
