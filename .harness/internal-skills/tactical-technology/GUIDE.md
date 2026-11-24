---
model_tier: low_performance
---
# tactical-technology

실행 배정에 `document_draft_root`가 있으면 완성한 문서를 그 아래의 같은 상대 경로에 직접 쓴다. 실행기가 gate 통과 후 그 바이트를 정본에 반영한다. 결과에는 정본의 상대 경로를 적는다.

## 목적

확정된 전술 설계로 구현을 시작하기 전에 필요한 runtime·framework·언어·라이브러리 결정을 정리한다. 기존 기술 선택 절차의 기준과 근거 검증을 재사용하되 결과는 이 workflow의 산출물로만 보관한다. 새 Product/Architecture Spec을 작성하지 않는다.

## 입력과 진행

사용자 요청, `CONTEXT.md`, 완료된 tactical design 산출물을 확인한다. 먼저 현행 저장소의 runtime, framework, dependency, 테스트 명령, 배포·운영 안내를 조사한다. 사용 중인 stack은 유효한 후보로 포함한다. 이미 요구를 충족하는 기술 결정은 재사용하고 불필요한 선택은 만들지 않는다.

`.harness/internal-skills/technology-selection/GUIDE.md`의 기준 도출·후보 비교·공신력 있는 근거·불확실성 구분 원칙을 적용한다. 실행 환경이 달라지거나 운영 책임·비용·보안·데이터 제어·성능이 달라지는 중요 선택만 다룬다. 기존 stack을 유지하면 근거와 예외를 기록한다. 자료로 판정할 수 없는 중요한 선택만 한국어 한 묶음의 질문으로 반환한다. 답변을 요구하지 않은 기본값으로 기록하지 않는다.

## 구현 기술 결정과 면담 완료 조건

구현이나 티켓 발행 전에 이 stage가 실제 구현 가능한 기술 stack을 확정한다. 확정된 요구·전술 설계·저장소를 근거로 다음 체크리스트의 적용 여부를 먼저 판정한다. 적용되는 항목은 구체적인 제품·버전 범위 또는 실행 명령까지 정하고, 적용되지 않는 항목은 해당 없음과 근거를 기록한다.

- 애플리케이션 runtime과 버전 범위, 구현 언어 및 module/build/package 도구.
- 적용되는 서버/API와 UI의 framework 또는 의도적으로 framework를 사용하지 않는 방식, 실행·개발 명령.
- 영속 저장소와 database engine, 접근 client/driver 또는 ORM, migration 도구, transaction 방식. 저장하지 않는 경우 그 이유.
- 필요할 때 외부 통신·메시징 등 outbound 연동 구현에 필요한 라이브러리와 조립 제약.
- 구현에 사용할 단위 테스트 도구와 실제 실행 CLI, 필요 인프라와 실행 전제.

기존 프로젝트의 유효한 기술·명시된 사용자 선택을 우선 재사용한다. 근거 있는 일반 엔지니어링 선택과 명시적 위임은 사용자 선택인 것처럼 쓰지 않고 출처와 이유를 구별한다. UI/API/data 저장을 무조건 추가하지 않는다. 적용 여부가 불분명하면 관련 요구와 전술 설계부터 확인하고, 필요한 범위 여부가 여전히 불명확하면 질문한다. 구현에 필요한 항목을 단순히 `미정`으로 둔 채 `completed/OK`를 반환하지 않는다.

필수 체크리스트를 coverage로 삼아 [grill-with-docs](../grill-with-docs/GUIDE.md)를 batch mode로 실행한다. 질문 전 그 GUIDE와 `references/how-to-grill.md`를 읽고, 모든 항목을 `SETTLED`, `PARTIAL`, `UNRESOLVED`, `NOT_APPLICABLE`로 분류한다. 독립적인 미결정을 한 묶음으로 모으고, 호환되는 stack 조합과 근거·추천을 제시한다. 사용자의 재질문·이의·미확정 제안은 수용으로 간주하지 말고 답하거나 조사한 뒤 결정이 해소될 때까지 필요한 후속 질문을 반복한다. 명시적 위임은 존중하며 이미 정해진 선택을 반복 확인하지 않는다. 영역이 모두 `SETTLED` 또는 근거 있는 `NOT_APPLICABLE`이고 충돌·차단 질문이 없어야 면담과 stage를 완료한다. 이 stage의 문서 소유 범위는 아래 산출물 규칙을 그대로 따른다.

