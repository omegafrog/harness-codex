# 기존 도메인 모델과 변경 설계의 연속성

DDD 설계·구조 설계·구현·Architecture 리뷰에서 영향받는 범위에만 적용한다. 작은 기능은 기존 소유 모델을 확장하는 안을 먼저 검토한다. 새 Entity, Aggregate, module, service의 개수는 설계 품질 지표가 아니다.

## 설계 시작: 현재 모델 확인

`CONTEXT.md`, `CONTEXT-MAP.md`, 연결된 ADR 및 `docs/architecture/domain-model.md`가 있으면 먼저 읽는다. 모델 문서가 없으면 영향받는 코드와 테스트로 현재 구조를 복원한다. 문서 누락을 새 경계 생성 근거로 삼지 않는다. `code-research`는 다음을 source `file:line` 및 확인한 commit과 함께 반환한다.

| 확인 대상 | 필요한 사실 |
|---|---|
| 기존 Context와 capability | 언어, 책임, 코드 경로, 공개 진입점, 데이터 소유자 |
| 기존 Aggregate와 모델 | root/ID, 상태, invariant, 실제 변경 메서드 또는 소유 함수, repository 및 transaction |
| 호출과 통신 | 진입점 → application → domain → persistence, 경계 간 호출자와 소비자, 동기/비동기 및 실패 처리 |
| 운영 경계 | 실제 deployment unit, 프로세스·DB 공유, 관찰된 부하와 현재 제약 |

문서상의 의도와 현재 구현이 다르면 둘 다 근거를 남긴다. 확인되지 않은 Aggregate를 만들어 채우지 않는다. 구현에 Aggregate가 없으면 `확인되지 않음` 또는 `해당 없음`과 이유를 적는다. 이미 승인된 경계·설계 제약은 재사용하고, 변경되는 결정만 다룬다.

용어는 [현행/폐기 기록](../../domain-modeling/references/language-lifecycle.md)을 먼저 대조한다. 구형 코드에 남은 이름을 새 모델의 canonical term으로 복원하지 않는다.

## 변경 설계: 재사용과 규칙 소유권

- 먼저 기존 모델/함수/패키지 안에서 요구사항을 만족하는 변경을 제시한다. 새 경계가 필요하면 이 안이 깨뜨리는 구체적인 invariant, 언어 또는 의존성 제약을 설명한다. 단순 CRUD와 조회에는 억지로 rich domain model을 만들지 않는다.
- business rule/invariant마다 안정적인 기존 ID를 재사용하고, 소유 Context와 Aggregate/Entity/Value Object/domain policy, 실제 enforcement method/function, 상태 변경 진입점, 검증 증거를 연결한다.
- 객체 모델에서는 자신의 상태와 업무 규칙을 소유 객체의 의미 있는 동작으로 캡슐화한다. application service가 값을 읽어 업무 판단을 한 뒤 setter로 상태를 조합하게 하지 않는다. public setter·mutable collection·ORM hydration·직접 DB 쓰기로 invariant를 우회할 수 있는지도 본다. 함수형 코드에서는 소유 모듈의 명시적인 전이 함수와 상태 표현으로 같은 원칙을 지킨다. 클래스로 바꾸는 것이 목표가 아니다.
- application은 트랜잭션과 작업 순서를 조율하고, infrastructure는 저장·전송을 맡는다. 외부 DTO 검증과 도메인 불변식은 책임이 다르다. 하나의 규칙을 여러 계층에 복제하지 않는다.
- 단일 Entity/Value Object가 자연스럽게 소유하지 못하는 도메인 판단만 domain service/policy로 둔다. application이나 무관한 Aggregate가 다른 Aggregate의 내부 상태를 직접 변경하지 않는다. 교차 Aggregate 규칙의 조율·일관성·경합 처리와 실패 복구는 명시한다. 기존 cross-aggregate transaction이 필요하면 근거를 기록하고 무조건 이벤트로 바꾸지 않는다.
- pass-through service, 한 구현뿐인 불필요한 port, 같은 입력을 전달하는 wrapper, 미래 재사용용 option, 사용되지 않는 event·repository·공통 base type은 추가하지 않는다. 실제 경계 격리나 변환을 수행하는 abstraction은 유지한다.

## 기존 구현을 대체할 때

변경 대상의 기존 public entrypoint·호출자·export·설정/CLI·동적 경로·installer·테스트/fixture·현행 문서 참조를 찾는다. 설계와 plan에 `기존 경로 → 대체 경로 → 소비자 이전 → 제거 또는 호환 유지 근거 → 검증`을 기록한다. 새 구현을 추가하는 것만으로 대체 작업을 완료하지 않는다.

기능 추가 중 기존 caller를 현행 operation으로 옮기는 경우도 이 정리에 포함한다. “전면 교체가 아니다”라는 이유로 소비자가 없어진 구형 alias/wrapper를 남기지 않는다. 현재 공개 계약에 필요하지 않은 경로는 범위 안에서 제거한다.

