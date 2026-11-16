# domain-model.md 템플릿

`docs/specs/<plan-set-id>/domain-model.md`는 확정된 `requirements.md`를 전술 설계로 옮기는 plan set 문서다. 다섯 stage가 자기 절만 이어서 채우고, 앞 stage의 절은 다음 stage가 읽기만 한다. 이 문서가 최종 모양의 정본이며 다섯 stage의 GUIDE는 이 템플릿을 링크한다. 사람이 읽는 문서이므로 한국어로 쓰고 ID, JSON 키, 경로, CLI 명령은 원형을 유지한다. 모델 이름은 `CONTEXT.md`의 현행 용어를 쓴다. 클래스 다이어그램은 이 문서에 넣지 않는다.

## 단계별 기입

| stage | 이 문서에서 하는 일 |
|---|---|
| `domain-model` | 문서를 만들고 `## 1. 모델 후보`를 쓴다. 기존 모델 조사, 모델링 깊이, Entity·Value Object·외부 시스템 후보, BIZ·INV·EX의 모델 매핑을 기록한다 |
| `aggregate-design` | `## 2. Aggregate`를 쓴다. Aggregate, 규칙마다 강제하는 행위, Aggregate에 걸친 규칙의 일관성 결정을 기록한다 |
| `domain-service` | `## 3. Domain Service`를 쓴다. 어떤 Entity·Value Object도 자연스럽게 소유하지 못하는 도메인 판단만 둔다 |
| `application-service` | `## 4. Application Service`를 쓴다. 업무마다 호출 순서, transaction 경계, Repository, 외부 효과를 기록한다 |
| `integration-design` | `## 5. 통합 설계`를 쓴다. 컨텍스트 사이의 명령·응답·이벤트와 통신 방식을 기록한다 |

모든 stage가 `## 6. 결정 이력`에 자기 결정을 출처와 함께 덧붙인다. 앞 stage가 채우지 않은 절은 문서에 아직 없다. `stakeholder-analysis`가 `판정: 생략`이면 이 문서를 만들지 않는다.

## 작성 규칙

- ID는 `CON-01`(일관성 결정), `DS-01`(Domain Service), `AS-01`(Application Service), `INT-01`(통합), `DEC-01`(결정 이력)이다. 문서 안에서 번호가 유일하고, 한 번 붙인 ID는 바꾸지 않으며 지운 항목의 번호는 다시 쓰지 않는다. BIZ·INV·EX·AC·HS는 `requirements.md`의 ID를 그대로 쓴다.
- 모든 결정에 출처를 붙인다: `요청 원문`, `CAND-xx 채택`, `answers.json <question_id>`, `INV-xx`·`EX-xx`·`AC-xx`·`BIZ-xx` 같은 요구 ID, `사용자 수정 지시`, `요청 해석(에이전트 제안)`, 기존 모델은 `file:line`과 확인한 commit. 일관성 결정(`CON-xx`)은 에이전트 제안만으로 출처가 될 수 없다. 일관성은 업무 결정이므로 요구에 근거가 없으면 사용자에게 묻고 `answers.json` 출처를 쓴다.
- 모델링 깊이는 서브도메인 분류가 정한다. `core`는 풍부한 모델, `supporting`은 업무 규칙에 필요한 것만, `generic`은 최소 모델이거나 외부 시스템으로 표시하고 만들지 살지는 정하지 않는다.
- Entity는 정체성과 생애주기가 있는 것, Value Object는 값이 의미를 갖는 것이다. 기존 소유자를 확장하는 안을 먼저 보고, 새 모델은 기존 소유자가 담지 못하는 이유를 적는다.
- Aggregate는 함께 지켜야 하는 불변식으로 묶는다. 다른 Aggregate는 ID로만 참조하고 한 transaction은 Aggregate 하나만 바꾼다. BIZ 하나를 Aggregate 하나로 기계적으로 옮기지 않으며 필요 없는 Aggregate를 만들지 않는다. Aggregate가 있으면 Root는 Entity다. 상태와 생애주기가 없는 BC는 Aggregate가 없어도 되며 2.1에 그 이유를 적는다(아래 `Aggregate가 없는 컨텍스트`).
- Aggregate에 걸친 규칙은 즉시 일관성이 필요하면 하나로 병합하고, 최종 일관성을 허용하면 분리하며 어느 쪽이든 `CON-xx`로 출처와 함께 기록한다. Saga·Outbox는 최종 일관성으로 기록한 규칙에서만 검토한다.
- 같은 규칙을 여러 계층에 복제하지 않는다. 규칙은 소유 모델과 그것을 강제하는 행위 하나에 대응한다. 강제하는 행위는 Entity인 Aggregate Root의 메서드, Value Object의 생성 규칙이나 메서드, Domain Service 중 규칙을 자연스럽게 소유하는 쪽이다. 값이 지키는 규칙을 위해 Entity나 Aggregate를 만들지 않는다.
- 기술(프레임워크, 저장소, broker, 프로토콜)은 정하지 않는다. 해당 사항이 없는 절에는 `해당 없음 — 이유`를 적는다.
- 설계 중 새 업무 규칙·예외가 드러나면 이 문서가 아니라 `requirements.md`에 INV·EX·AC로 먼저 덧붙인다. 규칙은 `requirements.md`가 소유하고 이 문서는 그 ID를 모델에 대응시킨다.
- 어떤 stage도 이 문서를 검사하지 않는다. `integration-design`이 `completed`를 반환할 때 실행기가 `harness-domain-model-check.mjs`로 문서 전체의 표를 한 번 읽는다(규칙은 `deepening.md`). 표의 열 이름을 바꾸지 않는다.

