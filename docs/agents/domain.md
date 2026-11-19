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
- 대체 구현의 범위에 소비자 이전과 구형 코드·경로·export·config·fixture 정리를 포함한다.
- 설계자는 기존 glossary와 바뀐 개념의 의미·책임·identity·lifecycle을 비교해 정의 보정·rename·분리/통합·폐기 필요를 먼저 제안한다. 확정된 모델의 용어 변경은 함께 반영하고, 의미가 미확정이면 해당 설계 topic에서 해결한다. 사용자의 명시적인 용어 변경 요청을 선행 조건으로 삼지 않는다.
- 경계는 `CONTEXT-MAP.md`를 본다.
- 중요한 결정은 `docs/adr/`에 기록한다.
- 새 설계 전에 기존 모델과 연결된 source/ADR/다이어그램을 확인한다. 문서가 없으면 관련 코드에서 복원하고, 기능 이름으로 Aggregate/Context/module/server를 만들지 않는다.
- 작은 기능은 기존 규칙 소유자를 확장할 수 있는지부터 검토한다.
- 설계 완료에는 승인 target, 구현 완료에는 실제 코드·검증·commit을 반영한다. 기존 implemented 상태를 미래 설계로 덮어쓰지 않는다. 모델 문서는 작업 상태 보드가 아니다.
- `docs/architecture/principles.md`는 해석 원칙이다. ADR 대체물이 아니다.

## ADR 기준

- 결정이 오래 남을 가치가 있으면 ADR로 남긴다.
- 임시 판단이면 계획이나 issue에만 둔다.
- 같은 결정을 여러 문서에 중복 정의하지 않는다.

## 현행 통합 계약

대상 프로젝트의 전체 기능·규칙·수용 조건은 `docs/contracts/product.md`, DDD 구성요소·메서드·통신·배포는 `docs/contracts/architecture.md`가 기준이다. `manifest.json`은 식별자/소유 관계/기능/diagram inventory와 버전을 관리하며, `architecture.html`은 이름 클릭으로 상세 section에 이동하는 생성 보기다. `CONTEXT.md`는 현행/폐기 용어 index, `CONTEXT-MAP.md`는 Context index로 유지하고 계약의 상세를 복제하지 않는다. ticket Spec과 ADR은 변화와 결정 근거다. 모든 정상 workflow 완료는 `sync-contracts`와 `contract_docs` gate를 거친다.

## 공통 도메인 정의

공통 정의는 프로젝트 소유 파일이다. 전역 Actor와 Subdomain은 각각
`docs/domain/actors/`, `docs/domain/subdomains/`에 두고, Context 소유 정의는
`docs/domain/contexts/<context-id>/<종류 디렉터리>/<id>.md`에 둔다.
기존 Stakeholder 카드는 현재 형식을 유지한다.

공통 정의에 사용할 Context에는 `CONTEXT-MAP.md`의 `Bounded Context` 표에
`Context ID` 열을 추가해 안정적인 소문자 slug를 부여한다. 이름을 바꿀 때도 ID는
유지한다. 기존 표는 해당 열 없이도 읽을 수 있다.

정의 파일은 `---`로 둘러싼 Frontmatter와 Markdown 본문으로 구성한다.
버전 1에서는 필드마다 한 줄을 사용하고 값은 JSON으로 표현한다. 문자열은 큰따옴표,
목록은 JSON 배열을 사용한다. 예를 들어 `schema_version: 1`,
`name: "주문 취소 조건"`, `aliases: ["취소 조건"]`과 같다.
공통 키와 종류별 필드의 목록은 `.harness/src/domain/schema.mjs`에 있다.
Actor와 Subdomain의 ID는 각각 `actor.<slug>`, `subdomain.<slug>`이고,
Context 소유 ID는 `<context>.<kind>.<slug>`다.
`implemented`에는 구현 근거 참조를, `retired`에는 폐기 근거 및 해당되는 대체 ID를 기록한다.

현재 저장소에서 `node .codex/scripts/harness-domain.mjs validate`로 파일 구조,
Context 소유권과 정의 사이의 참조를 검사한다. `source_refs`와 `implementation_refs`는
이 단계에서 목록 형식만 검사하며, 근거의 실제 충족 여부는 이후 동기화·구현 검증이 판단한다.

### 검색과 인덱스

