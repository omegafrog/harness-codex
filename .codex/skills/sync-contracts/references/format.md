# 통합 계약 형식

기본 경로는 `docs/contracts/`이며 프로젝트마다 한 묶음을 유지한다.

| 파일 | 역할 |
|---|---|
| `product.md` | 전체 Product 계약: 기능 ID·상태·수정일·설명·비즈니스 규칙·수용 조건, 기존 기능과 승인된 변경 구분 |
| `architecture.md` | 아래 구성요소별 상세, 규칙과 기능 ID·source·검증 연결 |
| `manifest.json` | stable ID·종류·owner·기능 연결·source 범위·diagram 목록·버전·검토 receipt. 설명 본문은 중복 저장하지 않음 |
| `diagrams/*.puml`, `*.svg` | 편집 원본과 로컬 렌더 결과 |
| `architecture.html` | DDD SVG와 architecture 상세를 묶은 생성 보기 |

## 섹션

Product 기능과 Architecture 구성요소는 다음처럼 명시적인 stable anchor와 이름·날짜를 사용한다. 이름을 바꿔도 ID는 의미적 동일성이 유지되는 한 보존한다. 분할/병합은 새 ID와 대체 관계를 기록한다.

```markdown
<a id="order"></a>
## Order
수정일: 2026-10-16

### 설명
주문 금액과 취소 가능 여부를 소유한다. 구현 상태와 source/검증 링크를 명시한다.
```

각 `###` 필드는 빈 제목이 아니라 실제 설명을 가져야 한다.

| `kind` | 필수 필드 (`설명`·수정일은 공통) |
|---|---|
| `external-system` | `인터페이스`: 이름·방향·설명, `외부 명세`: 해당 API의 HTTPS 명세 링크 |
| `bounded-context` | `커뮤니케이션`: 상대 Context·sync/async·공개 계약·일관성/실패/재시도 근거; `내부 구성요소`: 각 하위 section 링크; `배포`: 현재 배포 단위·분리 조건·근거 |
| `aggregate` | `기능`: Product 기능 링크; `구성요소`: root·entity·VO section 링크; `불변식`: transaction 경계와 rule ID |
| `aggregate-root`, `entity` | `속성`: 이름·타입·설명 표; `메서드`: 메서드별 비즈니스 책임·입력·결과·불변식·section 링크 |
| `value-object` | `속성`: 이름·타입·설명 표; `불변식`: 값의 동등성과 검증 |
| `domain-service` | `속성`: 이름·타입·설명 표(무상태면 그 사실을 명시); `메서드`와 `비즈니스 규칙`: 단일 entity에 둘 수 없는 이유·읽기/변경 대상·소유 rule ID |
| `domain-method` | `비즈니스 규칙`: rule ID·pre/postcondition·오류·source·검증 |
| `composition-service` | `필요 엔티티`: 입력/조회/변경 대상; `동작`: 호출 순서·실패 처리·transaction 경계; `메서드`: 각 메서드 section 링크 |
| `composition-method` | `필요 엔티티`·`동작`: 조립 책임과 실제 호출 경로. 비즈니스 판단을 복제하지 않음 |

메서드는 owner의 하위 구성요소로 stable ID를 부여하여 DDD 그림에도 **메서드 이름만** 표시한다. 도메인 객체가 없는 함수형 모델은 현재 책임을 문서화하며 Aggregate를 꾸며내지 않는다.

## manifest

```json
{
  "schema_version": 1,
  "revision": 0,
  "updated_at": "2026-10-16",
  "change_summary": "초기 통합",
  "source_roots": ["src", "package.json"],
  "features": [{"id":"cancel-order","name":"주문 취소","updated_at":"2026-10-16","status":"implemented"}],
  "components": [{"id":"orders","name":"Orders","kind":"bounded-context","updated_at":"2026-10-16","features":["cancel-order"],"sources":["src/orders"]}],
  "diagrams": [
    {"kind":"ddd","source":"docs/contracts/diagrams/ddd.puml"},
    {"kind":"class","source":"docs/contracts/diagrams/domain.class.puml"},
    {"kind":"sequence","feature":"cancel-order","source":"docs/contracts/diagrams/cancel-order.sequence.puml"},
    {"kind":"state","feature":"cancel-order","source":"docs/contracts/diagrams/order.state.puml"}
  ]
}
```

`components`는 실제 전체 모델을 채운다. `owner`는 Context/aggregate/service/entity의 ID이며 aggregate는 정확히 하나의 `aggregate-root`를 가진다. `features`는 실제 소유 기능을 연결한다. 이 JSON은 형식 예시이며 빈 모델을 초기 완료로 승인하지 않는다.

`source_roots`는 설치 대상 프로젝트의 전체 production source·설정·진입점을 포함해야 한다. source snapshot은 Git 관리 파일과 ignore되지 않은 신규 파일을 포함하고 삭제도 감지한다. 런타임 산출물·의존성 cache는 넣지 않는다. `CONTEXT.md`·`CONTEXT-MAP.md`와 `docs/specs/`·`docs/plans/`도 자동 포함한다. ticket Spec/plan만 바뀌어도 통합 계약 검토를 요구하며 새 local checkpoint/완료 receipt는 project source 밖 session_directory에 둔다. 과거 `docs/plans/.runtime/`는 snapshot에서 제외하지만 새 출력을 쓰지 않는다. CI에서 제외 범위 축소와 모델 누락을 reviewer가 확인한다.

`hashes`, `revision`, `updated_at`, `change_summary`, `no_contract_change`는 seal이 관리한다. 최초에는 `architecture.html` 빈 파일을 만들고 seal로 생성한다. 새 날짜는 실제 수정한 section에만 쓴다. 후속 PR은 base revision보다 커야 한다. 변경 없는 workflow는 기존 revision을 검증하며 날짜를 churn하지 않는다.

DDD 노드 예: `rectangle "[[../architecture.md#order Order]]" as order`. owner package 안에 하위를 중첩하고 이름만 표시한다. 클래스 그림은 속성·타입·메서드·관계를, sequence는 기능의 정상/실패 호출을, state는 의미 있는 상태·전이 조건을 보여준다. canonical 원본은 include 없이 독립 렌더한다. renderer가 SVG에 원본 SHA를 기록하며 `check`가 비교한다.

경계를 감싸는 package는 `package "Orders" as orders [[../architecture.md#orders]] { ... }`처럼 **package URL 문법**을 사용한다. package 표시명 안의 `[[URL 이름]]`은 일반 텍스트가 될 수 있으므로 사용하지 않는다. 렌더 후 각 이름의 실제 `<a href>`를 검사하며 URL 문자열이나 bracket label의 존재만으로 클릭 성공을 판정하지 않는다.

실행 전제가 바뀌면 프로젝트 소유 `docs/agents/execution.json`과 EXEC의 profile·인자·설정 갱신/검증·인프라 readiness를 source/CI와 대조하고 source_roots에 공유 실행 계약을 포함한다. 비밀 환경값 자체를 공개 계약에 복사하지 않는다.