## 문서 모양

````markdown
# 도메인 모델

- plan set: `<plan-set-id>`
- requirements: `requirements.md` (같은 디렉터리, `상태: fixed`)

## 1. 모델 후보

### 1.1 기존 모델 조사

기존 모델이 없으면 `기존 모델 없음 — 확인한 문서와 경로`를 적는다. `code-research`는 이 stage만 실행하며 결과를 `file:line`과 확인한 commit과 함께 옮긴다.

| 기존 모델 | BC | 상태 | 근거(`file:line`) | 확인한 commit |
|---|---|---|---|---|
| 게시글 | 커뮤니티 | implemented | `src/community/post.ts:12` | 3f2a9c1 |

### 1.2 모델링 깊이

| BC | SD | 분류 | 모델링 깊이 | 근거 |
|---|---|---|---|---|
| 커뮤니티 | SD-01 | core | 풍부한 모델 | 글의 규칙이 이 요청의 차별점이다 — 출처: requirements.md SD-01 |
| 신고 | SD-02 | supporting | 규칙에 필요한 것만 | 중복 신고 금지(INV-04)만 모델이 필요하다 |
| 인증 | SD-03 | generic | 외부 시스템 | 로그인은 흔한 업무이고 만들지 살지는 정하지 않는다 |

### 1.3 모델

| 모델 | 종류 | BC | 정체성·생애주기 또는 값의 의미 | 현재 상태 | 근거 |
|---|---|---|---|---|---|
| 게시글 | Entity | 커뮤니티 | 게시글 ID로 구분한다. 게시됨에서 삭제됨으로 간다 | implemented | BIZ-01, BIZ-02, INV-02 |
| 본문 | Value Object | 커뮤니티 | 글자 수 상한이 있는 글 내용이다. 같은 내용이면 같은 값이다 | accepted-target | INV-01 |
| 신고 | Entity | 신고 | 신고 ID로 구분한다. 접수됨에서 닫힘으로 간다 | accepted-target | BIZ-03, INV-03, INV-04 |
| 인증 시스템 | 외부 시스템 | 인증 | 로그인과 방문자 판별을 맡는다. 만들지 살지는 미정이다 | accepted-target | BIZ-04, EX-01 |

`종류`는 `Entity`, `Value Object`, `외부 시스템` 중 하나다. `현재 상태`는 확인한 코드가 있는 것만 `implemented`이고 나머지는 `accepted-target`이다.