컨텍스트별 Application Service가 사용하는 outbound 인터페이스를 확인해, 필요한 저장·외부 통신·메시징·트랜잭션의 구현 기술과 재사용할 기존 도구를 결정한다. 인터페이스의 코드 위치·구현체·조립은 `tactical-data`가 정하므로 그 결정에 필요한 기술과 기존 조립 관례를 `technology.md`에 남긴다.

## 범위 추가 금지

기술 선택은 확정된 요구와 설계를 구현하는 수단만 정한다. 요구에 추적되지 않는 기능·화면·endpoint·데이터를 기술 결정의 부산물로 만들지 않고, 범위 질문도 하지 않는다. 선택 근거는 `requirements.md`의 BIZ/INV/EX/AC나 `tactical-design.md`의 `AS-xx`·`CON-xx`를 인용한다.

## 산출물

매번 `docs/implementation/<plan-set-id>/technology.md`에 체크리스트의 적용 판정과 확정된 stack 및 버전 범위, 실제 실행·검증 명령과 전제, 필요한 후보, 요구 기준, 출처/확인일, 선택 근거·결정 주체, 수용한 단점을 한국어로 기록한다. 구현에 필수인 미결정은 면담에서 해소하며, 비차단 불확실성은 명시한다. 계획 ID는 현재 worktree의 canonical `plan_set_id`를 사용한다. 필요하고 확인된 실행 방법 또는 infrastructure 전제가 달라질 때만 project-owned `.harness/agents/EXEC.md`의 관련 지침도 갱신한다. 실행기가 완료 시 이 두 stage-owned 문서 경로만 자동 commit한다. 다른 파일을 수정하지 않는다.

Freeze가 읽는 표의 열 이름은 `항목 | 판정 | 결정·근거`다. `runtime`, `language-build`, `server-api`, `ui`, `storage`, `storage-access`, `migration`, `transactions`, `outbound`, `unit-test-tool`, `unit-test-cli`를 각각 한 행에 적는다. `SETTLED` 행에는 구체 결정과 근거를, `NOT_APPLICABLE` 행에는 적용되지 않는 이유를 적는다. 저장소 엔진은 `storage`에, 접근 client/driver/ORM 또는 파일 접근 방식은 `storage-access`에 적는다. 선언한 outbound 포트가 저장소 포트뿐이면 `outbound`에 해당 포트가 재사용할 저장 기술을 기록한다. 테스트 CLI는 모듈·인자까지 실제로 실행할 명령을 적는다. 서버/API 또는 UI를 framework 없이 구현하는 경우에도 구현 방식과 실행 명령을 `SETTLED`로 기록한다.

결과는 `completed/OK` 또는 `action_required/USER_DECISION_REQUIRED`다. 기술 선택 질문의 근거는 질문 결과에 적고 `answers.json`을 보존한다. 이 stage는 code, Product Spec, Architecture Spec, `docs/contracts/`를 수정하지 않는다.

앞선 전술 설계 stage의 산출물이 부족해 진행할 수 없으면 `blocked/DEPENDENCY_INCOMPLETE`로 반환하고 `result.owner_stage`(빈틈을 소유한 가장 앞 stage)와 `result.dependency_gap`(그 stage가 추가하거나 고쳐야 할 내용과 근거)을 반드시 적는다. 실행기는 둘이 없으면 반려하며, orchestrator가 사용자에게 묻지 않고 그 stage를 다시 열어 이 stage까지 순서대로 다시 진행한다. 업무 결정이 필요하면 이 코드가 아니라 `USER_DECISION_REQUIRED` 질문을 쓴다.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .harness/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 설계에 사용한 공통 정의의 ID를 근거로 남기고 범위는 확정 요구사항을 따른다.
