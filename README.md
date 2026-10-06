# Harness Codex

**Codex 개발을 요구사항 → 설계 → 계획 → 구현 → 검증 → PR 흐름으로 구조화하는 project-local workflow harness.**

주요 기능:

- `$spec-me` — 질문을 통해 Product / Architecture Spec을 확정
- `$to-ticket` — Spec을 dependency가 있는 vertical implementation plan으로 분할
- `$implement-wrapper` — 독립 Plan은 병렬, 충돌 Plan은 순차 실행하고 fresh context로 handoff
- `$implement` + `$code-review` — test-first 구현 후 Product / Architecture 두 축으로 독립 검증
- `$diagnosing-bugs` — regression과 장애를 재현 → 원인 분석 → 수정 → 회귀 테스트
- `$frontend-spec` — Figma/구현 전 화면 설계·reference·component/state·Storybook contract를 durable package로 확정
- `$frontend-design` — READY design package 또는 즉석 brief → Figma/구현 → browser visual review → correction loop
- `$evaluate-harness` — Harness 변경을 eval suite와 baseline으로 품질·토큰·지연까지 평가
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
| `$frontend-spec <요청>` | Figma/구현 전 Frontend Design Package 작성 |
| `$frontend-design <요청>` | READY package 또는 즉석 brief 기반 프런트엔드 설계·구현·시각 검증 |
| `$code-research <범위>` | 코드베이스 구조와 영향 범위 조사 |
| `$code-review` | 구현 diff를 Product / Architecture 기준으로 독립 리뷰 |
| `$evaluate-harness [suite]` | Harness 변경을 eval suite baseline과 비교해 품질·효율 회귀 평가 |
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

### 8. `$frontend-spec`

Figma와 구현 전에 화면의 제품/UX/시각 방향을 durable package로 확정한다.

```text
요구사항 / 현재 UI / reference images
  ↓
frontend_spec_designer
  ↓
docs/design/<screen-id>/
  ├─ frontend-design-spec.md
  ├─ visual-direction.md
  └─ ui-contract.md
  ↓
READY Frontend Design Package
```

각 문서의 책임은 다음과 같다.

- `frontend-design-spec.md`: user goal, information hierarchy, screen inventory, desktop/mobile layout, flow, states, acceptance scenarios
- `visual-direction.md`: Primary/Supporting/Anti-reference, visual character, hierarchy, typography/surface/density/color/motion rules
- `ui-contract.md`: screen-state matrix, component inventory, responsive/accessibility contract, 구현 후 필요한 Storybook stories, Figma component/variant mapping

이 단계에서는 Figma, application source, Storybook stories를 구현하지 않는다. 이미지가 실제 repository asset으로 제공되지 않았으면 가짜 이미지 경로를 만들지 않고 source/evidence로 기록한다.

### 9. `$frontend-design`

기존 구현 workflow와 분리된 프런트엔드 전용 흐름이다. READY Frontend Design Package가 있으면 해당 결정을 다시 설계하지 않고 authoritative input으로 소비한다.

```text
$frontend-spec package 또는 즉석 brief
  ↓
Frontend design handoff
  ↓
[Figwright 연결 시] native Figma design + authoritative root node
  ↓
frontend_implementation_agent
  ↓
frontend_visual_reviewer
  ↓
BLOCKER/MAJOR가 있으면 correction
  ↓
Visual acceptance
```

기존 token·component·Storybook/Figma evidence를 우선 사용하고, 실제 browser render와 screenshot을 확인하기 전에는 visual quality를 통과시키지 않는다. Figwright가 연결되면 Figma Agent/Make 대신 local Figwright MCP/plugin을 사용해 native Figma UI를 직접 작성하고, `get_design_context`와 component/token/icon mapping으로 구현을 grounding한 뒤 Figma/browser screenshot을 비교한다. `implement`, `implement-wrapper`, `code-review`, `e2e-test`를 호출하지 않으며 tracker/plan 상태도 변경하지 않는다.

### 10. `$evaluate-harness`

Harness 자체의 skill, workflow, agent, eval infrastructure를 변경했을 때 기존 eval suite를 실행해 baseline과 비교한다.

```text
변경 범위 확인
  ↓
관련 eval suite 선택
  ↓
harness-eval 실행
  ↓
correctness / quality / tokens / latency / inconclusive 판정
```