### 1.4 요구 매핑

모든 BIZ, INV, EX는 소유 모델이 하나 이상 있어야 한다. 이벤트와 용어도 그 컨텍스트의 후보에 연결한다.

| 요구 | BC | 소유 모델 | 근거 |
|---|---|---|---|
| BIZ-01 | 커뮤니티 | 게시글, 본문 | 작성은 게시글과 본문을 만든다 |
| BIZ-02 | 커뮤니티 | 게시글 | 삭제는 게시글 상태를 바꾼다 |
| BIZ-03 | 신고 | 신고 | 신고를 접수한다 |
| BIZ-04 | 인증 | 인증 시스템 | 로그인은 외부 시스템이 맡는다 |
| INV-01 | 커뮤니티 | 본문 | 글자 수는 값이 정한다 |
| INV-02 | 커뮤니티 | 게시글 | 작성자 확인은 게시글의 생애주기 규칙이다 |
| INV-03 | 커뮤니티 | 게시글, 신고 | 삭제가 신고 처리에 영향을 준다 |
| INV-04 | 신고 | 신고 | 같은 회원의 같은 글 신고를 막는다 |
| EX-01 | 인증 | 인증 시스템 | 방문자 판별은 외부 시스템이 한다 |
| 이벤트: 게시글이 삭제됨 | 커뮤니티 | 게시글 | event-storming `## 4` |
| 용어: 게시글 | 커뮤니티 | 게시글 | CONTEXT.md |

## 2. Aggregate

### 2.1 Aggregate

| Aggregate | BC | Root | 정체성 | 구성원 | 주요 행위 | 다른 Aggregate 참조 |
|---|---|---|---|---|---|---|
| 게시글 | 커뮤니티 | 게시글 | 게시글 ID | 게시글, 본문 | `게시글.작성()`, `게시글.삭제()` | 작성자는 회원 ID로만 가진다 |
| 신고 | 신고 | 신고 | 신고 ID | 신고 | `신고.접수()`, `신고.닫기()` | 대상은 게시글 ID로만 가진다 |

### 2.2 규칙 강제

| 요구 | Aggregate | 강제 행위 | 일관성 범위 |
|---|---|---|---|
| INV-01 | 게시글 | `게시글.작성()` | Aggregate 안 |
| INV-02 | 게시글 | `게시글.삭제()` | Aggregate 안 |
| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | CON-01 |
| INV-04 | 신고 | Domain Service | Aggregate 안 |
| EX-01 | - | 외부 시스템: 인증 시스템 | Aggregate 안 |

`강제 행위`는 그 Aggregate의 `주요 행위`에 적힌 root 메서드, 소유 모델이 Value Object일 때 `Value Object: <모델>` 또는 `Value Object: <모델>.<행위>()`, `Domain Service`(뒤 stage가 채운다), 또는 소유 모델이 외부 시스템일 때 `외부 시스템: <모델>`이다. Value Object가 Aggregate 구성원이면 `Aggregate` 칸에 그 Aggregate를 적고, 어느 Aggregate에도 속하지 않으면 `-`를 적는다. 둘 이상의 Aggregate에 걸친 규칙은 `일관성 범위`에 `CON-xx`를 적는다.

### 2.3 일관성 결정

| CON | 규칙 | 걸친 Aggregate | 일관성 | 결정 | 근거·출처 |
|---|---|---|---|---|---|
| CON-01 | INV-03 | 게시글, 신고 | 최종 | 분리: 게시글이 삭제된 뒤 신고를 닫는다. 삭제는 신고가 닫히기를 기다리지 않는다 | answers.json `<question_id>` |

`일관성`은 `즉시`나 `최종`이다. `즉시`는 `결정`에 `병합`을 쓰고 `걸친 Aggregate`에 합친 Aggregate 하나만 적는다. `최종`은 둘 이상의 Aggregate를 적고 분리를 뜻한다. 각 선택이 업무에 미치는 결과를 `결정`에 적는다.

## 3. Domain Service

