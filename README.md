# Harness Codex

**Codex 개발을 요구사항 → 설계 → 계획 → 구현 → 검증 → PR 흐름으로 구조화하는 project-local workflow harness.**

공개 Harness skill은 `$setup`, `$orchestrator`, `$eli5`, `$harness-update` 네 개다(Claude Code에서는 `/setup`, `/orchestrator`, `/eli5`, `/harness-update`). 자연어 유지보수·복구, 버그 분석·수정, 지식·평가, 프런트엔드, 리뷰·PR, 검증 요청은 orchestrator가 관련 내부 GUIDE로 라우팅한다.

주요 workflow 단계:

- `$orchestrator` — 모델·effort를 지정한 subagent로 skill을 실행하고 상태 코드·결과 파일로 workflow 진행과 회귀를 결정
- 최초 작업 요청은 `UserPromptSubmit` hook이 메인 orchestrator에 전달하며, `workflow-compose` subagent가 요청별 workflow를 생성한 뒤 작업 skill을 실행한다.
- 요구사항 흐름 — 새 기능이면 `spec-me` 전에 `stakeholder-analysis` → `subdomain-candidates` → `ubiquitous-language` → `event-storming` → `subdomain-classification` → `bounded-context` → `requirements-fix`가 하나의 `requirements.md`를 단계별로 채워 확정
- 전술 설계 흐름 — 확정된 요구사항 뒤, `spec-me` 전에 `domain-model` → `aggregate-design` → `domain-service` → `application-service` → `integration-design` → `context-boundary`가 하나의 `tactical-design.md`를 단계별로 채우고 마지막 stage가 끝날 때 실행기가 문서 전체를 결정론적 gate로 한 번 검사
- `spec-me` — 질문을 통해 Product / Architecture Spec을 확정
- `to-ticket` — Spec을 dependency가 있는 vertical implementation plan으로 분할
- `implement-wrapper` — orchestrator가 선택한 승인 Plan 하나를 구현하고 단위 테스트·실행 근거를 반환
- `implement` + `code-review` — test-first 구현 후 Product / Architecture 두 축으로 독립 검증
- `diagnosing-bugs` — regression과 장애를 재현 → 원인 분석 → 수정 → 회귀 테스트
- `frontend-design` — reference-first UI 설계 → 전용 구현 → browser visual review → correction loop
- `evaluate-harness` — Harness 변경을 eval suite와 baseline으로 품질·토큰·지연까지 평가
- `gh-open-pr` — 전체 Plan Set을 하나의 integration PR로 정리

```text
$setup
  ↓
stakeholder-analysis → subdomain-candidates → ubiquitous-language
  → event-storming → subdomain-classification → bounded-context
  → requirements-fix → 확정된 requirements.md
  ↓
domain-model → aggregate-design → domain-service
  → application-service → integration-design → context-boundary → tactical-design.md
  ↓
spec-me → Product Spec → Architecture Spec
  ↓
to-ticket → Plan Set
  ↓
implement-wrapper → implement × N → code-review
  ↓
gh-open-pr → 사용자 Merge
```

버그처럼 원인을 먼저 찾아야 하는 작업은 `spec-me` 대신 `diagnosing-bugs`에서 시작한다.

---

## 주요 명령

직접 호출하는 Harness skill은 `$setup`, `$eli5`, `$orchestrator`, `$harness-update`다(Codex 기준, Claude Code는 `/` 접두). 요청을 `$orchestrator`에 자연어로 전달하면 내부 절차를 선택해 실행한다.

| 명령 | 용도 |
| --- | --- |
| `$setup` | context, model tier, tracker 초기 설정 |
| `$orchestrator <요청>` | 요청을 workflow에 연결하고 실행·리뷰·사용자 결정을 조율 |
| `$eli5 <주제>` | 복잡한 내용을 visual-first 방식으로 간단히 설명 |
| `$harness-update` | 현재 저장소에 설치된 Harness를 최신 릴리스로 업데이트하고 Doctor로 확인 |


내부 절차는 직접 호출하지 않는다. 필요한 단계는 orchestrator가 현재 workflow 상태와 요청 범위에 따라 선택한다.

---

## Workflow

### 1. `$setup`

처음 적용하는 repository를 Harness가 사용할 수 있게 준비한다.

