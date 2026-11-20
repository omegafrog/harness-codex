# Ticket 분할

`to-ticket`의 initial phase가 완료된 전술 설계와 구현 결정을 bounded context·업무(BIZ) 단위의 vertical ticket으로 나누고 review 입력을 만든다. ticket 한 개가 `tactical-code`의 실행 한 번이다.

## 입력과 분석

1. `context.worktree_ref`가 가리키는 정본 `worktree.json`에서 `workspace`, `session_directory`, `branch`, `head`, `return_root`, `plan_set_id`를 읽는다. `plan_set_id`가 없으면 중단한다. Tracker ticket ID와 같을 필요는 없다. `workspace`를 작업 위치로 사용한다. 진입 시 `node .harness/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --defer-tracker-sync --json`을 실행해 `valid: true`, `cwd`, `git_root`, `worktree_registered`를 확인한다.
2. `input_refs`가 준 경로를 직접 연다. 정본 위치는 아래 표의 `<plan-set-id>`에 `context.plan_set_id`를 대입하면 된다. 경로를 확인하기 위해 와일드카드, `rg --files`, 디렉터리 목록을 사용하지 않는다. 다른 계획 세트의 문서를 근거로 사용하지 않는다.

   | 문서 | 쓰임 |
   |---|---|
   | `docs/specs/<plan-set-id>/requirements.md` | BIZ·INV·EX·AC. 규칙의 정본이며 ticket은 규칙을 더하거나 조이지 않는다 |
   | `docs/specs/<plan-set-id>/tactical-design.md` | 범위 내 BIZ가 참조하는 컨텍스트, Aggregate·규칙 강제 위치, Application Service 메서드·트랜잭션, outbound 인터페이스·통합·경계 결정을 확인한다 |
   | `CONTEXT.md`, `CONTEXT-MAP.md` | 용어, 컨텍스트와 관계 방향 |
   | `docs/implementation/<plan-set-id>/technology.md`, `api.md`, `data.md` | 기술·API·데이터 및 인터페이스 바인딩. ticket이 의존하는 결정이다 |
   | `input_refs`의 `frontend_design_brief` artifact | UI가 적용될 때 독립 frontend workflow가 확정한 design이다. 참조가 없으면 brief를 찾지 않는다 |

   `requirements.md`에서 범위 내 BIZ와 각 INV·EX·AC를 먼저 식별하고, 전술 설계는 그 BIZ와 연결된 절·표만 읽는다. 경계·의존 순서에 근거가 필요하면 해당 호출이나 참조의 반대편 절과 링크를 따라간다. 기존 번호별 형식도 해당 절·표를 사용한다. 요청 원문은 입력의 `scope`에서 확인하고, 프로젝트 계약이나 다이어그램은 적용할 판단의 정확한 참조가 있을 때 연다. `stakeholder-analysis`가 `판정: 생략`이라 두 문서가 없으면 요청 원문, 결정 문서와 현재 코드(`code-research`)로 나누되 규칙을 새로 정하지 않는다. 필수 입력이 없거나 문서의 빈칸·모순 때문에 분할을 정할 수 없으면 `blocked/INPUT_MISSING`과 `DESIGN_NOT_FROZEN:`으로 시작하는 summary(정본 경로·항목·요구 ID)를 반환한다. `owner_stage`·`dependency_gap`은 `null`이다.
3. 활성 workspace의 `<workspace_root>/.codex/context-budget.json`에서 `max_plan_tokens`를 읽는다. 로딩·구현·업무 규칙 단위 테스트·수정 근거를 포함해 각 ticket 예상 토큰과 산정 근거를 기록하고, 각 ticket이 한도 안에 들도록 나눈다.

## 분할 기준

첫 구현 ticket에 Git 제외 규칙 점검을 선행 작업으로 넣고 나머지 구현 ticket이 이 작업에 의존하게 한다. `technology.md`가 정한 언어·도구·인프라와 실제 저장소의 ignore 규칙을 확인해 캐시, 빌드 산출물, 로컬 환경·비밀 파일 등 해당 프로젝트에서 생성되는 비추적 대상을 식별하고 필요한 `.gitignore`를 수정한다. 소스, 테스트, 예제 설정과 공유해야 할 설정은 추적 대상으로 보존한다. `git check-ignore`로 제외 대상과 보존 대상의 대표 경로를 확인하고, 이미 추적된 파일은 ignore만으로 제거되지 않으므로 삭제하거나 추적 해제하지 말고 별도로 보고한다. 규칙이 이미 충분하면 점검 결과를 기록하고 불필요한 변경은 하지 않는다. 이 작업은 제품 동작을 추가하는 요구가 아니라 구현 환경의 공통 준비다.

