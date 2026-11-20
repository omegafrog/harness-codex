# tactical-design.md 템플릿

확정된 `requirements.md`를 바운디드 컨텍스트별 설계로 옮긴다. `requirements.md`와 `CONTEXT-MAP.md`의 동일한 Context ID와 소유권을 따른다. BC 셀이 `community (커뮤니티)`이면 제목은 `## BC community`다. BC 셀에 표시 이름만 있는 기존 요구사항은 Context Map의 확정 ID에 연결한다. 본문은 한국어로 작성하고 ID, 타입, 메서드와 경로의 식별자는 원형을 유지한다. 아래 marker와 표의 열 이름은 실행기의 검증 계약이다.

| stage | 각 BC에서 채우는 내용 |
|---|---|
| `domain-model` | 기존 모델 근거와 모델링 깊이, Entity·Value Object·외부 시스템 선언 및 메서드 계약 |
| `aggregate-design` | Aggregate 구조, Entity·Value Object·외부 시스템의 규칙 책임, 클래스 다이어그램 |
| `domain-service` | 자연스럽게 소유할 Entity·Value Object가 없는 도메인 판단의 모델 및 규칙 책임 |
| `application-service` | 각 업무의 Application Service 메서드와 호출 순서, 트랜잭션, 사용 인터페이스 |
| `integration-design`, `context-boundary` | 호출과 포트의 정합성을 검토하고 수정이 필요한 경우 소유 stage로 돌려보낸다 |

## 문서 모양

```markdown
# 전술 설계

<!-- tactical-design: context-components-v1 -->

- 요구사항 [requirements.md](requirements.md)
- plan set `<plan-set-id>`

## BC community

### 도메인 모델

BIZ-01은 기존 게시글 모델을 확장한다. 기존 코드 근거는 `src/community/post.ts:12`와 확인한 commit에 연결한다.

| 모델 | 종류 | 업무 | 식별자 | 필드·구성 값 | 메서드 |
|---|---|---|---|---|---|
| Post | Entity | BIZ-01 | postId | postId: PostId — 게시글 식별자<br>body: PostBody — 글 본문 | create(postId: PostId, body: PostBody) → Post — 작성된 상태의 게시글을 만든다 |
| PostBody | Value Object | BIZ-01 | 해당 없음 — 값으로 비교 | text: String — 본문. 비어 있을 수 없음(INV-01) | from(text: String) → PostBody — 빈 본문을 거절한다(INV-01) |

### Aggregate

| Aggregate | Root | 구성원 | 다른 Aggregate 참조 |
|---|---|---|---|
| Post | Post | Post, PostBody | 없음 — BIZ-01에 연관 Aggregate 없음 |

클래스 다이어그램 [PlantUML](diagrams/community.class.puml) · [SVG](diagrams/community.class.svg)

### 규칙 책임

| 소유 모델 | 규칙 | 근거 | 담당 메서드 |
|---|---|---|---|
| PostBody | INV-01 본문이 비어 있으면 게시글을 작성할 수 없다 | [BIZ-01, INV-01, AC-01](requirements.md#biz-01) | PostBody.from |

### Application Service

| AS | 메서드 | 업무 | 호출 순서 | 트랜잭션 경계 | 사용 인터페이스 |
|---|---|---|---|---|---|
| AS-01 | PostApplicationService.create(input: CreatePost) → PostId | BIZ-01 | 1. PostBody.from(input.text). INV-01이면 거절 결과 반환<br>2. Post.create(input.postId, body)<br>3. PostRepository.save(post). 저장 실패는 저장 실패 결과로 반환<br>4. post.postId를 반환 | T1: Post — 시작 3단계 저장 직전 / 커밋 저장 성공 직후·4단계 전 / 롤백 저장 오류 시 | PostRepository |

### 사용 인터페이스

| 인터페이스 | 시그니처 | 소유 위치 | 사용 메서드 | 실패 계약 |
|---|---|---|---|---|
| PostRepository | save(post: Post) → void | community 도메인 Repository 포트 | AS-01 PostApplicationService.create | 저장 오류가 발생하면 T1 롤백 후 저장 실패를 반환한다 |
```

## 작성 기준