- `CONTEXT.md`, `CONTEXT-MAP.md` 초기화
- 역할별 model / reasoning 설정
- workflow worktree를 만들 상위 디렉터리의 절대 경로 선택 (기본값: 프로젝트 옆 `<프로젝트명>-worktrees`)
- GitHub 또는 local-markdown tracker 설정
- `.harness/harness.yaml` 관리

선택한 위치는 `worktrees.directory`에 저장하며 새 workflow부터 적용한다. 기존 worktree는 Git에 등록된 위치에 그대로 남는다. 경로를 바꾸려면 `$setup`에서 새로 설정을 선택한다.

### 2. 요구사항 흐름

새 기능이면 `spec-me` 전에 아래 stage를 순서대로 실행한다. 모든 stage가 `docs/specs/<plan-set-id>/requirements.md`(living spec)를 이어서 채우고, 마지막 `requirements-fix`가 확정한다. 먼저 `stakeholder-analysis`가 요청 범위의 후보 요구사항을 모은다.

```text
사용자 요청
  ↓
전문가 관점 persona(도메인·보안) + 요청과 관련된 등록 stakeholder  (최대 3)
  ↓ 독립 라운드 1 → 같은 요청 문구에서 충돌할 때만 라운드 2
후보 요구사항(CAND) → 사용자가 하나씩 채택·기각·보류
  ↓
docs/specs/<plan-set-id>/stakeholder-analysis.md   persona 기록(참여자·후보·충돌·범위 밖 관찰)
docs/specs/<plan-set-id>/requirements.md           채택·확정한 항목의 초안
```

- 논의 대상은 요청 원문뿐이다. 요청이 이미 말한 범위는 후보가 아니라 업무 목적에 `요청 원문`으로 직접 적고, 후보는 요청이 정하지 않은 결정(행위자별 권한, 삭제의 전파, 예외 결과 등)만 구체 규칙으로 제안한다. 후보마다 `요청 앵커`(요청 원문 인용)가 있어야 하며, 앵커 없는 관찰은 접어서 참고용으로만 보여 준다.
- 채택한 후보와 확정한 업무 주체만 이후 `spec-me`의 요구사항이 된다. 요청 속 행위자를 자동으로 persona로 만들지 않는다.
- 요청이 기존 승인된 업무 하나 안의 변경이고 새 행위자·권한이나 규칙 충돌이 없으면 건너뛰고 사유를 기록한다.

#### Stakeholder 등록

이해관계자의 역할·목표·불편·제약·권한·용어·모르는 것은 사용자가 프로젝트 소유 카드 `docs/domain/stakeholders/SH-xx.md`로 직접 등록한다. 카드는 Git에 노출되는 프로젝트 문서이며 Harness가 대신 만들지 않는다.

```bash
node .codex/scripts/harness-stakeholder.mjs add          # 터미널에서는 대화형, 아니면 --role --goal 같은 플래그
node .codex/scripts/harness-stakeholder.mjs edit SH-01
node .codex/scripts/harness-stakeholder.mjs list [--json]
node .codex/scripts/harness-stakeholder.mjs validate
node .codex/scripts/harness-stakeholder.mjs remove SH-01
```

`role`과 목표 하나 이상만 필수이고 나머지는 `UNKNOWN`으로 둘 수 있다. 규제기관이나 외부 시스템처럼 사람이 아닌 제약 출처는 `--kind constraint-source`로 등록한다(persona로 실행하지 않고 제약만 전달). workflow worktree는 커밋된 파일만 보므로 workflow를 시작하기 전에 카드를 커밋한다. 형식 오류는 `harness-codex-doctor`가 `stakeholder_card_invalid`로 경고한다.

#### 이어지는 stage