Suite가 지정되지 않으면 변경된 workflow와 case manifest를 기준으로 선택하고, 매핑이 불명확하면 `p0`를 smoke/regression suite로 사용한다. Baseline은 실패를 없애기 위해 자동 갱신하지 않는다.

---

## Skill Catalog

현재 `.codex/skills/`에는 26개 skill이 있다.

### Workflow / entrypoint

| Skill | 역할 |
| --- | --- |
| [`setup`](.codex/skills/setup/SKILL.md) | repository 초기 설정 |
| [`spec-me`](.codex/skills/spec-me/SKILL.md) | Product + Architecture Spec orchestration |
| [`to-ticket`](.codex/skills/to-ticket/SKILL.md) | Spec → vertical plan |
| [`implement-wrapper`](.codex/skills/implement-wrapper/SKILL.md) | multi-plan scheduling / handoff |
| [`implement`](.codex/skills/implement/SKILL.md) | single-plan implementation |
| [`diagnosing-bugs`](.codex/skills/diagnosing-bugs/SKILL.md) | bug / regression diagnosis |
| [`evaluate-harness`](.codex/skills/evaluate-harness/SKILL.md) | Harness eval suite 실행 + baseline regression 판정 |
| [`gh-open-pr`](.codex/skills/gh-open-pr/SKILL.md) | Plan Set PR 관리 |
| [`frontend-spec`](.codex/skills/frontend-spec/SKILL.md) | pre-Figma Frontend Design Package 작성 |
| [`frontend-design`](.codex/skills/frontend-design/SKILL.md) | 독립 frontend design/build/visual-review orchestration |

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
| [`e2e-test`](.codex/skills/e2e-test/SKILL.md) | 실제 server/browser 기반 end-to-end 검증 |
| [`plantuml-diagrams`](.codex/skills/plantuml-diagrams/SKILL.md) | ticket-scoped PlantUML + SVG 생성·검증 |
| [`eli5`](.codex/skills/eli5/SKILL.md) | visual-first 간단 설명 |
| [`frontend-figma`](.codex/skills/frontend-figma/SKILL.md) | Figwright 기반 Figma authoring / grounding / browser comparison adapter |
| [`frontend-implement`](.codex/skills/frontend-implement/SKILL.md) | settled frontend brief 구현·correction |
| [`frontend-visual-review`](.codex/skills/frontend-visual-review/SKILL.md) | 실제 browser 기반 UI/UX 시각 검증 |

---

## Agent Profiles

`.codex/agents/`의 agent profile은 역할을 분리한다.

| Agent | 책임 |
| --- | --- |
| `code_researcher` | 코드베이스 조사 |
| `spec_document_writer` | 확정된 Spec 문서화 |
| `diagram_creator` | PlantUML / SVG 생성 |
| `to_ticket` | vertical plan 작성 |
| `frontend_spec_designer` | Figma/구현 전 durable Frontend Design Package 작성 |
| `frontend_designer` | READY package 또는 reference-grounded frontend brief를 Figma/구현 handoff로 변환 |
| `frontend_implementation_agent` | frontend brief 구현·correction |
| `frontend_visual_reviewer` | 실제 browser render 기반 visual/UX review |
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

docs/design/<screen-id>/
  화면별 Frontend Design Package
```

`CONTEXT.md`는 대화 로그가 아니라 프로젝트에서 계속 유지할 canonical vocabulary를 위한 문서다.

---

## Workflow Gates

Harness는 파일을 만들었다는 사실만으로 단계를 완료하지 않는다.

```text
Specification → coverage / ambiguity / diagram
Frontend Spec→ READY package / material ambiguity resolved
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

## 외부 프로젝트에 설치 및 업데이트

Harness는 각 프로젝트 checkout에 로컬로 설치한다. Node.js 20 이상, Git, 그리고 `npx`를 사용할 수 있는 npm이 필요하다. 대상 프로젝트의 루트에서 실행하거나 `--project`에 절대 경로를 넘긴다.

### 최초 설치

```bash
cd /path/to/your-project
npx --yes github:omegafrog/harness-codex install
```

다른 디렉터리에서 실행할 때는 다음과 같이 대상 프로젝트를 명시한다.

```bash
npx --yes github:omegafrog/harness-codex install --project /path/to/your-project
```

설치가 끝나면 프로젝트에서 Codex를 열어 `$setup`을 실행한다. 이 단계에서 프로젝트별 `.codex/harness.yaml`과 컨텍스트·트래커 설정을 정한다.

