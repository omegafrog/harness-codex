# Domain Docs

이 저장소는 multi-context layout을 쓴다.

## 문서 위치

- `CONTEXT.md` - 프로젝트 유비쿼터스 언어
- `CONTEXT-MAP.md` - bounded context 경계와 관계
- `docs/architecture/domain-model.md` - 영향받는 모델의 implemented/accepted-target, 소유 코드·규칙·통신·배포 및 canonical 다이어그램 참조
- `docs/architecture/constraints.md` - 사용자가 관리하는 지속적인 설계·구현 제약
- `docs/adr/` - 되돌리기 어려운 설계 결정

## 읽는 규칙

- 용어는 먼저 `CONTEXT.md`에서 확인한다.
- 현행/폐기·대체 관계를 확인하고 historical Spec이나 코드 이름을 active alias로 재등록하지 않는다. 호환 식별자는 실제 소비자와 경계·제거 조건을 남겨 구분한다.
- 설계자는 기존 glossary와 바뀐 개념의 의미·책임·identity·lifecycle을 비교해 정의 보정·rename·분리/통합·폐기 필요를 먼저 제안한다. 확정된 모델의 용어 변경은 함께 반영하고, 의미가 미확정이면 해당 설계 topic에서 해결한다. 사용자의 명시적인 용어 변경 요청을 선행 조건으로 삼지 않는다.
- 경계는 `CONTEXT-MAP.md`를 본다.
- 중요한 결정은 `docs/adr/`에 기록한다.
- 새 설계 전에 기존 모델과 연결된 source/ADR/다이어그램을 확인한다. 문서가 없으면 관련 코드에서 복원하고, 기능 이름으로 Aggregate/Context/module/server를 만들지 않는다.
- 설계 완료에는 승인 target, 구현 완료에는 실제 코드·검증·commit을 반영한다. 기존 implemented 상태를 미래 설계로 덮어쓰지 않는다. 모델 문서는 작업 상태 보드가 아니다.
- `docs/architecture/principles.md`는 해석 원칙이다. ADR 대체물이 아니다.

## ADR 기준

- 결정이 오래 남을 가치가 있으면 ADR로 남긴다.
- 임시 판단이면 계획이나 issue에만 둔다.
- 같은 결정을 여러 문서에 중복 정의하지 않는다.

## 현행 통합 계약

대상 프로젝트의 전체 기능·규칙·수용 조건은 `docs/contracts/product.md`, DDD 구성요소·메서드·통신·배포는 `docs/contracts/architecture.md`가 기준이다. `manifest.json`은 식별자/소유 관계/기능/diagram inventory와 버전을 관리하며, `architecture.html`은 이름 클릭으로 상세 section에 이동하는 생성 보기다. `CONTEXT.md`는 현행/폐기 용어 index, `CONTEXT-MAP.md`는 Context index로 유지하고 계약의 상세를 복제하지 않는다. ticket Spec과 ADR은 변화와 결정 근거다. 모든 정상 workflow 완료는 `sync-contracts`와 `contract_docs` gate를 거친다.