| DS | 이름 | BC | 책임 | 사용 모델 | 강제 규칙 | 행위 | 자연 소유자가 없는 이유 |
|---|---|---|---|---|---|---|---|
| DS-01 | 중복 신고 판정 | 신고 | 같은 회원이 같은 게시글을 이미 신고했는지 판정한다 | 신고 | INV-04 | `중복 신고 판정.판정()` | 신고 하나는 다른 신고의 이력을 알지 못한다 |

Domain Service는 `2.2`에서 `Domain Service`로 넘긴 규칙만 맡고 조율·transaction·저장·외부 효과는 하지 않는다. 없으면 `해당 없음 — 이유`를 적는다.

## 4. Application Service

| AS | 이름 | BC | 업무 | 호출 순서 | 트랜잭션 경계 | Repository | 외부 효과 |
|---|---|---|---|---|---|---|---|
| AS-01 | 게시글 작성 | 커뮤니티 | BIZ-01 | 방문자 확인(인증 시스템) → `게시글.작성()` → 저장 | T1: 게시글 | 게시글 | 없음 |
| AS-02 | 게시글 삭제 | 커뮤니티 | BIZ-02 | `게시글.삭제()` → 저장 → 게시글이 삭제됨 발행 | T1: 게시글 | 게시글 | 게시글이 삭제됨 이벤트 |
| AS-03 | 삭제된 글의 신고 닫기 | 신고 | BIZ-02 | 게시글이 삭제됨 수신 → `신고.닫기()` → 저장 | T2: 신고 (CON-01) | 신고 | 없음 |
| AS-04 | 신고 접수 | 신고 | BIZ-03 | `중복 신고 판정.판정()` → `신고.접수()` → 저장 | T1: 신고 | 신고 | 없음 |

`트랜잭션 경계`는 `T1: 게시글; T2: 신고 (CON-01)`처럼 transaction마다 Aggregate 하나만 적고 최종 일관성으로 나눈 경계에는 그 `CON-xx`를 붙인다. 조회만 하거나 Aggregate를 바꾸지 않으면(Aggregate가 없는 BC 포함) `없음 — 이유`를 적는다. 외부 시스템만 쓰는 업무는 이 표에 없어도 된다.

## 5. 통합 설계

| INT | 상류 BC | 하류 BC | 명령 | 응답 | 이벤트 | 통신 방식 | 일관성 결정 | Saga·Outbox | 근거·출처 |
|---|---|---|---|---|---|---|---|---|---|
| INT-01 | 커뮤니티 | 신고 | 없음 | 없음 | 게시글이 삭제됨 | 비동기 이벤트 | CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 | CONTEXT-MAP.md `## 3` 커뮤니티 → 신고, answers.json `<question_id>` |

`통신 방식`은 업무가 요구하는 동기·비동기 성격이다. broker·프로토콜·프레임워크는 정하지 않는다. `Saga·Outbox`는 `최종`으로 기록한 `CON-xx`가 있는 행에서만 선택하고 선택하지 않으면 `없음 — 이유`를 적는다.

## 6. 결정 이력

| DEC | stage | 대상 | 결정 | 비교한 대안 | 출처 |
|---|---|---|---|---|---|
| DEC-01 | domain-model | 게시글 | 기존 게시글 모델을 확장한다 | 새 게시물 모델 | `src/community/post.ts:12`, BIZ-01 |
| DEC-02 | aggregate-design | CON-01 | 게시글과 신고를 분리하고 최종 일관성을 쓴다 | 하나로 병합 | answers.json `<question_id>` |
| DEC-03 | domain-service | DS-01 | 중복 신고 판정을 Domain Service로 둔다 | 신고 Aggregate에 이력 보관 | INV-04 |
| DEC-04 | application-service | AS-03 | 신고 닫기를 별도 transaction으로 둔다 | 삭제와 같은 transaction | CON-01 |
| DEC-05 | integration-design | INT-01 | 이벤트로 전달한다 | 동기 호출 | answers.json `<question_id>`, CONTEXT-MAP.md `## 3` |
````

