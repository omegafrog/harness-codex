# Harness Codex

**Codex 개발을 요구사항 → 설계 → 계획 → 구현 → 검증 → PR 흐름으로 구조화하는 project-local workflow harness.**

주요 기능:

- `$spec-me` — 질문을 통해 Product / Architecture Spec을 확정
- `$to-ticket` — Spec을 dependency가 있는 vertical implementation plan으로 분할
- `$implement-wrapper` — 독립 Plan은 병렬, 충돌 Plan은 순차 실행하고 fresh context로 handoff
- `$implement` + `$code-review` — test-first 구현 후 Product / Architecture 두 축으로 독립 검증
- `$diagnosing-bugs` — regression과 장애를 재현 → 원인 분석 → 수정 → 회귀 테스트
- `$gh-open-pr` — 전체 Plan Set을 하나의 integration PR로 정리

```text
$setup
  ↓
$spec-me → Product Spec → Architecture Spec
  ↓
$to-ticket → Plan Set
  ↓
$implement-wrapper → $implement × N → $code-review
  ↓
$gh-open-pr → 사용자 Merge
```

버그처럼 원인을 먼저 찾아야 하는 작업은 `$spec-me` 대신 `$diagnosing-bugs`에서 시작한다.

---

## 주요 명령

Codex에서는 skill을 `$skill-name`으로 호출한다.

| 명령 | 용도 |
| --- | --- |
| `$setup` | context, model tier, tracker 초기 설정 |
| `$spec-me <요청>` | 새 기능이나 구조 변경의 Product / Architecture Spec 작성 |
| `$to-ticket` | 승인된 Spec을 vertical plan과 dependency로 분할 |
| `$implement-wrapper` | 여러 Plan의 실행 순서·병렬성·충돌 조율 |
| `$implement` | 승인된 Plan 하나를 test-first로 구현 |
| `$diagnosing-bugs <문제>` | 장애·regression 원인 분석과 수정 |
| `$code-research <범위>` | 코드베이스 구조와 영향 범위 조사 |
| `$code-review` | 구현 diff를 Product / Architecture 기준으로 독립 리뷰 |
| `$gh-open-pr` | Plan Set 단위 PR 생성·갱신 |
| `$eli5 <주제>` | 복잡한 내용을 visual-first 방식으로 간단히 설명 |

하위 skill도 직접 호출할 수 있지만 일반적으로 상위 workflow가 필요한 시점에 조합한다.

---

## Workflow

### 1. `$setup`

처음 적용하는 repository를 Harness가 사용할 수 있게 준비한다.

- `CONTEXT.md`, `CONTEXT-MAP.md` 초기화
- 역할별 model / reasoning 설정
- GitHub 또는 local-markdown tracker 설정
- `.codex/harness.yaml` 관리

### 2. `$spec-me`

바로 코드를 작성하지 않고 요구사항과 설계를 먼저 확정한다.

```text
사용자 요청
  ↓
Product Spec — 무엇을 만들어야 하는가
  ↓
Architecture Spec — 어떻게 구현할 것인가
```

Product 단계는 source/test code를 기준으로 요구사항을 추론하지 않는다. Architecture 단계부터 `code-research`로 현재 구조를 조사하며 필요하면 `event-storming`, `ddd-design`, `codebase-design`을 사용한다.

두 단계 모두 `grill-with-docs`의 coverage gate를 사용한다.

```text
SETTLED        결정됨
PARTIAL        일부 결정됨
UNRESOLVED     결정 필요
NOT_APPLICABLE 적용되지 않음
```

중요한 `PARTIAL` / `UNRESOLVED` 항목이 남아 있으면 다음 단계로 진행하지 않는다.

주요 산출물:

```text
docs/specs/<ticket-id>/
├─ product-spec.md
├─ architecture-spec.md
└─ diagrams/
```

### 3. `$to-ticket`

완성된 Spec을 구현 가능한 **vertical slice**로 나눈다.

```text
❌ Entity → Repository → Service → Controller

✅ 실패 횟수 기록 + 잠금 전이
✅ 잠긴 계정 로그인 차단
✅ 관리자 잠금 해제
```

각 Plan에는 scope, dependency, acceptance criteria, test contract, 관련 Spec이 포함된다.

GitHub mode에서는 다음 구조를 사용한다.

```text
Parent Issue
├─ Child Plan A
├─ Child Plan B
└─ Child Plan C
```

### 4. `$implement-wrapper`

Plan의 dependency와 shared resource를 보고 실행 가능성을 계산한다.

```text
독립 Plan      → 병렬 실행 가능
resource 충돌 → 순차 실행
dependency     → 선행 Plan 완료까지 대기
```

Plan마다 새로운 `implementation_agent`를 사용한다. Context가 길어지면 checkpoint를 남기고 같은 Plan을 새 context에서 이어간다.

### 5. `$implement`

한 번에 정확히 하나의 승인된 Plan만 실행한다.

```text
Failing Test
    ↓
Minimum Implementation
    ↓
Tests / Typecheck
    ↓
Commit
    ↓
Independent Review
```

실제 server/E2E 실행이 필요하면 `execution_runner`가 별도로 실행과 log 수집을 담당한다.

### 6. `$code-review`

같은 diff를 두 개의 독립 reviewer가 검증한다.

```text
Implementation Diff
      ├─ standards_reviewer → Product Spec + repository rules
      └─ spec_reviewer      → Architecture Spec
```