| stage | 하는 일 | 사용자 질문 | 추가로 쓰는 문서 |
|---|---|---|---|
| `subdomain-candidates` | 업무(BIZ)를 나누고 서브도메인 후보(SD)로 묶는다. 기존 영역에 먼저 넣고 새 후보는 정말 따로 둘 때만 만든다 | 범위가 크게 갈리는 해석일 때만 | |
| `ubiquitous-language` | 후보 업무별로 혼동되는 말을 먼저 정해 용어 표(용어·뜻·쓰지 않을 말)를 만들고 문장을 통일한다. 최종 컨텍스트 소속은 `bounded-context`가 검증한다 | 결과를 바꾸는 뜻만 한 묶음 | `CONTEXT.md` |
| `event-storming` | 도메인 전문가 persona를 다시 실행해 업무별 행위자·명령·도메인 이벤트(과거형 업무 사실)·정책·외부 시스템·hotspot을 낸다. 요청 밖 기능은 범위 밖 관찰로 접는다 | hotspot을 한 묶음으로 | `diagrams/events/`의 SD별·서브도메인 간 PlantUML(`.puml`)과 렌더(`.svg`) |
| `subdomain-classification` | 이벤트 근거로 서브도메인 경계를 검증하고 core·supporting·generic으로 분류한다. 후보가 여기서 확정된다 | 구성과 분류 확인 한 묶음 | |
| `bounded-context` | 기존 컨텍스트에 먼저 넣고, 합친 안과 나눈 안을 `ddd-design` 경계 규칙으로 비교해 바운디드 컨텍스트를 정한다. 관계마다 통신 계약과 판단 소유자를 적는다 | 결과가 갈리는 경계만 한 묶음 | `CONTEXT-MAP.md`(accepted-target) |
| `requirements-fix` | 남은 빈칸을 한 번의 인터뷰로 채우고 coverage gate를 통과하면 `상태: fixed`로 확정한다. 승인 질문은 없고, 확정 뒤 변경은 사용자의 수정 지시로만 한다 | 빈칸만 한 묶음 | |

`stakeholder-analysis`가 생략을 판정하면 뒤 stage와 전술 설계 stage는 문서를 쓰지 않고 생략을 기록한 채 지나간다. 확정된 `requirements.md`는 `spec-me`가 사용자 결정으로 읽으며 Product Spec과 이후 단계는 그대로다. Architecture는 확정된 바운디드 컨텍스트를 다시 비교하지 않는다. 이벤트 다이어그램 렌더에는 Java와 Graphviz가 필요하고 렌더 실패는 stage 완료를 막는다.

#### 전술 설계 흐름

`requirements-fix`가 `fixed`로 확정한 뒤 `spec-me` 전에 아래 여섯 stage가 순서대로 `docs/specs/<plan-set-id>/tactical-design.md`를 이어서 채운다. 한 stage가 자기 절만 쓰고 앞 stage의 절은 읽기만 한다. 문서 이름은 흐름을 따르며 `domain-model` 같은 stage 이름은 파일이 아니라 stage를 가리킨다(`docs/architecture/domain-model.md`는 프로젝트의 모델 색인으로 다른 파일이다). 예전 Harness가 `domain-model.md`로 만든 진행 중 plan set은 실행기가 전술 stage를 준비할 때 `tactical-design.md`로 이름을 바꾸고(`git mv`와 같은 rename이며 다음 전술 stage commit에 포함, restart도 처리한다). 템플릿은 `.codex/internal-skills/domain-model/references/template.md`가 소유한다. Entity·Value Object 후보와 모델링 깊이, Aggregate와 일관성 결정, Domain Service, Application Service, 통합 설계와 컨텍스트 경계 절, 출처가 붙은 결정 이력을 담는다. 클래스 다이어그램은 아직 없다.