설치되는 핵심 런타임은 다음과 같다.

```text
.agents/skills/*                 Codex skill 사본
.codex/agents/*                  Harness agent profile
.codex/workflows/*               workflow 정의
.codex/schemas/*                 workflow schema
.codex/scripts/*                 workspace 및 lifecycle script
.codex/harness-lock.json         설치 기준선과 파일 hash
```

필요한 부분만 설치하는 경우에는 최초 설치에서만 `--skills-only` 또는 `--agents-only`를 사용할 수 있다. 기존 agent profile을 Harness 버전으로 덮어쓰려면 최초 설치 명령에 `--force`를 추가한다.

### 업데이트

먼저 대상 프로젝트의 작업 트리가 깨끗한지 확인하고, 필요한 경우 변경사항을 commit 또는 stash한다. 그 다음 설치 때와 같은 방식으로 최신 Harness를 실행한다.

```bash
cd /path/to/your-project
npx --yes github:omegafrog/harness-codex update

# 또는 다른 디렉터리에서
npx --yes github:omegafrog/harness-codex update --project /path/to/your-project
```

이 버전으로 새로 설치하거나 한 번 업데이트한 프로젝트에서는 Codex에게 `하네스 업데이트해` 또는 `Harness 업그레이드해`라고 요청해도 된다. 함께 설치되는 `harness-maintenance` skill이 현재 Git worktree의 lock 파일을 확인한 뒤, 위 업데이트와 진단을 수행한다. 아직 이 skill이 없는 기존 설치본은 이 명령을 한 번 직접 실행해 업데이트해야 한다. 아직 설치 기준선이 없는 checkout에서는 설치를 임의로 대신 실행하지 않고 이를 알린다.

업데이트는 `.codex/harness-lock.json`의 설치 기준선을 사용한다.

- Harness가 설치한 뒤 프로젝트에서 바꾸지 않은 관리 파일은 최신 버전으로 갱신한다.
- 새로 추가된 관리 파일은 추가한다.
- 프로젝트에서 수정한 파일은 덮어쓰지 않고 `Preserved`로 보고한다. `locally_modified`는 로컬 변경만, `conflict`는 로컬과 Harness 양쪽에 변경이 있다는 뜻이다.
- `$setup`이 소유하는 `.codex/harness.yaml`은 자동으로 추가·교체하지 않는다.

`Preserved` 파일에는 새 Harness 변경을 자동으로 적용하지 않는다. 출력된 경로를 비교해 필요한 변경을 수동으로 병합한 뒤, 현재 상태를 다음 기준선으로 기록한다.

```bash
npx --yes github:omegafrog/harness-codex lock --project /path/to/your-project
```

`lock`은 현재 파일을 새로운 기준선으로 신뢰하는 작업이므로, 병합 내용 검토와 검증을 마친 경우에만 실행한다.

### 설치·업데이트 후 검증

```bash
npx --yes --package github:omegafrog/harness-codex \
  harness-codex-doctor --project /path/to/your-project
```

성공하면 `Harness doctor: PASS`가 출력된다. 실패하면 출력된 파일과 진단 코드를 확인해 수정한 후 다시 실행한다. 자동화에서는 `--json`을 사용해 구조화된 결과를 받을 수 있다.

### Git과 프로젝트별 파일

`install`과 `update`는 `.agents/`, `.codex/`, `skills-lock.json`을 해당 저장소의 `.git/info/exclude`에 추가한다. 이는 로컬 checkout에만 적용되며 저장소의 `.gitignore`를 바꾸지 않는다.

이미 Git이 추적하는 Harness 런타임 파일은 exclude만으로 untrack되지 않는다. 먼저 추적 대상을 확인하고, 팀 정책상 로컬 런타임으로 전환할 파일만 명시적으로 추적 해제한다. 기존 프로젝트별 Codex 설정까지 일괄 추적 해제하지 않도록 주의한다.

```bash
git ls-files .agents .codex
git rm --cached .codex/agents/<managed-profile>.toml
```

공유할 프로젝트 지침과 결정은 `AGENTS.md`, ADR, 도메인 문서에 보관한다. Harness 런타임은 checkout마다 설치·업데이트하고, 서버·인프라 실행 지침은 `docs/agents/EXEC.md`에 둔다.
