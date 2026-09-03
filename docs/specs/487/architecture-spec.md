# Architecture Spec — #487 spec-me 다이어그램 산출물·렌더·PR 미리보기

## 1. 설계 범위

### 1.1 대상

| 항목 | 대상 |
|---|---|
| Product Spec | `docs/specs/487/product-spec.md` |
| Use Cases | UC-001, UC-002, UC-003 |
| 영향 경계 | `spec-me`, `product-spec`, `architecture-spec`, `to-ticket`, `gh-open-pr`, `eli5`, harness installer |
| 외부 의존 | Java, Graphviz, 고정 버전 PlantUML JAR, GitHub PR Markdown |
| 영속 데이터 | 티켓별 Spec 및 다이어그램 파일 |

### 1.2 Product Spec 매핑

| Product 요구 | 설계 책임 |
|---|---|
| 단계별 다이어그램 | Product/Architecture Spec 계약과 템플릿 |
| `.puml` 원본·SVG | renderer CLI와 티켓별 `diagrams/` 파일 규약 |
| 렌더 실패 차단 | `spec-me` 단계 완료 게이트 |
| PR 한눈에 보기 | `eli5` 설명 패스 |
| PR 상세 그림 | `gh-open-pr`의 접기식 SVG 본문 계약 |

## 2. 도메인 흐름

이 변경은 비즈니스 도메인이 아닌 선언형 harness workflow 변경이다. Aggregate, 도메인 이벤트, 저장소, 비동기 메시지는 해당 없다.

```text
확정된 Spec 입력
  → plantuml-diagrams가 적용 대상 판단
  → .puml 원본 작성
  → renderer CLI preflight·렌더
  → SVG와 Markdown 링크 검증
  → spec-me 완료
  → gh-open-pr가 ELI5 요약·접기식 SVG 미리보기 구성
```

## 3. DDD 경계

### 3.1 Bounded Context

| 경계 | 책임 |
|---|---|
| Specification Workflow | 요구사항·설계 명세와 다이어그램 산출물 생성·검증 |
| PR Presentation | PR 본문 요약과 검토용 미리보기 구성 |
| Tool Provisioning | 고정된 PlantUML 도구 준비와 무결성 확인 |

### 3.2 클래스 다이어그램

해당 없음. 변경 대상은 런타임 도메인 모델이 아니라 Markdown 스킬 계약, CLI 경계, 파일 규약이다. 클래스로 모델링하면 실제 책임 경계를 가린다.

### 3.3 상태 다이어그램

해당 없음. 이 변경은 사용자·도메인 객체 생명주기를 추가하지 않는다. 대상 기능의 상태 다이어그램 생성 규칙만 제공한다.

## 4. 프로그램 설계

### 4.1 구성 요소와 책임

| 구성 요소 | 책임 | 반드시 하지 않을 일 |
|---|---|---|
| `plantuml-diagrams` | 단계별 다이어그램 선택, 작성 원칙, 렌더·추적성 게이트 | Java 명령·파일 탐색 로직 중복 |
| renderer CLI | 의존성 preflight, 렌더, 출력 검증, 오류 보고 | Spec 의미 판단 |
| bootstrap/installer | 고정 버전 JAR 다운로드·SHA-256 검증·cache 준비 | 매 스킬 호출 시 설치 |
| `spec-me` | Product/Architecture 단계의 다이어그램 완료 게이트 조정 | PR 생성·수정 |
| `product-spec` | Product 다이어그램 조건·Markdown 계약 | 코드 구조 결정 |
| `architecture-spec` | Architecture 다이어그램 조건·Markdown 계약 | Product 의도 재결정 |
| `eli5` | PR 첫 화면의 한 문장·최대 세 단계 요약 편집 | 상세 UML 그림 생성 |
| `gh-open-pr` | PR 본문 조립, 다이어그램별 접기식 SVG 미리보기 | 다이어그램 원본 작성·렌더 |

### 4.2 호출 계약

