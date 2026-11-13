# OpenAPI 기반 프런트엔드 타입·검증과 agentic coding 사례 조사

확인일: 2026-11-12. 상태: 조사 완료·후속 기술 조합 사용자 승인. 도구 설치·실제 앱 구현·효과 측정은 수행하지 않았다.

## 결론

OpenAPI에서 프런트엔드 타입·API client·runtime validator를 생성하는 흐름은 agentic coding에서도 유효하게 쓰인 직접 사례가 있다. 에이전트가 API 경로·필드·client 코드를 추측해 중복 작성하는 범위를 줄이고, 재생성과 타입 검사로 수정 피드백을 줄 수 있다. 다만 실제 backend가 스키마와 일치하는지, 런타임 검증이 호출되는지, 업무·권한 규칙이 맞는지는 별도 검증이 필요하다.

아래 블로그는 작성자의 사용 경험과 구현 설명이다. 독립적인 생산성 비교 실험으로 보지 않으며 토큰·시간 절감량을 일반적인 보장으로 인용하지 않는다.

## 도구 이름과 역할

사용자가 언급한 “zagger”는 문맥상 Zod 또는 Zodios일 가능성이 있으나 이름만으로 확정하지 않는다.

| 이름 | 역할 | 근거 |
|---|---|---|
| OpenAPI | endpoint·HTTP method·parameter·request/response·security 등을 기술하는 기계 판독 가능한 명세 | [Swagger 공식 설명](https://swagger.io/docs/specification/v3_0/about/) |
| Swagger UI 등 | OpenAPI를 사람이 탐색·호출할 수 있도록 제공하는 도구 | [Swagger 문서](https://swagger.io/docs/specification/v3_0/about/) |
| TypeScript | 생성된 타입에 맞는 코드인지 정적으로 검사하고 IDE 완성·탐색 제공 | [openapi-typescript 공식 문서](https://openapi-ts.dev/introduction) |
| Zod | 실행 시 실제 데이터에 schema를 적용하고 TypeScript 타입을 추론하는 라이브러리 | [Zod basics](https://zod.dev/basics) |
| Zodios | Zod 검증을 사용하는 typed HTTP client/server 라이브러리 | [공식 저장소](https://github.com/ecyrbe/zodios) |
| Orval | OpenAPI에서 TypeScript client·선택한 query hooks·Zod schemas·mock 등을 생성 | [공식 문서](https://orval.dev/docs/), [Zod guide](https://orval.dev/docs/guides/zod/) |

Zod는 자체적으로 OpenAPI 파일을 읽어 전체 API client를 만들어 주는 도구가 아니다. generator, typed client, runtime validation의 역할을 구분한다. Zodios와 Orval을 동시에 사용할 필요도 없다.

## 기술 블로그의 직접 사용 사례

| 출처·게시일·성격 | 실제로 설명한 흐름 | 적용 가능한 근거와 한계 |
|---|---|---|
| [크로스마트: 人間がコードを書かない1週間 LLM WEEKに向けてやったこと](https://xmart-techblog.hatenablog.com/entry/2025/08/04/113127), 佐藤, 2025-08-04 — 프런트엔드 엔지니어의 Claude Code 직접 사용 사례 | API 교체 작업 3건을 대상으로, OpenAPI 조회·갱신→Orval client/타입/mock 재생성→typecheck·tests·lint를 custom command로 실행. 이어 생성된 client와 기존 사용처를 분석해 plan을 작성 | agent가 생성기를 실행하고 컴파일 피드백을 사용하는 직접 사례. 서버 시작·CLI·전체 승인 방식은 해당 팀 환경이며 Harness의 실행 정책으로 그대로 복사하지 않음 |
| [Webnet: La méthode au quotidien : comment Claude code, et comment je garde le contrôle](https://blog.webnet.fr/la-methode-au-quotidien-comment-claude-code-et-comment-je-garde-le-controle/), Gilles Lautrou, 2026-08-12 — .NET + SvelteKit 두 프런트의 Claude Code 프로젝트 경험 | OpenAPI를 구현 전에 확정하고 backend는 그 계약에 맞춰 구현, frontend는 Orval로 타입·호출 함수 생성. `/verify-contract`로 양쪽 drift를 점검. 생성 코드는 직접 수정하지 않고 build 시 재생성 | agentic frontend/backend 협업의 직접 사례. 수동 OpenAPI 정본을 사용하는 contract-first 사례이며 backend code-first 생성의 증거로 혼동하지 않음 |
| [and factory: Orval で組む型安全 API 統合](https://andfactory.co.jp/techblog/posts/type-safe-api), 青木大地, 2026-05-29 — 실무 프런트엔드 통합 + agent 작업 규칙 | backend `make openapi` YAML→Orval 타입·TanStack hooks·Zod·MSW 생성. 공개/인증 API의 fetch 처리를 구분하고 `.claude/rules/api.md`에 생성 source 직접 수정 금지 명시 | backend 생성 schema와 프런트 통합·agent 편집 경계의 실무 사례. 글 전체가 agent 효과 비교 실험은 아니며 인증 mutator가 OpenAPI security와 자동 동기화되는 것도 아님 |
| [Huy Nguyen: Schema-First API Development with DRF + React](https://huynguyengl99.github.io/posts/schema-first-api-development-drf-react/), 2026-07-11 — 팀의 typed-client 경험과 AI-assisted 개발 설명 | DRF serializer→drf-spectacular OpenAPI→openapi-zod-client/Zodios·TypeScript·폼 연결. 필드 추가→재생성→사용처 타입 오류 수정. 에이전트가 수기 API 동기화 작업을 줄일 수 있다고 설명 | 사용자 의도와 가까운 backend→schema→frontend 흐름. 자체 generator fork를 사용하므로 upstream 그대로 동일한 기능을 보장하지 않음. 제시된 `validate: 'request'` 설정만으로 response 검증까지 켜졌다고 판단하지 않음 |

## 왜 에이전트에게도 도움이 되는가

1. 사용할 operation·parameter·body·response가 코드로 노출돼 API를 추측할 여지가 줄어든다.
2. 통신 타입·client를 결정론적 generator가 만들고 agent는 그 사용 코드·상태 처리에 집중한다.
3. 필수 필드 변경 등은 재생성 뒤 typecheck에서 해당 사용처 오류로 드러나 수정 loop에 구체적인 근거를 준다.
4. 같은 schema에서 만든 mocks는 backend가 아직 준비되지 않은 UI preview를 구성하는 데 쓸 수 있다.
5. source schema와 generator/config/version을 묶으면 어느 API 기준으로 작업했는지 재개·리뷰에서 확인할 수 있다.

위는 사례와 도구 동작에서 도출한 판단이다. 컴파일 통과가 API 통합·업무 정확성·보안·시각 품질 전체를 보장하지 않는다. API를 호출하는 runtime agent의 MCP 도구 생성과, 앱 source를 작성하는 coding agent의 typed-client 사용도 서로 다른 적용이다. 이번 제안에는 MCP server 자동 생성이 필요하지 않다.

## 반드시 구분할 세 가지 검사

| 검사 | 확인하는 것 | 확인하지 못하는 것 |
|---|---|---|
| OpenAPI 검증·생성 drift | 명세 구조·generator 지원·현재 schema/config/version과 생성 결과의 정합성 | backend 실제 응답과 업무 규칙 전체 |
| TypeScript typecheck | typed client의 operation·입력·반환 타입을 코드가 올바르게 사용하는지 | 실제 네트워크 JSON의 내용·서버 배포 버전 |
| Zod 등 runtime parsing | 실제 응답/입력이 선택한 schema를 충족하는지 | 권한·동시성·업무 의미·정상 상태 값의 사실 여부 |

Zod는 `.parse()`/`.safeParse()` 등이 실제로 호출돼야 검사한다. 선언·생성만으로 응답이 검증되지 않는다. [Zod 공식 문서](https://zod.dev/basics)

Orval의 현재 문서는 runtime validation 기본값이 꺼져 있고 client family·mutator 경로별 지원과 우회 조건이 다르다고 설명한다. custom mutator가 직접 요청하면 생성기의 parse가 실행되지 않을 수 있으므로 채택 버전의 설정과 실제 실패 입력으로 확인해야 한다. [Orval runtime validation support matrix](https://orval.dev/docs/reference/configuration/output/#runtime-validation-support-matrix)

원문 예제의 coercion·transform을 무조건 복사하지 않는다. wire type mismatch를 숨길 수 있는 강제 변환은 API 규약의 일부인지 판단하고, 정당한 변환은 검증 후 별도 frontend mapping에서 수행한다. nullable/optional·날짜 문자열·숫자 정밀도·enum·union·에러/빈 응답·파일/stream 등의 실제 API 형태도 generator 지원과 대조한다.

## 현재 종합 계획에 반영한 결정

조사 뒤 기술 비교를 제시했고, 사용자의 “그렇게 하자 너 조합대로” 답변으로 backend OpenAPI exporter + Redocly CLI + Orval + Zod + TypeScript 검사 조합을 확정했다. MSW는 frontend 선행 개발/상태 preview에, oasdiff는 기존 소비자 호환성 관리에 필요할 때 추가한다. 상세 산출물·리뷰·구현/검증 범위는 [종합 계획](frontend-workflow-integration.md)의 「승인된 OpenAPI 통합 기술 조합」을 따른다. 선정은 설치·실행 완료를 뜻하지 않는다.

```text
backend 공개 DTO·controller 정의
  → OpenAPI export·Redocly 검사·version/hash가 고정된 snapshot
  → Orval로 TypeScript 타입·client·Zod schema 생성, mock은 조건부
  → frontend agent가 생성 API를 사용해 UI/state 구현
  → 재생성 drift 검사·typecheck·runtime boundary 검증
  → 실제 backend 응답의 schema 준수·사용자 흐름 검증
```

- backend를 정본으로 하는 code-first 접근이 사용자 의도에 가깝다. 예제처럼 domain Entity·DB schema를 그대로 공개하는 대신 command 입력·query DTO·error 응답 등 공개 경계에서 export한다.
- HTTP 구조의 단일 교환 산출물은 OpenAPI snapshot으로 두고, 기존 `interface-contract.md`에 request/response 구조를 수기로 다시 복제하지 않는다. 문서는 operation과 연결된 업무 의미·버전/호환 정책·OpenAPI로 표현하기 어려운 동작만 설명한다.
- frontend agent는 고정 schema에서 재생성한 client를 사용한다. `any`·타입 단언·임의 endpoint/field·직접 편집으로 오류를 숨기지 않는다. 생성 파일 변경은 원본 schema·generator 설정의 정상 변경으로 해결한다.
- compiler feedback을 지침으로 연결한다. `schema export → generate → typecheck → 영향 사용처 수정 → 관련 검사`를 반복 가능한 프로젝트 명령으로 만들고 agent에게 입력/출력을 알려 준다. 실제 명령·준비 방법은 EXEC에 쓴다.
- code-first와 frontend 선행 개발은 구분한다. backend schema가 아직 없으면 승인한 명세 snapshot과 실제 backend export의 정합성을 나중에 확인해야 하며, mock이 통과했다고 실제 구현과 일치한다고 표시하지 않는다.
- backend reviewer는 backend DTO·export·backend 기준을, frontend reviewer는 generated client 소비·runtime parse·UI 상태 처리와 frontend 기준을 검토한다. OpenAPI snapshot은 양쪽이 참조하는 공통 교환 자료이며 상대 source/spec 전문을 주입하지 않는다.
- 재생성 drift와 mock은 같은 잘못된 schema를 함께 따를 수 있다. 실제 backend가 선언한 schema대로 응답하는지 별도 검증하고, 실제 사용자 E2E는 기존 실행 승인·실패 정책을 따른다. generation만을 위해 승인 전 전체 인프라를 띄우지 말고 가능한 offline/build export를 우선한다.
- frontend 생성 source는 프로젝트 소유다. backend/front repo가 나뉘면 revision/hash가 고정된 artifact/package/file로 전달한다. 구현 시 Git에 저장할지 build에서 만들지 한 정책을 선택하고, 재현에 필요한 schema·generator/config/version과 CI 재생성 검사를 보존한다. Harness ignore나 강제 managed assets에 섞지 않는다.

## 비교 후보와 채택 결과

| 후보 | 적합한 상황 | 조건 |
|---|---|---|
| Orval | client·query hooks·validator·mock을 같은 schema에서 생성하려는 현재 UI workflow | 실제 stack·client·mutator와 runtime validation 지원 확인. 전체 기능을 모두 켤 필요 없음 |
| openapi-typescript + openapi-fetch | 타입과 fetch 연결만으로 충분하고 기존 client 구성을 유지하려는 경우 | 타입은 runtime-free이므로 응답 검증이 필요하면 별도 생성 validator/검증 연결이 필요. [공식 문서](https://openapi-ts.dev/introduction) |
| openapi-zod-client + Zodios | Zod 기반 client가 이미 있거나 schema 기반 재사용이 중요한 경우 | 블로그의 자체 fork·Zod version·기능 지원과 upstream 차이를 확인. 사례 하나만으로 우선 채택하지 않음 |

현재 계획의 기본 generator는 사용자 승인으로 Orval을 선정했다. 위의 나머지 도구는 비교 자료이며 함께 설치할 대상이 아니다. 실제 프로젝트의 frontend stack·기존 HTTP client·validation 경로에 맞는 Orval 설정과 고정 버전을 구현 시 확인한다.

## 확인하지 않은 것

도구 설치·버전 간 호환 시험·실제 schema export·생성 client 실행·runtime mismatch 검출·생산성 비교는 하지 않았다. 기술 블로그의 효과 주장은 저자 경험으로 구분했다. 이 보고서는 종합 계획을 위한 조사 자료이며 실제 동작 검증 결과가 아니다.