- `node .codex/scripts/harness-domain.mjs discover '주문 취소'`는 관련 후보, Context, Subdomain과 연결 항목을 반환한다.
- `node .codex/scripts/harness-domain.mjs search '취소' --context order --kind rule`로 범위를 제한한다. 기본은 현행 정의 5건이며 `--status retired` 또는 `--status all`로 과거 정의도 조회할 수 있다.
- `node .codex/scripts/harness-domain.mjs get order.rule.cancel-eligibility`는 원문을 반환하며 ID를 여러 개 넘길 수 있다.
- `node .codex/scripts/harness-domain.mjs index`로 탐색용 Markdown을 갱신하고 `index --check`로 정합성을 확인한다. 생성된 INDEX.md는 Git으로 관리한다.

검색 인덱스와 Stage별 Context Pack은 Worktree의 `.io/runtime/domain/`에 둔다.
실행 입력의 `domain_context_pack`은 후보와 버전을 제공한다. 요청·답변·피드백이나 정본 내용이 바뀌면
새 버전으로 다시 계산하고, 의미가 동일한 정의인지 여부는 Stage가 원문 근거를 확인해 판단한다.

### 확정 변경과 마이그레이션

`node .codex/scripts/harness-domain.mjs bootstrap`은 이전에 확정된 요구사항에서 공통화 후보와 출처를 찾는다. 원본을 수정하지 않는다. 업무적 의미와 구현 근거는 검토자가 확인한다.

`sync plan <plan-set-id> <proposal-path>`는 변경 예정 경로, 기존 값과 정본 버전을 반환한다. 제안 JSON에는 `schema_version: 1`, 로컬 ID를 공통 ID로 연결하는 전체 `links`, `changes` 배열을 적는다. 변경에는 `operation`, `id`, `reason`, `document: {metadata, body}`를 적는다. 기존 정의를 재사용할 때는 `reuse`와 ID만 적을 수 있다. 새 정의는 `accepted-target`으로 시작한다. 소유권 이전은 `relocate`로 이전 ID를 폐기하고 다른 Context에 대체 ID를 생성한다.

확정 Stage에서는 생성한 계획을 실행 폴더의 `domain-sync.json`에 저장한다. 기존 Stage 완료 CLI가 변경과 인덱스를 검증하고 Stage 커밋에 반영한다. 마이그레이션과 수동 구현 상태 반영은 검토한 계획을 `sync apply <plan-path>`로 적용한다. 구현 상태를 올릴 때는 `implement` 작업에 해당 업무 ID, 완료된 ticket, 검증에 사용한 테스트 경로를 `evidence: {local_id, ticket, tests}`로 적는다. 실행기는 완료된 ticket 커밋, 테스트 경로와 정의의 버전을 대조한다.

### PR 검사

`merge-check --base <최신 대상 ref> --head <기능 ref>`는 Git의 병합 후보를 검사한다. 실제 테스트 병합 커밋이 있으면 `--merged <ref>`를 넘긴다. 생성 인덱스에 충돌이 있으면 정본을 조정한 뒤 `index`로 재생성한다.

독립 검토자는 적용 조건, 업무 결과, 소비 Policy 및 기존 참조에 미치는 영향을 확인한다. 로컬 검토 기록은 `--review <path>`로 넘기고 `{base,head,verdict:"pass",evidence}`에 정확한 커밋과 근거를 적는다. GitHub CI는 파일 대신 PR의 해당 head에 대한 저장소 구성원의 승인을 사용한다. Merge Queue에서는 PR 승인을 required check로 먼저 적용하고 Queue의 임시 병합 결과를 구조 검증한다. 대상과 head가 바뀌면 다시 검토한다.

소비자는 자신의 CI 설정에서 검토한 Harness 리비전을 별도 경로에 준비하고, 소비자 저장소를 현재 디렉터리로 둔 채 그 리비전의 `.codex/scripts/harness-domain.mjs`를 실행한다. Git에 포함되지 않는 로컬 Harness 설치본은 CI 입력으로 사용하지 않는다. 실제 병합 차단은 소비자의 branch protection 또는 ruleset에서 `domain-merge`를 필수화해야 동작한다.

### 검색 평가

`benchmark <dataset>`은 `[{query, expected:[<공통 ID>...]}]` 형식의 사례로 Recall@5,
검색 지연과 조회 호출 수를 계산한다. 실제 Workflow의 모델 토큰과 재사용률은 같은 사용자
요청·자료·모델로 변경 전후 실행의 도구 호출과 Stage 결과를 각각 기록해 비교한다.