- 확정된 각 BC를 `## BC <context-id>`로 한 번만 쓴다. 식별자는 확정된 소문자 slug를 사용한다. 제목 아래 구성은 실제 설계에 필요한 것만 둔다. 해당 구성이나 클래스 모델이 없으면 이유를 적는다.
- Entity는 식별자 이름과 타입, 정체성과 생애주기, 업무 상태를 표현하는 필드를 둔다. `식별자`는 필드에 선언한 이름이다. 필드 표기는 `필드: 타입 — 뜻`이고 여러 선언은 `<br>`로 잇는다. 각 메서드에 이름, 타입이 있는 입력, 결과 및 상태 변화·실패 효과를 적는다.
- Value Object는 ID 대신 값의 의미, 구성 속성·타입·제약, 포함하는 Entity 또는 다른 Value Object를 식별한다. 제약을 강제하는 생성·변환 메서드를 명시한다. Domain Service는 모델 표에 `Domain Service`로 기입하고 상태가 없을 때만 필드 사유를 표시한다. 외부 소유 규칙은 모델 종류를 `외부 시스템`으로 쓰고 실제 공개 메서드나 계약을 선언한다. `업무`는 모델이 책임지는 BIZ를 적는다. BIZ 전체를 외부 시스템이 담당할 때만 그 외부 모델의 BIZ 행으로 Application Service를 대신한다.
- Aggregate는 Root, Entity·Value Object 멤버, 다른 Aggregate의 식별자 참조를 적는다. 클래스 다이어그램에서 Aggregate 경계와 내부 구성, 멤버의 타입과 메서드, 다른 Aggregate를 참조하는 ID와 방향을 나타낸다. 실제 Aggregate 구조가 없는 BC는 이유 한 줄로 설명한다.
- 규칙 책임 표의 각 INV·EX에는 실제 규칙 내용, 요구사항·승인 답변 위치, 소유자 하나와 그 모델에 선언된 담당 메서드 하나를 연결한다. 기록 전에 규칙의 발동 조건, 지켜야 할 불변식·예외, 관찰 가능한 결과를 원문과 맞춘다. 필요한 정보가 없거나 상충하면 [소유 stage 반환 규칙](deepening.md)을 따른다.
- Application Service 행마다 업무 ID, 입력·결과 타입, 분기·실패 처리와 실제 호출 순서를 기록한다. 트랜잭션마다 수정하는 Aggregate 하나와 시작·커밋·롤백 시점을 실행 단계에 연결한다. 트랜잭션이 여러 개면 각 `T<number>: <Aggregate> — 시작 … / 커밋 … / 롤백 …`을 `<br>`로 나눈다. 트랜잭션이 없다면 `없음 — <이유>`를 기록한다. Application Service는 모델의 업무 판단을 호출하고 호출 결과와 외부 효과를 조율한다.
- 필요한 포트는 `사용 인터페이스`에서 쉼표로 구분한 이름으로 참조한다. 인터페이스 표 각 행에는 동일한 이름, 시그니처, 실제 소유 위치, 사용하는 AS ID, 실패 계약을 둔다. 같은 BC의 모델 직접 호출은 호출 순서에 적는다. 사용 인터페이스가 없다면 `없음 — <이유>`를 적는다.
- Cross-BC 호출은 관련 AS 행과 사용 포트의 시그니처·실패 계약에 작성한다. 동기라면 호출 대상, 요청·응답, 대기·오류 결과를 적는다. 비동기라면 발행·수신 메서드, 메시지 계약, 발행 시점과 전달 실패·재시도·중복 처리의 근거를 적는다. 데이터와 내부 타입은 소유 BC 안에 둔다.
- 업무의 일관성이나 경계 선택이 후속 변경에도 적용되는 결정이면 `docs/adr/<decision>.md`에 근거와 결과를 쓰고 해당 BC 요소에서 링크한다. 설계 상세와 현행 코드 근거는 해당 BC 절에 기록한다.

## 구형 문서

marker 없이 이미 작성된 번호형 문서는 [기존 템플릿](legacy-template.md)으로 이어간다. `domain-model`은 직접 받은 수정 피드백이나 `input_refs`의 `upstream_user_revision`이 가리키는 사용자 수정 원문에서 형식 이동 지시를 확인한다. 지시가 있으면 기존 문서의 ID·행동·승인 근거를 보존하며 BC별 구성으로 제자리 이동한다. 기존 결정 중 후속 작업이 참조할 것은 ADR로 옮겨 현행 요소에서 링크한다. 이후 stage는 자기 요소의 근거와 계약을 확인하고, 빠진 사실을 소유 stage로 돌린다.