- 단위: 컨텍스트 하나가 소유한 BIZ 하나를 한 ticket으로 한다. 한도를 넘으면 그 BIZ의 INV·EX·AC 묶음으로 나눈다. ticket은 domain → application → `api.md`가 정한 entry → `data.md`가 정한 저장까지 수직으로 구현하며 계층별로 나누지 않는다. 한 ticket은 한 컨텍스트의 모델만 바꾸고 다른 컨텍스트는 컨텍스트 경계가 허용한 공개 API·port로만 접한다.
- 의존 순서: 호출하는 Application Service 메서드의 통합 결정과 컨텍스트 경계의 코드 의존 방향을 따른다. 상류 컨텍스트가 공개하는 API·이벤트를 만드는 ticket이 그것을 쓰는 하류 ticket보다 먼저다. 하류가 소유하는 port와 조립 adapter는 상류 공개 API ticket에 의존한다. 즉시 일관성(`CON-xx`의 동기 확인·호출)은 쓰는 쪽이 제공하는 쪽에 의존한다. 순환 의존은 만들지 않고 의존하는 ticket은 `의존성` 절과 index에 선행 ticket ID로 적는다.
- UI가 필요하면 화면 구현 ticket을 만들고 YAML frontmatter에 `frontend: true`를 넣는다. 이 ticket은 필요한 backend ticket에 의존하고 design artifact와 화면 구현·visual review 완료 기준을 포함한다. backend 규칙과 API 구현을 이 ticket에 넣지 않아 visual review 전에 선행 ticket에서 사용할 수 있게 한다. 업무 규칙 소유권은 backend ticket에 두고 UI ticket은 표현·상호작용과 응답 표시를 검증한다. 구현과 visual review는 발행 뒤 독립 `frontend-design` workflow가 수행한다. UI가 없는 ticket에는 이 표시를 넣지 않는다.
- 규칙 소유: 모든 BIZ는 구현 ticket 하나 이상으로 추적하고 그중 하나를 primary owner로 명시한다. 한도 때문에 BIZ를 나눈 경우 각 ticket은 자신이 맡은 규칙 묶음만 구현하며, 모든 INV·EX·AC는 정확히 한 ticket에 배정하고 `소유 규칙과 검증` 표에 강제 위치와 검증 테스트를 적는다. UI 표현 ticket은 backend 규칙의 소유권을 가져가지 않는다. 규칙의 강제 메서드, Application Service의 호출 순서와 트랜잭션 경계, 컨텍스트 경계의 데이터 소유·허용 의존·강제 방식은 원문대로 옮기고 줄이거나 바꾸지 않는다.
- 구현에 필요한 outbound 인터페이스의 사용 메서드·시그니처·실패 계약, 구현체와 인터페이스·구현 파일, 구체 기술 선언, 조립 위치, 데이터 매핑과 트랜잭션 공유를 `의존한 결정`에 `data.md` 행을 인용해 전달한다. 호출하지 않는 인터페이스는 ticket에 넣지 않는다.
- E2E ticket은 만들지 않는다. 사용자 경로 E2E는 사용자가 요청할 때 별도 `e2e-test` stage가 소유한다. 단위·회귀 검증은 직접 실행하는 기본 CLI 명령으로 기록하고 완료 gate는 별도 기록한다.

분할 결과를 바탕으로 canonical ticket 문서를 작성하고 독립 리뷰를 요청한다. 설계와 결정 문서만으로 필수 결정을 내릴 수 없을 때는 그 결정만 사용자에게 묻는다. 발행 승인은 전체 계획과 독립 리뷰가 끝난 뒤 orchestrator가 사용자에게 요청한다.

## Canonical ticket 작성

`worktree.json`에서 받은 `plan_set_id`를 그대로 사용해 각 ticket은 `docs/plans/<plan-set-id>/<plan-id>.md`, index는 `docs/plans/<plan-set-id>/plans.md`에 작성한다. 이 단계에서 `plan_set_id`를 만들거나 바꾸지 않는다. 각 ticket의 안정된 `plan_id`는 계속 정하며 tracker Issue 번호와 독립적으로 유지한다. index는 ticket 링크, 요약, 컨텍스트·BIZ, 의존성을 한 표에 두고 의존성 열의 머리글은 `의존성`으로 쓴다. 의존 ticket은 이 열과 ticket의 `의존성` 절에 같은 ID를 적는다. runner가 두 곳을 읽어 `tactical-code`의 실행 순서를 정한다.

ticket은 아래 모양을 따른다. 한국어로 쓰고 ID·경로·명령은 원형을 유지한다. 해당 사항이 없는 절에는 `해당 없음 — 이유`를 적는다.

````markdown
---
status: planned
---
# 게시글 작성

## 구현 목적

회원이 글을 쓰면 목록에서 읽을 수 있다. 본문 규칙은 값이 지킨다.

## 대상

| 항목 | 내용 |
|---|---|
| 컨텍스트(BC) | 커뮤니티 |
| 업무(BIZ) | BIZ-01 |
| 모델·Aggregate | 게시글(Aggregate), 본문(Value Object) |
| Application Service | AS-01 `writePost()` |
| 접하는 다른 컨텍스트 | 인증 — AS-01 `writePost()`가 공개 방문자 확인 API를 동기 호출. 없으면 `없음` |

## 소유 규칙과 검증

