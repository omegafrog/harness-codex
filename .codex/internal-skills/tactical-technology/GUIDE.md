---
model_tier: low_performance
---
# tactical-technology

## 목적

확정된 전술 설계로 구현을 시작하기 전에 필요한 runtime·framework·언어·라이브러리 결정을 정리한다. 기존 기술 선택 절차의 기준과 근거 검증을 재사용하되 결과는 이 workflow의 산출물로만 보관한다. 새 Product/Architecture Spec을 작성하지 않는다.

## 입력과 진행

사용자 요청, `CONTEXT.md`, 완료된 tactical design 산출물을 확인한다. 먼저 현행 저장소의 runtime, framework, dependency, 테스트 명령, 배포·운영 안내를 조사한다. 사용 중인 stack은 유효한 후보로 포함한다. 이미 요구를 충족하는 기술 결정은 재사용하고 불필요한 선택은 만들지 않는다.

`.codex/internal-skills/technology-selection/GUIDE.md`의 기준 도출·후보 비교·공신력 있는 근거·불확실성 구분 원칙을 적용한다. 실행 환경이 달라지거나 운영 책임·비용·보안·데이터 제어·성능이 달라지는 중요 선택만 다룬다. 기존 stack을 유지하면 근거와 예외를 기록한다. 자료로 판정할 수 없는 중요한 선택만 한국어 한 묶음의 질문으로 반환한다. 답변을 요구하지 않은 기본값으로 기록하지 않는다.

적용성이 확인되지 않은 UI/API/database를 가정하지 않는다. 요구와 전술 설계로 UI/API/data 저장이 명확하지 않으면 해당 영역은 미정으로 남기고 후속 계약 stage가 확인한다. 근거·답변이 없는 기술은 선택했다고 쓰지 않는다.

## 범위 추가 금지

기술 선택은 확정된 요구와 설계를 구현하는 수단만 정한다. 요구에 추적되지 않는 기능·화면·endpoint·데이터를 기술 결정의 부산물로 만들지 않고, 범위 질문도 하지 않는다. 선택 근거는 `requirements.md`의 BIZ/INV/EX/AC나 `tactical-design.md`의 `AS-xx`·`CON-xx`를 인용한다.

## 산출물

매번 `docs/implementation/<plan-set-id>/technology.md`에 현재 stack, 검토한 실행·검증 명령, 필요한 후보, 요구 기준, 출처/확인일, 선택 근거, 수용한 단점 및 미확정 항목을 한국어로 기록한다. 계획 ID는 현재 worktree의 canonical `plan_set_id`를 사용한다. 필요하고 확인된 실행 방법 또는 infrastructure 전제가 달라질 때만 project-owned `docs/agents/EXEC.md`의 관련 지침도 갱신한다. 실행기가 완료 시 이 두 stage-owned 문서 경로만 자동 commit한다. 다른 파일을 수정하지 않는다.

결과는 `completed/OK` 또는 `action_required/USER_DECISION_REQUIRED`다. 기술 선택 질문의 근거는 질문 결과에 적고 `answers.json`을 보존한다. 이 stage는 code, Product Spec, Architecture Spec, `docs/contracts/`를 수정하지 않는다.

앞선 전술 설계 stage의 산출물이 부족해 진행할 수 없으면 `blocked/DEPENDENCY_INCOMPLETE`로 반환하고 `result.owner_stage`(빈틈을 소유한 가장 앞 stage)와 `result.dependency_gap`(그 stage가 추가하거나 고쳐야 할 내용과 근거)을 반드시 적는다. 실행기는 둘이 없으면 반려하며, orchestrator가 사용자에게 묻지 않고 그 stage를 다시 열어 이 stage까지 순서대로 다시 진행한다. 업무 결정이 필요하면 이 코드가 아니라 `USER_DECISION_REQUIRED` 질문을 쓴다.