- 범위 안의 소비자를 새 소유 operation으로 이전하고, 도달 불가능하거나 대체된 구현·wrapper·export·설정과 더 이상 의미 없는 테스트를 같은 변경에서 제거한다. 구형 구현을 기준으로 새 테스트를 늘리지 않는다.
- 실제 외부 호환·저장 데이터 migration·진행 중인 의존 ticket 때문에 즉시 제거할 수 없으면 소비자 근거, 단일 변환 경계, 제거 조건과 기존 tracker의 후속 항목을 남긴다. 근거 없는 “나중에 사용”이나 자기 코드끼리만 쓰는 이중 경로는 유지 이유가 아니다.
- 제거 전 실제 호출/동적 참조와 외부 계약을 확인한다. 검색 결과 없음만으로 외부 사용 부재를 단정하지 않는다. unrelated legacy 코드나 historical Spec을 일괄 삭제하지 않는다.
- 완료 증거에는 이전된 소비자의 실제 동작과 구형 경로/참조의 제거 결과 또는 명시적 호환 예외를 포함한다. stale 문서·샘플·테스트가 다음 agent에게 구형 경로를 추천하지 않게 한다.

작은 변경도 완료 전 기존 완료 보고에 최소한 `현행 용어와 호환 예외`, `기존 경로/소비자 검색과 제거 또는 유지 근거`, `관련 UC/BR → owner/source → 실제 검증 결과`, `모델 문서 갱신 또는 불변 근거`를 짧게 기록한다. 별도 보고서·표를 늘릴 필요는 없다. 항목을 확인하지 않았으면 미검증이며 테스트 통과 개수로 대신하지 않는다.

## 통신과 배포 결정

각 변경된 경계 연결에 caller/provider, 소유 데이터, public contract, 선택한 방식, 비교한 대안과 근거를 남긴다.

- 같은 프로세스에서는 명시적 공개 API를 통한 직접 호출을 먼저 검토한다. domain event의 의미와 broker 전송은 별개다. 단순 호출에 HTTP·broker·outbox를 미리 넣지 않는다.
- 동기 호출은 결과가 즉시 필요한 이유, transaction 참여 여부, 오류 전파와 원격일 때 timeout을 정한다. 비동기는 허용 지연, commit/publish 경계, 유실·중복·순서·재시도·보상과 멱등성 책임을 정한다. outbox 등은 필요한 보장이 있을 때 선택한다.
- 이웃 Context의 repository, table, 내부 타입에 직접 접근하는 경로를 식별하고 계약과 translation 소유자를 정한다. 조회용 projection과 업무 상태 쓰기는 구분한다.
- 현재 deployment unit을 명시한다. 기존 제약이 없다면 모듈형 모노리스 안의 현재 배포 단위를 유지하는 안부터 검토한다. Context, Aggregate, module, server를 1:1로 매핑하지 않는다.
- 분리 배포는 측정된 scaling 병목, 독립 release cadence, 장애 격리, 보안·규제 또는 운영 소유권 등 구체적 요구로 정한다. 선택하지 않은 경우에도 extraction trigger를 관찰 가능한 조건이나 연결된 System Target으로 기록한다. 근거 없는 수치를 만들지 않는다. trigger 충족은 재설계 신호이며 자동 추출 지시가 아니다.

## 모델 문서의 수명

`CONTEXT-MAP.md`는 Context 책임·관계와 모델 문서 링크를 유지한다. `docs/architecture/domain-model.md`는 영향받는 기존/승인 모델의 현재 기준이며 용어집을 대체하지 않는다.

| Context / 모델 ID | 상태 | Root / 소유 코드 | 규칙 ID → enforcement | 데이터 / transaction | 공개 계약 / 통신 | deployment / extraction trigger | 근거 |
|---|---|---|---|---|---|---|---|

- 상태는 `implemented`와 `accepted-target`을 구분한다. 설계 승인만으로 구현됐다고 기록하지 않는다. 대상과 현재가 다르면 적용 ticket/Spec 및 기준 commit을 연결한다.
- Architecture 완료 때 영향받는 모델의 승인 변경과 근거를 반영하고, 구현 완료 때 실제 코드·검증·commit에 대조해 `implemented`로 갱신한다. 경계 변경이 없으면 불필요한 문서·다이어그램을 만들지 않는다.
- 구조나 통신이 바뀌면 기존 class/context/sequence 다이어그램을 재사용·갱신하거나 ticket-scoped 원본과 SVG를 연결한다. 동일 관계를 별도 사본에 다시 정의하지 않는다. 다이어그램 생성은 기존 `plantuml-diagrams`/`diagram_creator` 계약을 따른다.
- 다음 `spec-me`는 이 문서와 연결된 source/ADR를 다시 확인한다. 오래된 문서를 구현의 증거로 단독 사용하지 않는다. 동시 ticket 변경은 영향받는 행만 조정하고 상대 변경을 덮어쓰지 않는다.

## 리뷰 증거

리뷰는 변경된 rule ID마다 실제 enforcement와 호출자를 따라가 캡슐화 우회·규칙 중복·도메인 로직 유출·허용되지 않은 의존성을 찾는다. 가능하면 저장소의 기존 dependency/import/architecture 검사와 우회 시도를 거부하는 domain test를 사용한다. 자동 검사가 없으면 `file:line`과 확인한 우회 경로를 보고하고, 정적 구조 검사만으로 의미적 DDD 적합성을 입증했다고 하지 않는다.