| 요구 | 내용 | 강제 위치 | 검증 테스트(파일 — 테스트 이름) |
|---|---|---|---|
| INV-01 | 본문은 1000자 이하다 | `본문.생성()` (커뮤니티 업무 규칙) | `test/community/post.test.mjs` — 1001자 본문은 거부한다 |
| EX-01 | 방문자는 글을 쓸 수 없다 | AS-01 `writePost()` 호출 순서 1 | `test/community/write.test.mjs` — 방문자의 작성은 거부한다 |
| AC-01 | 회원이 쓴 글이 목록에 보인다 | AS-01 | `test/community/write.test.mjs` — 작성한 글이 목록에 나온다 |

## 컨텍스트 경계

| 상대 컨텍스트 | 방향 | 허용 의존 | 데이터 소유 | 경계 강제 검사 |
|---|---|---|---|---|
| 인증 | 커뮤니티가 하류 | 인증이 공개한 `방문자 확인` API만 쓴다. 내부 타입을 넘기지 않는다 | 커뮤니티는 자기 table만 접근한다 | `test/boundary/community.test.mjs` — 인증의 table·Repository를 import하지 않는다 |

## 의존한 결정

- 기술(`technology.md`): Node 20, `node --test`로 실행한다
- API(`api.md`): `POST /posts`
- 데이터(`data.md`): `posts` table, migration 포함
- 인프라 바인딩(`data.md`, 커뮤니티 / `PostRepository`): `writePost()`가 호출하는 `save(post: Post): PostId`, 저장 실패 시 `PostWriteFailed`. `src/community/application/post-repository.ts`의 인터페이스를 `src/community/infra/sql-post-repository.ts`의 `SqlPostRepository`가 구현하고 `src/server.ts`의 `wireCommunity`에서 조립한다. PostgreSQL `INSERT`의 `posts(id, author_id, body)`에 매핑하고 AS-01이 시작한 client를 공유한다.
- UI: 해당 없음 — 서버 전용 요청

## 의존성

선행 ticket: `auth-visitor-check`. 없으면 `없음`.

## 범위

- 포함: 글 작성 domain 규칙, 작성 application service, `POST /posts`, `posts` 저장
- 제외: 글 삭제(`post-delete` ticket 소유), 인증 내부 구현

## 작업량

- 최대 계획 토큰: [활성 workspace `.codex/context-budget.json`의 `max_plan_tokens`]
- 예상 토큰: [구현·규칙 단위 테스트·수정 근거를 포함한 추정치]
- 산정 근거: [주요 변경 파일·규칙 묶음과 추정 이유]

## 완료 기준

- `소유 규칙과 검증` 표의 모든 테스트가 있고 통과한다.
- `컨텍스트 경계`의 경계 강제 검사가 통과한다.
- `필요한 비테스트 검증`을 실행했고 결과를 보고했다.
- 이 ticket의 변경만 한 commit으로 남는다.

## 필요한 비테스트 검증

- `npm test`, 정적 확인. 없으면 `없음`
````

기능 ticket의 `필요한 비테스트 검증`에는 그 ticket의 작업 환경에서 바로 실행할 수 있는 것만 적는다(빌드, `npm test` 같은 기본 CLI, 정적 확인). 실제 DB·외부 서비스·보안 체인이 있어야 하는 확인은 쓰지 않는다. 실행 위치·브랜치는 agent가 작성하지 않고 정적 실행기가 생성한다. [실행 위치 계약](execution-evidence.md#실행-위치) 및 [검증 근거 계약](execution-evidence.md)을 적용한다.

GitHub mode의 Issue 초안과 structured-source는 [GitHub 템플릿](github-issue-template.md)에 맞춰 `<session_directory>/runtime/to-ticket/drafts/`에 저장한다. Parent 초안에 실제 설계 문서 경로와 적용 가능한 ticket-scoped SVG 링크를 넣고, diagram이 없으면 이유를 기록한다. 각 child 초안은 하나의 ticket을 표현한다.

Canonical ticket과 index, 준비된 초안을 포함하는 `plan_set_draft` artifact를 반환한다. Artifact는 `{kind: "plan_set_draft", base: "workspace", path: "docs/plans/<plan-set-id>/plans.md"}` 형태다. Canonical ticket 작성 뒤 같은 `to-ticket` execution이 독립 fresh reviewer를 호출하고 plan-review gate를 통과한다. configured tracker 티켓 발행은 후속 `tracker-publish` workflow stage에서 수행한다.

모든 tracker mode에서 각 로컬 plan Issue 파일(`docs/plans/<plan-set-id>/<plan-id>.md`)이 lifecycle 상태의 정본이다. 따라서 각 ticket 파일 맨 앞에 YAML frontmatter `---\nstatus: planned\n---`를 둔다. GitHub mode에서는 Issue/Project 상태가 이 로컬 상태의 보조 mirror다. 리뷰 snapshot은 frontmatter의 `status`를 제외하므로 lifecycle 전이는 리뷰 결과에 영향을 주지 않는다.