| stage | 하는 일 | 사용자 질문 | 추가로 쓰는 문서 |
|---|---|---|---|
| `domain-model` | 바운디드 컨텍스트와 맵을 확정 입력으로 받아 서브도메인 분류별 깊이(core 풍부, supporting 규칙에 필요한 만큼, generic 최소·외부 시스템)로 Entity·Value Object 후보를 정하고 모든 업무·규칙·이벤트를 모델에 대응시킨다. 기존 프로젝트면 이 stage만 `code-research`로 기존 모델을 `file:line`과 commit으로 기록한다 | 없음. 근거가 부족하면 `blocked`로 요구사항 수정을 가리킨다 | `docs/architecture/domain-model.md`(`accepted-target` 행) |
| `aggregate-design` | 함께 지켜야 하는 불변식으로 Aggregate를 묶고 다른 Aggregate는 ID로만 참조한다. 규칙은 Aggregate Root 메서드, Value Object의 규칙, Domain Service 중 자연스러운 소유자가 강제하며 상태와 생애주기가 없는 컨텍스트는 이유를 적고 Aggregate를 두지 않는다. Aggregate에 걸친 규칙은 같은 컨텍스트에서 한 연산이 함께 바꾸는 즉시 일관성이면 병합하고(읽기만 하는 Aggregate는 `조회 전용 Aggregate`에 적어 병합하지 않는다), 컨텍스트가 다른 Aggregate는 병합하지 않고(즉시면 `integration-design`이 동기 확인·호출로 기록) 최종 일관성을 허용하면 분리하며 결정을 출처와 함께 기록한다 | 요구사항이 일관성을 정하지 않을 때 한 묶음(선택지마다 업무 결과) | 같음 |
| `domain-service` | 어떤 Entity·Value Object도 소유하지 못하는 도메인 판단만 둔다. 조율·transaction·저장·외부 효과는 하지 않는다 | 없음 | 같음 |
| `application-service` | 호출 순서, transaction 경계(transaction마다 Aggregate 하나), Repository, 외부 효과를 정한다. 도메인 판단은 하지 않는다 | 없음 | 같음 |
| `integration-design` | 컨텍스트 맵의 관계(판단 소유자)와 일관성 결정에서 명령·응답·이벤트와 통신 방식을 정한다. Saga·Outbox는 최종 일관성으로 기록한 규칙에서만 검토한다 | 업무 결과를 바꾸는 통합 결정만 한 묶음 | 같음 |
| `context-boundary` | 관계 패턴, 코드 의존 형태와 경계 강제 방식을 근거에 따라 정하고 `CONTEXT-MAP.md`에 반영한다. 배포 방식·프레임워크는 정하지 않는다 | 근거가 선택지를 가르지 못할 때만 질문 | 같음 |

- gate는 한 번만 돌고 stage는 돌리지 않는다. `domain-model`·`aggregate-design`·`domain-service`·`application-service`·`integration-design`은 gate 없이 `completed/OK`로 받아들이고, 마지막 `context-boundary`가 `completed/OK`를 반환할 때 실행기가 `tactical-design.md` 전체를 `node .codex/scripts/harness-domain-model-check.mjs --workspace-root <workspace_root>`와 같은 검사로 확인한다(`harness-native-stage.mjs finish`와 상태 기록). 통과하지 못하면 commit·기록 없이 `gate_error`로 되돌린다. 발견 사항마다 `owner_stage`가 잘못된 절을 채운 stage를 가리킨다. `context-boundary` 자신의 절이면 같은 서브에이전트가 고치고, 앞 stage의 절이면 서브에이전트가 `blocked` / `DEPENDENCY_INCOMPLETE`로 그 stage를 가리키며 사용자가 `--restart-requirements`나 `--user-revision`으로 다시 연다. `판정: 생략` 흐름은 문서 없이 통과한다. gate는 반드시 성립해야 하는 기존 여섯 조건과, section 5의 통합 행마다 완전하고 출처가 있는 section 6 경계 결정이 있는지 확인한다. 문서와 `## 1`~`## 6` 절이 있는지, 모든 업무가 모델 또는 외부 시스템 표시에 대응하고 모든 규칙에 소유 모델이 있는지, 모든 규칙에 비어 있지 않은 강제 행위(Aggregate·Entity 메서드, Value Object의 규칙, Domain Service, 외부 시스템 중 어떤 형태든)가 있는지, 둘 이상의 Aggregate에 걸친 규칙이 `즉시`나 `최종`이며 에이전트 제안만이 아닌 출처가 있는 일관성 결정(`CON-xx`)을 인용하는지, 한 transaction이 Aggregate 하나만 바꾸는지, Saga·Outbox가 `최종` 결정에 묶인 통합 행에만 있는지다. 표는 키 열로 찾고 모르는 열은 무시한다. 경계 결정의 DDD 적합성, 병합과 `조회 전용 Aggregate`, Root의 종류, Entity 배치, Domain Service·Application Service·통합 행의 충분성 같은 맥락적 DDD 판단은 gate가 아니라 stage GUIDE와 리뷰가 맡는다.
- 질문이나 설계 중 새 업무 규칙·예외가 나오면 stage가 `requirements.md`에 INV·EX·AC로 덧붙인다. 앞 stage의 결정이 무효가 되면 덮어쓰지 않고 `blocked`로 반환하고, 사용자가 `--restart-requirements` 또는 `--user-revision`으로 앞 stage를 다시 연다. 흐름 순서는 실행기가 확인한다. 앞 stage가 `completed/OK`가 아니면 준비기와 `harness-native-stage.mjs start`가 `spec-me`와 뒤 stage를 거부하며, 이전 Harness가 순서를 어기고 남긴 결과 없는 stage는 종료를 확인한 뒤 `harness-prepare-input.mjs --stage-id <stage> --discard-out-of-order true`로 되돌린다.
- `docs/architecture/domain-model.md`와 `CONTEXT.md`는 프로젝트 소유 문서이며 Git에 노출된다. stage가 변경을 artifact로 보고했을 때만 실행기가 plan set 문서와 함께 commit한다.
- 전술 설계 결과를 `spec-me`가 어떻게 읽는지는 아직 정하지 않았다.