## Aggregate가 없는 컨텍스트

상태와 생애주기가 없는 BC는 Aggregate를 만들지 않는다. 예를 들어 계산 요청과 결과를 값(Value Object)으로만 다루는 계산기에는 지킬 상태가 없고, 규칙(지원하는 연산, 0으로 나누기)은 값이 만들어질 때 값이 강제한다. Root가 될 Entity를 만들어 내지 않는다. 이 BC는 2.1의 Aggregate 표 뒤에 `BC`와 `Aggregate 없음 사유` 표로 이유를 적고, 2.2의 `강제 행위`에 Value Object를 적는다. 이유를 적지 않은 BC는 gate가 거부한다. 외부 시스템만 있는 BC는 적지 않아도 된다. 문서 전체에 Aggregate가 하나도 없으면 2.1에 `해당 없음 — 이유`를 적어도 된다. Aggregate가 하나라도 있으면 Root는 Entity이고 모든 Entity는 Aggregate 하나에 속한다.

````markdown
### 2.1 Aggregate

| Aggregate | BC | Root | 정체성 | 구성원 | 주요 행위 | 다른 Aggregate 참조 |
|---|---|---|---|---|---|---|

| BC | Aggregate 없음 사유 |
|---|---|
| 계산기 | 상태와 생애주기가 없다. 계산 요청과 결과는 값으로만 존재한다 |

### 2.2 규칙 강제

| 요구 | Aggregate | 강제 행위 | 일관성 범위 |
|---|---|---|---|
| INV-01 | - | Value Object: 계산 요청.생성() | 값 안 |
| EX-02 | - | Value Object: 계산 요청.생성() | 값 안 |
````

## 프로젝트 문서 `docs/architecture/domain-model.md`

프로젝트가 소유하는 현재 모델 기준 문서다. 이 plan set의 승인 target을 반영하되 영향받는 모델 행만 갱신하고 다른 행은 그대로 둔다. Git에 노출되는 프로젝트 문서이며 Harness 설치 산출물이 아니다.

| Context / 모델 ID | 상태 | Root / 소유 코드 | 규칙 ID → enforcement | 데이터 / transaction | 공개 계약 / 통신 | deployment / extraction trigger | 근거 |
|---|---|---|---|---|---|---|---|

- 한 행은 Entity 하나(Aggregate Root이거나 구성원) 또는 외부 시스템 하나다. Value Object는 그것을 쓰는 Entity 행의 `Root / 소유 코드` 칸에 `VO: 이름`으로 적는다. 쓰는 Entity가 없는 Value Object(Aggregate가 없는 BC)는 자기 행을 가지며 `Root / 소유 코드`에 `VO`를 적는다. `Context / 모델 ID`는 `<BC> / <모델>` 형식이다.
- `상태`는 `implemented`와 `accepted-target`을 구분한다. 확인한 코드가 있는 행만 `implemented`이며 설계 승인만으로 `implemented`로 쓰지 않는다. 구현 완료는 이 stage들이 아니라 구현 뒤 `sync-contracts`가 반영한다.
- 열은 stage가 나눠 채운다. `domain-model`은 `상태`, `Root / 소유 코드`(기존 `file:line`이나 `미정`)와 `근거`를, `aggregate-design`은 `Root / 소유 코드`와 `규칙 ID → enforcement`, `데이터 / transaction`의 Aggregate 경계를, `domain-service`는 Domain Service가 맡은 `규칙 ID → enforcement`를, `application-service`는 `데이터 / transaction`의 transaction·Repository를, `integration-design`은 `공개 계약 / 통신`을 채운다. `deployment / extraction trigger`는 이 stage들이 정하지 않으며 기존 값을 그대로 둔다.
- `근거`에는 `docs/specs/<plan-set-id>/domain-model.md`의 해당 절을 연결한다. 모델 문서에 표가 없으면 이 표를 새 절로 더하고 기존 본문은 지우지 않는다. 같은 행을 다른 plan set이 고치고 있으면 상대의 변경을 덮어쓰지 않는다.
