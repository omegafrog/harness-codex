# Workflow 지도

현재 요청과 정본 결과를 기준으로 완료되지 않은 첫 단계를 고른다. `workflow-compose` 완료는 worktree 준비 완료다. `workflow_ref`가 `null`이고 다음 stage가 기록되지 않았으면 정본 원 요청으로 필요한 흐름을 고른다. 직접 요청은 [기능 라우팅](capability-routing.md), Spec 기반 legacy 구현은 [구현 workflow 조율](implementation.md)을 따른다.

## 요구사항과 승인

`stakeholder-analysis` → `subdomain-candidates` → `ubiquitous-language` → `event-storming` → `subdomain-classification` → `requirements-fix` → `bounded-context` 순서다. 독립 persona가 낸 요구 후보의 채택은 사용자에게 묻는다. 서브도메인 후보별 독립 업무(BIZ)를 기록하고 용어·이벤트·hotspot을 정리한다. 분류 단계는 경계 후보와 분류를 확인받고 유지안을 선택한 경우에도 경계 결정을 기록한다. `requirements-fix`가 업무 규칙·예외·완료 조건의 빈칸을 채운 뒤 `bounded-context`가 경계를 확정해 `requirements.md`를 `fixed`로 만든다. `ubiquitous-language`는 `CONTEXT.md`, `bounded-context`는 `CONTEXT-MAP.md`를 함께 갱신한다. 이벤트 다이어그램 렌더가 막히면 해당 stage의 차단을 기록하고 환경 복구 뒤 이어간다.

`stakeholder-analysis`가 기존 승인 업무 안의 자명한 변경으로 `판정: 생략`이면 나머지 요구사항·전술 설계 stage는 문서 없이 생략 결과를 기록한다. 이해관계자 등록 요청은 `node .harness/scripts/harness-stakeholder.mjs add`로 사용자 소유 카드를 작성하도록 안내한다. worktree에서 사용할 카드는 커밋되어 있어야 한다.

`bounded-context`가 완료되면 확정된 `requirements.md`의 업무별 규칙·예외·완료 조건과 서브도메인·바운디드 컨텍스트를 보여 주고 [승인 답변 형식](input.md#사용자-승인-답변-전달)을 안내한다. 사용자가 직접 승인한 뒤에만 `launch --stage-id domain-model --requirements-approved true --approval-answer '<사용자 답 원문>'`을 실행한다. 실행기는 `bounded-context` 완료 뒤 실제 답이 기록됐는지 확인한다. 부분 수정 뒤에는 현재 요구사항을 다시 승인받는다. 수정은 [상위 stage 되돌아가기](dispatch.md#상위-stage-되돌아가기)와 사용자 수정 절차의 적용 조건을 따른다.

## 전술 설계

`domain-model` → `aggregate-design` → `domain-service` → `application-service` → `integration-design` → `context-boundary` 순서로 `docs/specs/<plan-set-id>/tactical-design.md`의 BC별 모델·Aggregate·업무 규칙·Application Service 메서드·트랜잭션·인터페이스를 채운다. 중요한 결정은 해당 구성요소에서 `docs/adr/`로 연결한다. stage 이름은 문서 이름이 아니다. 현재 양식은 각 stage가 소유한 부분을 완료 전에 검사하고 마지막 `context-boundary` 완료 때 `harness-domain-model-check.mjs`가 문서 전체를 검사한다. `gate_error`의 `owner_stage`는 문제 섹션을 소유한 단계다. [결과 처리](dispatch.md#결과-처리)를 적용한다. 신규 기능 흐름은 Product·Architecture Spec을 거치지 않는다.

## 전술 설계에서 구현까지

전술 설계가 모두 `completed/OK`인 뒤 별도 `tactical-to-code` workflow를 시작한다. 순서는 `tactical-technology` → `tactical-ui` → `tactical-api` → `tactical-data` → `to-ticket` → `tracker-publish` → `tactical-code`다. 실행기는 전술 설계와 앞 단계 완료를 확인한다. 이 흐름은 요구사항 롤백에 포함되지 않으므로 그 롤백은 애플리케이션 코드를 복원하거나 삭제하지 않는다.

- `tactical-technology`는 기존 기술을 먼저 평가하고 필요한 선택에 근거를 붙인다. `tactical-ui`에서 화면 설계가 필요하면 독립 `frontend-design` workflow의 `frontend-design-brief` stage로 [인계](dispatch.md#ui-적용과-보류)한다. 계획에 UI 변경이 없거나 사용자가 보류하면 UI 스킬 없이 API·데이터 설계를 진행한다. `tactical-api`는 application entry와 API, `tactical-data`는 저장·데이터 소유·인프라 바인딩을 정한다.
- 전술 설계와 구현 결정은 기존 BIZ·INV·EX·AC를 근거로 한다. `tactical-data` 완료 때 `harness-design-freeze-check.mjs`가 API·데이터·UI 설계의 추적과 요구 적용 범위를 검증한다. `UNTRACED_ITEM`·`REQUIREMENT_UNCOVERED`가 나면 실행기가 소유 stage를 알려 준다. 통과한 뒤 `to-ticket`은 확정된 설계를 컨텍스트와 업무별 vertical ticket으로 나누고 fresh `plan_reviewer`의 독립 리뷰를 받는다.
- `tracker-publish` 전에 [계획 발행 승인](coordination.md#계획-발행-승인)을 받는다. 계획·발행까지가 요청이면 그 범위에서 완료 gate를 실행한다. 구현이 요청됐으면 `harness-context.mjs`의 `ready_tickets`에서 하나를 골라 `launch --stage-id tactical-code --plan <ticket-id>`를 실행한다. 미완료 선행 티켓이 있거나 이미 완료된 티켓은 실행기가 거부한다. 각 티켓은 자체 테스트와 commit을 남긴다. 모든 티켓이 끝나면 [완료 gate](dispatch.md#workflow-완료)를 실행한다.
- 발행 뒤 `frontend: true`인 티켓은 독립 `frontend-implementation --plan <ticket-id>`과 `frontend-visual-review --plan <ticket-id>` 뒤 `tactical-code`로 완료한다. visual review에 지적이 있으면 같은 티켓의 frontend 구현을 수정해 다시 검토한다. 별도 엔드유저 E2E는 사용자가 요청할 때 [e2e-test](../../../../.harness/internal-skills/e2e-test/GUIDE.md)를 따른다.

앞 단계 산출물이 부족하면 `blocked/DEPENDENCY_INCOMPLETE`의 `owner_stage`와 `dependency_gap`을 사용해 [가장 앞선 소유 단계](dispatch.md#상위-stage-되돌아가기)를 다시 연다. 의존성 보완은 기존 문서·결정·식별자를 보존하고 영향을 받은 결과만 다시 검토한다.