### 3. `spec-me`

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

### 4. `to-ticket`

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

### 5. `implement-wrapper`

orchestrator가 Plan의 dependency와 shared resource로 실행 순서를 정하고, 각 worker는 선택된 Plan 하나를 구현한다.

```text
독립 Plan      → 병렬 실행 가능
resource 충돌 → 순차 실행
dependency     → 선행 Plan 완료까지 대기
```

Plan마다 새로운 `implementation_agent`를 사용한다. setup에서 확인한 `.codex/context-budget.json`의 수치로 to-ticket은 계획을 분할하고 orchestrator는 실행 중 인계 여부를 판단한다.

### 6. `implement`

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

### 7. `code-review`

같은 diff를 두 개의 독립 reviewer가 검증한다.

```text
Implementation Diff
      ├─ standards_reviewer → Product Spec + repository rules
      └─ spec_reviewer      → Architecture Spec
```

둘 중 하나라도 unresolved이면 Plan을 완료 처리하지 않는다.

### 8. `gh-open-pr`

Child Plan마다 PR을 만들지 않고 **Plan Set 하나당 integration PR 하나**를 사용한다.

모든 Plan의 구현과 검증이 끝나면 기존 draft plan PR을 implementation PR로 갱신하거나 새 integration PR을 만든다. Harness는 자동 merge하지 않는다.

### 9. `frontend-design`

기존 구현 workflow와 분리된 프런트엔드 전용 흐름이다.