둘 중 하나라도 unresolved이면 Plan을 완료 처리하지 않는다.

### 7. `$gh-open-pr`

Child Plan마다 PR을 만들지 않고 **Plan Set 하나당 integration PR 하나**를 사용한다.

모든 Plan의 구현과 검증이 끝나면 기존 draft plan PR을 implementation PR로 갱신하거나 새 integration PR을 만든다. Harness는 자동 merge하지 않는다.

---

## Skill Catalog

현재 `.codex/skills/`에는 19개 skill이 있다.

### Workflow / entrypoint

| Skill | 역할 |
| --- | --- |
| [`setup`](.codex/skills/setup/SKILL.md) | repository 초기 설정 |
| [`spec-me`](.codex/skills/spec-me/SKILL.md) | Product + Architecture Spec orchestration |
| [`to-ticket`](.codex/skills/to-ticket/SKILL.md) | Spec → vertical plan |
| [`implement-wrapper`](.codex/skills/implement-wrapper/SKILL.md) | multi-plan scheduling / handoff |
| [`implement`](.codex/skills/implement/SKILL.md) | single-plan implementation |
| [`diagnosing-bugs`](.codex/skills/diagnosing-bugs/SKILL.md) | bug / regression diagnosis |
| [`gh-open-pr`](.codex/skills/gh-open-pr/SKILL.md) | Plan Set PR 관리 |

### Specification / design

| Skill | 역할 |
| --- | --- |
| [`product-spec`](.codex/skills/product-spec/SKILL.md) | Product requirement와 acceptance criteria 정의 |
| [`architecture-spec`](.codex/skills/architecture-spec/SKILL.md) | 구현 가능한 architecture contract 정의 |
| [`code-research`](.codex/skills/code-research/SKILL.md) | codebase 구조 조사 |
| [`event-storming`](.codex/skills/event-storming/SKILL.md) | actor / command / event / policy 모델링 |
| [`ddd-design`](.codex/skills/ddd-design/SKILL.md) | aggregate / transaction / integration boundary 설계 |
| [`codebase-design`](.codex/skills/codebase-design/SKILL.md) | DDD 결정을 package / seam / adapter 구조로 변환 |
| [`domain-modeling`](.codex/skills/domain-modeling/SKILL.md) | ubiquitous language와 durable domain decision 관리 |

### Interview / validation / utility

| Skill | 역할 |
| --- | --- |
| [`grilling`](.codex/skills/grilling/SKILL.md) | 설계 가정과 trade-off 질문 |
| [`grill-with-docs`](.codex/skills/grill-with-docs/SKILL.md) | coverage-driven interview + durable docs |
| [`code-review`](.codex/skills/code-review/SKILL.md) | Product / Architecture 독립 리뷰 |
| [`plantuml-diagrams`](.codex/skills/plantuml-diagrams/SKILL.md) | ticket-scoped PlantUML + SVG 생성·검증 |
| [`eli5`](.codex/skills/eli5/SKILL.md) | visual-first 간단 설명 |

---

## Agent Profiles

`.codex/agents/`의 agent profile은 역할을 분리한다.

| Agent | 책임 |
| --- | --- |
| `code_researcher` | 코드베이스 조사 |
| `spec_document_writer` | 확정된 Spec 문서화 |
| `diagram_creator` | PlantUML / SVG 생성 |
| `to_ticket` | vertical plan 작성 |
| `implementation_agent` | Plan 하나 구현 |
| `execution_runner` | server/E2E 실행·polling·log 수집 |
| `standards_reviewer` | Product Spec + repository rules 리뷰 |
| `spec_reviewer` | Architecture Spec 리뷰 |

결정, 문서화, 구현, 실행 검증, 리뷰를 같은 agent에게 몰아주지 않는 것이 기본 원칙이다.

---

## Durable Context

```text
CONTEXT.md
  프로젝트 공통 용어

CONTEXT-MAP.md
  bounded context / ownership / relationship

docs/specs/<ticket-id>/
  특정 변경의 Product / Architecture 결정
```

`CONTEXT.md`는 대화 로그가 아니라 프로젝트에서 계속 유지할 canonical vocabulary를 위한 문서다.

---

## Workflow Gates

Harness는 파일을 만들었다는 사실만으로 단계를 완료하지 않는다.

```text
Specification → coverage / ambiguity / diagram
Planning      → approval / dependency / hierarchy
Implementation→ tests / typecheck / execution evidence
Review        → Product + Architecture review
PR            → 모든 Plan terminal + verification
```

---

## 터미널 CLI

Codex의 `$skill-name` 호출과 repository 관리 CLI는 별개다.

```text
harness-codex install [options]
harness-codex update [options]
harness-codex lock [options]
```

주요 option:

```text
--project <path>
--skills-only
--agents-only
--force
```

진단:

```text
harness-codex-doctor [--project <path>] [--native-profile <name>] [--json]
```

Eval:

```text
harness-eval run --suite <suite-id>
```

---

## 설치

현재 프로젝트에 설치:

```bash
npx --yes github:omegafrog/harness-codex install
```

업데이트:

```bash
npx --yes github:omegafrog/harness-codex update --project <target-project>
```

현재 상태를 새 baseline으로 기록:

```bash
npx --yes github:omegafrog/harness-codex lock --project <target-project>
```

설치되는 핵심 구조:

```text
.agents/skills/*
.codex/agents/*
.codex/workflows/*
.codex/harness.yaml
harness-lock.json
```