| 순서 | 호출자 | 피호출자 | 계약 |
|---:|---|---|---|
| 1 | bootstrap/installer | tool cache | PlantUML JAR 고정 버전·SHA-256 검증 후 준비 |
| 2 | `plantuml-diagrams` | renderer CLI | 입력 `.puml`, 출력 SVG, 선택 PNG, 실패 목록 |
| 3 | `spec-me` | Product/Architecture Spec | 필요한 다이어그램·SVG 링크·일치 검토 완료 전 진행 금지 |
| 4 | `gh-open-pr` | `eli5` | 한눈에 보기 문장을 시각 우선·저텍스트로 편집 |
| 5 | `gh-open-pr` | GitHub CLI | head branch를 가리키는 SVG 링크가 든 PR 본문 생성·갱신 |

## 5. 기술 아키텍처

### 5.1 파일 구조

```text
.codex/skills/
  plantuml-diagrams/
  eli5/
bin/
  <bootstrap command>
  <renderer command>
docs/specs/<ticket-id>/
  product-spec.md
  architecture-spec.md
  diagrams/
    product/
      UC-001.usecase.puml
      UC-001.usecase.svg
      UC-001.activity.puml
      UC-001.activity.svg
      <concept>.business-state.puml
      <concept>.business-state.svg
    architecture/
      <context>.class.puml
      <context>.class.svg
      <concept>.state.puml
      <concept>.state.svg
```

PNG는 PR 첨부 또는 외부 공유가 필요한 경우에만 같은 basename으로 생성한다.

### 5.2 렌더 계약

- bootstrap은 고정 버전 PlantUML JAR만 다운로드하고 SHA-256을 검증한다.
- cache에 JAR가 없거나 버전·SHA가 다르면 renderer는 설치하지 않고 실패 원인과 bootstrap 실행 방법을 보고한다.
- renderer는 Java, Graphviz, JAR, 입력 파일, 출력 SVG를 preflight 한다.
- renderer CLI가 `.puml`에서 SVG를 생성하는 유일한 실행 경계다.
- `.puml`가 편집 원본이다. SVG·PNG를 직접 수정하지 않는다.
- 외부 URL 및 workspace 밖 파일을 가리키는 `!include`는 금지한다. 공용 테마는 renderer의 허용 목록만 사용한다.

### 5.3 Spec 계약 변경

- `product-spec` 템플릿·완료 조건에 UC별 유스케이스·액티비티, 필요 시 업무 상태의 링크 규칙을 추가한다.
- `architecture-spec`의 inline PlantUML 예시는 독립 `.puml` 파일과 SVG 링크 규칙으로 대체한다.
- `spec-me`는 필요한 다이어그램의 원본, SVG, Markdown 링크, 내용 일치 검토가 완료되기 전 다음 단계로 진행하지 않는다.
- `to-ticket`은 존재하는 독립 다이어그램 파일 링크를 계획에 연결할 수 있지만, 다이어그램 존재를 계획 분할의 선행 조건으로 삼지 않는다.

### 5.4 PR 본문 계약

```md
## 한눈에 보기
<eli5 한 문장>
<최대 세 단계 Before → After>

## 흐름 다이어그램
<details>
<summary>UC-001 · 제출 흐름 · Activity</summary>

![UC-001 activity](../blob/<head-branch>/docs/specs/<ticket-id>/diagrams/product/UC-001.activity.svg?raw=true)
</details>
```

- `gh-open-pr`는 변경된 각 다이어그램을 독립 `<details>` 블록에 넣는다.
- summary는 요구사항/유스케이스 ID, 이름, 유형을 포함한다.
- PR 본문에는 일반 상대 경로가 아닌 head branch 기반 `../blob/<head-branch>/...svg?raw=true` 링크를 쓴다.
- 현행 implementation PR의 Mermaid 선택 규칙은 PlantUML SVG 미리보기 규칙으로 대체한다.