```text
Reference / current UI
  ↓
Frontend design brief
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

### 10. `evaluate-harness`

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

`meta-harness-pilot`은 Codex 구독으로 Harness 동작을 점검하는 8-case suite다. 자체 4개 파일 중심 사례에 기존 `p0` 기준선의 `spec-me-ambiguity-gate`, `implement-wrapper-dependency`, `code-review-isolation`을 재사용해 범위를 넓혔다. 초기 `baseline: null` 상태에서는 품질·정책 verdict와 절대 비용만 보고하며 회귀율은 계산하지 않는다. subagent 축은 격리된 reviewer spawn이 불가능할 때 올바르게 차단하는 `code-review-isolation` 동작만 측정한다.

```sh
node bin/harness-eval.mjs run --suite meta-harness-pilot
```

---

## Skill Catalog

사용자가 직접 시작하는 스킬은 `.codex/skills/`에 두며, 내부 절차는 `.codex/internal-skills/`에 둔다.

### Workflow / entrypoint

| Skill | 역할 |
| --- | --- |
| [`setup`](.codex/skills/setup/SKILL.md) | repository 초기 설정 |
| [`orchestrator`](.codex/skills/orchestrator/SKILL.md) | subagent skill 실행과 파일 기반 결과·상태 전이 조율 |

내부 작성·모델링·리뷰·구현 절차는 `.codex/internal-skills/*/GUIDE.md`에 있으며 상위 workflow/agent가 읽는다. 사용자 공개 스킬 목록에는 등록하지 않는다.

### Interview / validation / utility

| Skill | 역할 |
| --- | --- |
| [`eli5`](.codex/skills/eli5/SKILL.md) | visual-first 간단 설명 |
| [`harness-update`](.codex/skills/harness-update/SKILL.md) | 설치된 Harness 런타임 업데이트 진입점 |

---

## Agent Profiles

`.codex/agents/`의 agent profile은 역할을 분리한다.

| Agent | 책임 |
| --- | --- |
| `code_researcher` | 코드베이스 조사 |
| `stakeholder_persona` | 카드 하나(stakeholder 또는 전문가 관점)로 요청의 후보 요구사항 제안, `event-storming`에서는 도메인 관점으로 업무별 이벤트 추출 |
| `spec_document_writer` | 확정된 Spec 문서화 |
| `diagram_creator` | PlantUML / SVG 생성 |
| `to_ticket` | vertical plan 작성 |
| `frontend_designer` | reference-grounded visual direction과 frontend brief 작성 |
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
  특정 변경의 requirements.md(요구사항 흐름) / Product / Architecture 결정
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

Codex의 공개 Harness skill 호출과 repository 관리 CLI는 별개다.

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

설치할 agent provider를 고를 수 있다. 기본값 `all`은 Codex와 Claude Code를 모두 설치한다.

워크플로 stage는 현재 CLI(Codex 또는 Claude Code)의 서브에이전트로 실행하고 해당 도구에서 완료를 기다린다. stage마다 별도 CLI 프로세스를 띄우지 않으며, 서브에이전트는 오케스트레이터 세션 안에서만 실행된다.

```bash
npx --yes github:omegafrog/harness-codex install --provider codex        # .agents/skills, Codex hook, 공용 .codex 자산
npx --yes github:omegafrog/harness-codex install --provider claude-code  # .claude/** (skills, agents, provider 코드, hook), 공용 .codex 자산
```

Claude Code provider 코드(adapter, orchestrator launcher·시작 hook, hook 설치기)는 소스의 `.claude/harness/`에 있고 설치 대상의 같은 경로에 설치된다. `update`는 설치된 provider를 유지하며, `update --provider <값>`을 주면 설치 구성을 바꾸고 빠진 provider의 관리 파일은 백업 후 제거한다. `$setup`은 설치된 provider만 선택지로 보여 주고, workflow binding은 setup이 정한 provider와 같아야 한다.


**메인 세션 쓰기 가드.** workflow worktree의 메인 orchestrator 세션은 제품 코드·테스트·Spec·계획·`docs/contracts/`를 직접 쓰지 않고 소유 stage에 맡긴다. PreToolUse hook(`.codex/scripts/harness-write-guard.mjs`)이 이를 집행한다. Codex는 `$setup`이 `~/.codex/hooks.json`에 "Guarding Harness orchestrator writes"를 등록하며 `/hooks`에서 신뢰해야 동작하고, Claude Code는 설치기가 `.claude/settings.local.json`의 `PreToolUse`(`Edit|Write|MultiEdit|NotebookEdit|Bash`)에 등록한다. `update`는 Claude 등록을 복구하고 Codex 사용자 hook이 없거나 신뢰되지 않았으면 안내하며 Doctor가 같은 상태를 보고한다. `.io/`와 `docs/agents/`의 지침·실행 문서만 쓸 수 있고, stage 실행기와 하위 agent의 쓰기는 막지 않는다. `apply_patch`·Edit·Write와 리다이렉션·`tee`·`sed -i` 등 대상이 글자로 보이는 셸 쓰기만 판별하며, 스크립트·인터프리터·포매터가 내부에서 쓰는 파일과 MCP 파일 도구는 볼 수 없다.

설치가 끝나면 Codex CLI에서 `$setup`을 실행한다. 모델·effort·tracker·관측성 선택은 Codex 내부의 네이티브 선택 UI에서 제출하며 별도 터미널이나 설치기 메뉴를 열지 않는다. 스킬은 `harness-setup.mjs --answers`가 한 번에 반환하는 질문 전체를 한 화면에서 전달하고, 제출한 답만 session JSON에 보존해 적용한다. 선행 답이 바뀌어 맞지 않게 된 질문만 다시 묻는다. 입력 대기 중인 숨은 PTY를 만들지 않는다. 이 단계에서 프로젝트별 `.harness/harness.yaml`, 컨텍스트·트래커 설정과 Beads 보드 사용 여부를 정한다. Harness 설치기는 `bd` CLI가 없으면 `npm install --global @beads/bd`로 설치를 시도한다. 자동 설치가 실패하면 같은 명령을 사용자가 직접 실행하면 된다.

로컬 관측성은 **OpenTelemetry Collector → VictoriaLogs**, **Actuator → VictoriaMetrics**, **공식 MCP 두 개 → 에이전트**로 구성한다. 프로젝트의 `node .codex/scripts/harness-setup.mjs --root <절대 경로>` CLI가 사용 여부·로그/메트릭 포트·보존 기간·OTLP HTTP 포트·여러 프로젝트/서비스의 앱·컨테이너 기준 Actuator URL을 수집하고 compose·Collector·scrape·provider-neutral MCP 설정·실행 profile을 준비한다. 기본 포트는 Logs 9428, Metrics 8428, OTLP 4318이며 모두 loopback으로 제한한다. Docker bridge를 사용하며 host 공개 포트만 loopback에 제한한다. WSL 앱→Collector는 공개 localhost, Metrics→WSL 앱은 컨테이너의 host.docker.internal 주소를 사용하고 내부 수집·MCP는 service DNS로 연결한다. `victorialogs-local-setup` 스킬이 기존 Spring 개발 profile에 OTel SDK/appender 또는 외부 Java agent와 개발용 Actuator/Prometheus registry를 연결한다. production artifact에는 개발 의존성을 넣지 않는다. 진단 v1 schema·오프라인 검사와 workspace별 구현/테스트 메모리 지침도 배포한다. 데이터와 queue는 원본 프로젝트 session 내부에 보존하며 setup 자체는 서버를 시작하지 않는다. [배포 안내](.codex/internal-skills/victorialogs-local-setup/assets/README.md)를 따른다.

Beads 보드는 프로젝트별로 한 번 초기화하며, 기존 `.beads` 데이터나 원격 데이터가 있으면 새 데이터베이스를 만들지 않고 기존 보드를 보존한다. 같은 저장소의 linked worktree는 Beads 데이터베이스를 자동으로 공유하므로 worktree마다 초기화할 필요가 없다. 기존 원격 데이터가 있으면 `$setup`이 `bd bootstrap`으로 채택하고, 원격 migration은 한 clone만 수행해야 한다.

설치되는 핵심 런타임은 다음과 같다.

```text
.agents/skills/*                 Codex skill 사본
.codex/agents/*                  Harness agent profile
.codex/workflows/*               workflow 정의
.codex/schemas/*                 workflow schema
.codex/scripts/*                 workspace 및 lifecycle script
.codex/harness-lock.json         설치 기준선과 파일 hash
```

필요한 부분만 설치하는 경우에는 최초 설치에서만 `--skills-only` 또는 `--agents-only`를 사용할 수 있다. 기존 스킬·supporting files·agent·workflow·runtime·관리 PR 템플릿을 Harness 버전으로 교체하려면 `install --force` 또는 `update`를 사용한다. 덮어쓸 파일은 먼저 session_directory/runtime/installer-backups/ 아래에 백업하며 CLI가 위치를 출력한다. `.harness/harness.yaml`과 프로젝트 업무 문서는 교체하지 않는다. install을 다시 실행해도 force가 없으면 로컬 수정을 보존하며 lock 기준선을 임의로 승인하지 않는다.

### 업데이트

먼저 대상 프로젝트의 작업 트리가 깨끗한지 확인하고, 필요한 경우 변경사항을 commit 또는 stash한다. 그 다음 설치 때와 같은 방식으로 최신 Harness를 실행한다.

```bash
cd /path/to/your-project
npx --yes github:omegafrog/harness-codex update

# 또는 다른 디렉터리에서
npx --yes github:omegafrog/harness-codex update --project /path/to/your-project
```

이 버전으로 새로 설치하거나 한 번 업데이트한 프로젝트에서는 Codex에게 `하네스 업데이트해` 또는 `Harness 업그레이드해`라고 요청해도 된다. 함께 설치되는 `harness-maintenance` skill이 현재 Git worktree의 lock 파일을 확인한 뒤, 위 업데이트와 진단을 수행한다. 아직 이 skill이 없는 기존 설치본은 이 명령을 한 번 직접 실행해 업데이트해야 한다. 아직 설치 기준선이 없는 checkout에서는 설치를 임의로 대신 실행하지 않고 이를 알린다.

설치·ticket 동기화·workflow 재개·worktree 문제로 Harness를 실행할 수 없으면 자연어로 `$orchestrator`에 복구를 요청한다. 내부 `harness-recover` 절차가 먼저 읽기 전용 진단을 수행한다. 먼저 읽기 전용으로 진단하고, 파일·ticket·상태·worktree 변경은 구체적인 복구안을 제시해 사용자 확인을 받은 뒤 수행한다. 새 설치와 업데이트에 함께 배포된다.

업데이트는 `.codex/harness-lock.json`의 설치 기준선을 사용한다.

- Harness가 설치한 뒤 프로젝트에서 바꾸지 않은 관리 파일은 최신 버전으로 갱신한다.
- 새로 추가된 관리 파일은 추가한다.
- 프로젝트에서 수정한 파일은 덮어쓰지 않고 `Preserved`로 보고한다. `locally_modified`는 로컬 변경만, `conflict`는 로컬과 Harness 양쪽에 변경이 있다는 뜻이다.
- `$setup`이 소유하는 `.harness/harness.yaml`은 자동으로 추가·교체하지 않는다.

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

`install`과 `update`는 `.agents/`, `.codex/`, `skills-lock.json`을 해당 저장소의 `.git/info/exclude`에 추가한다. 이는 로컬 checkout에만 적용되며 저장소의 `.gitignore`를 바꾸지 않는다. 계약 검사기 `.harness/contracts.mjs`와 CI workflow `.github/workflows/harness-contracts.yml`도 같은 방식으로 ignore된다. CI 검사를 도입하는 프로젝트만 두 파일을 `git add -f`로 명시적으로 커밋한다.

이미 Git이 추적하는 Harness 런타임 파일은 exclude만으로 untrack되지 않는다. 먼저 추적 대상을 확인하고, 팀 정책상 로컬 런타임으로 전환할 파일만 명시적으로 추적 해제한다. 기존 프로젝트별 Codex 설정까지 일괄 추적 해제하지 않도록 주의한다.

```bash
git ls-files .agents .codex
git rm --cached .codex/agents/<managed-profile>.toml
```

공유할 프로젝트 지침과 결정은 `AGENTS.md`, ADR, 도메인 문서에 보관한다. stakeholder 카드(`docs/domain/stakeholders/`)는 프로젝트 소유 문서이므로 제외되지 않고 Git에 보이며, 설치·업데이트가 만들거나 고치지 않는다. Harness 런타임은 checkout마다 설치·업데이트하고, 서버·인프라 실행 지침은 `docs/agents/EXEC.md`에 둔다.

설치/업데이트는 번들에 포함된 스킬을 직접 복사하며 별도 `npx skills` 설치에 의존하지 않는다. `update`는 Harness 관리 경로를 항상 최신 릴리스와 같게 맞춘다. 로컬에서 수정한 관리 파일은 백업한 뒤 최신본으로 교체하고, upstream에서 사라진 관리 자산은 수정 여부와 관계없이 백업한 뒤 삭제하며 lock 항목과 빈 디렉터리(구 `.codex/harness-runtime` 포함)도 정리한다. `--no-backup`이면 백업하지 않는다. `install`은 `--force` 없이는 로컬 수정을 보존한다. 이전 업데이트가 남긴 빈 Harness skill 디렉터리도 함께 지우며, Harness가 모르는 이름의 skill 디렉터리는 건드리지 않는다. PR 템플릿은 관리 자산이며 기존 사용자 템플릿도 기본 보존/force 백업 규칙을 따른다.

설치·업데이트는 `Project readiness`를 별도로 보고한다. `project_preparation_required`이면 caller가 setup의 준비 복구와 내부 `sync-contracts` 절차로 실제 소스/CI/실행 지침을 조사해 실행 프로필·통합 계약을 보완하고 doctor를 재실행한다. 직접 구현은 `harness-workspace-preflight.mjs --workspace-root <workspace_root> --for-implementation --json`, wrapper dispatch는 같은 실제 gate를 통과해야 시작한다. 파일 누락을 구현 커밋 뒤까지 미루거나 빈 manifest로 완료 검사를 우회하지 않는다.

## 진행 상황 보기

agent 없이 실행 기록만 읽는 읽기 전용 명령이다. 작업 worktree(또는 프로젝트) 디렉터리에서 실행한다.

```bash
node .codex/scripts/harness-progress.mjs            # 한 번 출력
node .codex/scripts/harness-progress.mjs --watch    # 3초마다 갱신 (--watch 5 처럼 초 지정)
```

단계별 상태·경과 시간·회차·대기 사유를 보여 주고, 실행 중인 stage 아래에 하위 agent(reviewer)와 그 stage agent의 마지막 명령·메시지를 한 줄로 보여 주며(Codex 대화 기록을 읽음), `running`인데 실행기 프로세스가 없으면 "정지됨"으로 표시한다. 기록된 단계만 집계하므로 전체 진행률(%)은 계산하지 않는다.