## 6. 런타임·오류 처리

| 상황 | 분류 | 결과 | 복구 |
|---|---|---|---|
| Java·Graphviz·JAR 누락 | 환경 오류 | 렌더 실패, Spec 단계 차단 | bootstrap 실행 |
| JAR SHA 불일치 | 무결성 오류 | 렌더 실패 | 검증된 bootstrap 재실행 |
| PlantUML 문법 오류 | 입력 오류 | 해당 파일·행을 보고하고 단계 차단 | `.puml` 수정 후 재렌더 |
| 출력 SVG 없음/빈 파일 | 산출물 오류 | 단계 차단 | renderer 오류 수정·재실행 |
| PR 이미지 미리보기 실패 | PR 구성 오류 | PR 본문 완료 차단 | head branch 링크 수정·미리보기 재검증 |

렌더는 로컬 단일 프로세스 작업이다. 동시 실행·트랜잭션·재시도·영속 저장소는 이 범위에서 해당 없다.

## 7. 보안·관찰성

- renderer는 외부 include, workspace 밖 include, 자동 네트워크 설치를 허용하지 않는다.
- bootstrap은 검증된 URL·버전·SHA-256만 사용한다.
- 로그에는 입력 경로, 출력 경로, PlantUML 버전, 실패 파일·행만 남긴다. 자격 증명·환경 비밀은 기록하지 않는다.

## 8. 변경·검증 경계

### 8.1 변경 대상

| 경로/영역 | 변경 |
|---|---|
| `.codex/skills/plantuml-diagrams/` | 새 다이어그램 작성·검증 스킬 |
| `.codex/skills/eli5/` | 기존 Codex용 마이그레이션 원본 등록 |
| `.codex/skills/spec-me/` | 단계 완료 게이트 연결 |
| `.codex/skills/product-spec/` | Product 다이어그램 계약·템플릿 |
| `.codex/skills/architecture-spec/` | 독립 다이어그램·SVG 링크 계약·템플릿 |
| `.codex/skills/to-ticket/` | 존재하는 독립 다이어그램 링크의 계획 연결 |
| `.codex/skills/gh-open-pr/` | ELI5 요약·접기식 SVG PR 본문 |
| installer/bootstrap/renderer 영역 | 고정 PlantUML provisioning·render CLI |
| 테스트 | 스킬 계약 및 renderer fixture 검증 |

### 8.2 금지·조건부 변경

- 기존 `docs/specs/**`는 마이그레이션하지 않는다.
- PlantUML MCP, 원격 렌더 서비스, 호출 시 자동 설치는 도입하지 않는다.
- Product 단계에서 클래스 다이어그램을 만들지 않는다.
- 흐름 변경이 없으면 유스케이스·액티비티 다이어그램을 형식적으로 만들지 않는다.

### 8.3 검증

- 스킬·템플릿·PR 본문 규칙은 단위 계약 테스트로 검증한다.
- fixture 유효 `.puml`은 SVG 렌더 성공을, fixture 오류 `.puml`은 실패를 검증한다.
- CI는 bootstrap 뒤 통합 렌더 테스트를 필수로 실행한다.
- Markdown SVG 링크와 GitHub PR `<details>` 미리보기 형식을 검증한다.

## 9. 대안·리스크·결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 렌더 방식 | 로컬 renderer CLI | 재현성·오프라인 검증·외부 MCP 제거 |
| 설치 시점 | bootstrap 1회 | 호출마다 설치하지 않음 |
| JAR 보관 | cache, Git 미커밋 | 저장소 binary churn 방지 |
| 이미지 기본값 | SVG 커밋·Markdown 포함 | 선명도·문서 가독성 |
| PNG | 필요 시만 생성 | 중복 산출물 억제 |
| ELI5 | repo-local 활성 스킬 | 전역 환경 의존 제거 |
| PR 상세 그림 | 다이어그램별 접기 블록 | 본문 가독성 유지 |

차단된 결정 없음.
