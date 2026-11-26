# Harness Codex

**Codex 개발을 요구사항 → 설계 → 구현 → 검증 → PR 흐름으로 구조화하는 project-local workflow harness.**

공개 Harness skill은 `$setup`, `$orchestrator`, `$eli5`, `$harness-update` 네 개다(Claude Code에서는 `/setup`, `/orchestrator`, `/eli5`, `/harness-update`). 자연어 유지보수·복구, 버그 분석·수정, 지식·평가, 프런트엔드, 리뷰·PR, 검증 요청은 orchestrator가 관련 내부 GUIDE로 라우팅한다.

주요 workflow 단계:

- `$orchestrator` — 모델·effort를 지정한 subagent로 skill을 실행하고 상태 코드·결과 파일로 workflow 진행과 회귀를 결정
- 최초 작업 요청은 `UserPromptSubmit` hook이 메인 orchestrator에 전달하며, `workflow-compose` subagent가 요청별 workflow를 생성한 뒤 작업 skill을 실행한다.
- 요구사항 흐름 — 새 기능이면 `stakeholder-analysis` → `subdomain-candidates` → `ubiquitous-language` → `event-storming` → `subdomain-classification` → `requirements-fix` → `bounded-context`가 하나의 `requirements.md`를 단계별로 채워 확정
- 전술 설계 흐름 — 확정된 요구사항 뒤 `domain-model` → `aggregate-design` → `domain-service` → `application-service` → `integration-design` → `context-boundary`가 하나의 `tactical-design.md`를 단계별로 채우고 소유 부분을 완료 전에 검사하며, 마지막 stage에서 문서 전체를 검사
- 구현 흐름 — 완료된 tactical design 뒤 `tactical-technology` → `tactical-ui` → `tactical-api` → `tactical-data` → `to-ticket` → (사용자 발행 승인) `tracker-publish` → `tactical-code` 순서로 결정·ticket 분할·발행·ticket별 구현과 테스트; 실제 UI는 별도 `frontend-design` workflow가 소유
- `to-ticket` — 완료된 tactical design과 구현 결정을 바운디드 컨텍스트·업무별 vertical ticket(의존 순서, 소유 규칙과 검증 테스트, 컨텍스트 경계 포함)으로 분할하고 독립 리뷰
- `implement-wrapper` — Spec 기반 legacy 계획에서 orchestrator가 선택한 승인 Plan 하나를 구현하고 단위 테스트·실행 근거를 반환
- `implement` + `code-review` — test-first 구현 후 Product / Architecture 두 축으로 독립 검증
- `diagnosing-bugs` — regression과 장애를 재현 → 원인 분석 → 수정 → 회귀 테스트
- `frontend-design` — reference-first UI 설계 → 전용 구현 → browser visual review → correction loop
- `evaluate-harness` — Harness 변경을 eval suite와 baseline으로 품질·토큰·지연까지 평가
- `gh-open-pr` — 전체 Plan Set을 하나의 integration PR로 정리

```text
$setup
  ↓
stakeholder-analysis → subdomain-candidates → ubiquitous-language
  → event-storming → subdomain-classification → requirements-fix
  → bounded-context → 확정된 requirements.md
  ↓
domain-model → aggregate-design → domain-service
  → application-service → integration-design → context-boundary → tactical-design.md
  ↓
tactical-to-code: tactical-technology → tactical-ui → tactical-api → tactical-data
  → to-ticket → (사용자 승인) tracker-publish → tactical-code (ticket별)
  ↓
gh-open-pr → 사용자 Merge
```

버그처럼 원인을 먼저 찾아야 하는 작업은 `diagnosing-bugs`에서 시작한다.

전술 설계가 완료되면 별도 `tactical-to-code` workflow로 구현을 진행한다. 기존 stack을 먼저 검토하고 API와 storage는 적용될 때만 결정한 뒤, 그 결정과 전술 설계를 컨텍스트·업무별 ticket으로 나누어 사용자 승인 뒤 발행하고 ticket을 의존 순서대로 하나씩 구현한다. 화면이 요청에 포함되면 기존 `frontend-design` workflow를 독립 실행하고 결과를 handoff한다. 이 workflow는 요구사항 재시작 흐름과 분리되어 있어 application code를 재설정하지 않는다.

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

새 기능이면 아래 요구사항 stage를 순서대로 실행한다. 모든 stage가 `docs/specs/<plan-set-id>/requirements.md`(living spec)를 이어서 채우고, 마지막 `bounded-context`가 확정한다. 확정 뒤 orchestrator가 확정된 요구사항을 보여 주고, 사용자가 승인해야 전술 설계(`domain-model`)로 넘어간다(실행기가 사용자 입력 기록으로 확인). 먼저 `stakeholder-analysis`가 요청 범위의 후보 요구사항을 모은다. 요청자도 stakeholder(`REQUESTER`)이므로 요청에 적은 기능은 포함 여부를 묻지 않는 확정 요구사항이고, 내용이 정해지지 않은 기능만 내용을 묻는다. 질문 제목은 어느 stakeholder에서 왔는지(`[제안: 도메인 전문가(LENS-DOMAIN)]`) 보여 준다. 사용자 결정 질문은 이미 정해진 규칙과 지금 정해야 하는 이유, 선택지마다 화면·동작이 달라지는 점과 같은 상황에 적용한 예시(설명용이며 요구사항이 아님)를 함께 보여 준다.

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
- 채택한 후보와 확정한 업무 주체만 구현 요구사항이 된다. 요청 속 행위자를 자동으로 persona로 만들지 않는다.
- 요청이 기존 승인된 업무 하나 안의 변경이고 새 행위자·권한이나 규칙 충돌이 없으면 건너뛰고 사유를 기록한다.

#### Stakeholder 등록

이해관계자의 역할·목표·불편·제약·권한·용어·모르는 것은 사용자가 프로젝트 소유 카드 `docs/domain/stakeholders/SH-xx.md`로 직접 등록한다. 카드는 Git에 노출되는 프로젝트 문서이며 Harness가 대신 만들지 않는다.

```bash
node .harness/scripts/harness-stakeholder.mjs add          # 터미널에서는 대화형, 아니면 --role --goal 같은 플래그
node .harness/scripts/harness-stakeholder.mjs edit SH-01
node .harness/scripts/harness-stakeholder.mjs list [--json]
node .harness/scripts/harness-stakeholder.mjs validate
node .harness/scripts/harness-stakeholder.mjs remove SH-01
```

`role`과 목표 하나 이상만 필수이고 나머지는 `UNKNOWN`으로 둘 수 있다. 규제기관이나 외부 시스템처럼 사람이 아닌 제약 출처는 `--kind constraint-source`로 등록한다(persona로 실행하지 않고 제약만 전달). workflow worktree는 커밋된 파일만 보므로 workflow를 시작하기 전에 카드를 커밋한다. 형식 오류는 `harness-codex-doctor`가 `stakeholder_card_invalid`로 경고한다.

#### 이어지는 stage

| stage | 하는 일 | 사용자 질문 | 추가로 쓰는 문서 |
|---|---|---|---|
| `subdomain-candidates` | 업무(BIZ)를 나누고 서브도메인 후보(SD)로 묶는다. 기존 영역에 먼저 넣고 새 후보는 정말 따로 둘 때만 만든다 | 범위가 크게 갈리는 해석일 때만 | |
| `ubiquitous-language` | 후보 업무별로 혼동되는 말을 먼저 정해 용어 표(용어·뜻·쓰지 않을 말)를 만들고 문장을 통일한다. 최종 컨텍스트 소속은 `bounded-context`가 검증한다 | 결과를 바꾸는 뜻만 한 묶음 | `CONTEXT.md` |
| `event-storming` | 도메인 전문가 persona를 다시 실행해 업무별 행위자·명령·도메인 이벤트(과거형 업무 사실)·정책·외부 시스템·hotspot을 낸다. 요청 밖 기능은 범위 밖 관찰로 접는다 | hotspot을 한 묶음으로 | `diagrams/events/`의 SD별·서브도메인 간 PlantUML(`.puml`)과 렌더(`.svg`) |
| `subdomain-classification` | 업무와 이벤트를 근거로 유지·분리 대안을 비교하고 core·supporting·generic 분류를 정한다 | 경계 선택과 분류는 각각 확인 | |
| `requirements-fix` | 남은 빈칸을 한 번의 인터뷰로 채우고 coverage gate(컨텍스트 소속 제외)를 통과시킨다. 경계를 정하기 전에 요구사항을 완성하려고 `bounded-context` 앞에서 실행하며, 문서는 `draft`로 둔다 | 빈칸만 한 묶음 | |
| `bounded-context` | 완성된 요구사항으로 기존 컨텍스트에 먼저 넣고, 합친 안과 나눈 안을 `ddd-design` 경계 규칙으로 비교해 바운디드 컨텍스트를 정한다. 관계마다 통신 계약과 판단 소유자를 적고, coverage gate 전체를 통과하면 `상태: fixed`로 확정하며 공통 정의를 동기화한다. 승인 질문은 없고, 확정 뒤 변경은 사용자의 수정 지시로만 한다 | 결과가 갈리는 경계만 한 묶음 | `CONTEXT-MAP.md`(accepted-target) |

`stakeholder-analysis`가 생략을 판정하면 뒤 stage와 전술 설계 stage는 문서를 쓰지 않고 생략을 기록한 채 지나간다. 확정된 `requirements.md`와 바운디드 컨텍스트는 이후 전술 설계 및 구현의 입력이다. 이벤트 다이어그램 렌더에는 Java와 Graphviz가 필요하고 렌더 실패는 stage 완료를 막는다.

#### 전술 설계 흐름

`bounded-context`에서 확정한 요구사항을 사용자가 승인하면, 아래 여섯 stage가 `docs/specs/<plan-set-id>/tactical-design.md`의 BC별 구성요소를 설계하고 검토한다. 각 stage 결과는 사용자가 승인해야 다음 stage(마지막은 `tactical-technology`)가 시작된다. `domain-model`은 stage 이름이며 `docs/architecture/domain-model.md`는 프로젝트 모델 색인이다. 진행 중인 구형 문서는 설치나 업데이트 때 그대로 보존한다. 템플릿은 `.harness/internal-skills/domain-model/references/template.md`에 있다.

| stage | 하는 일 |
|---|---|
| `domain-model` | 같은 대상을 계속 식별해야 하는 근거를 확인하고 Entity 식별자·필드·메서드, VO 구성 값·제약을 선언한다. 기존 모델 근거는 코드와 확인한 commit을 연결한다 |
| `aggregate-design` | Aggregate Root, 내부 Entity·VO와 다른 Aggregate의 ID 참조를 정리하고 클래스 다이어그램을 만든다. 요구사항과 사용자 답을 대조해 모델에 규칙과 불변식을 연결한다 |
| `domain-service` | Entity나 VO에 두기 어려운 도메인 판단을 맡는 서비스와 메서드를 정의한다 |
| `application-service` | 업무를 수행하는 메서드마다 도메인 호출·저장·외부 효과 순서, 시작·커밋·롤백, 필요한 포트와 실패 결과를 기록한다 |
| `integration-design` | Application Service가 사용하는 상대 BC의 공개 계약, 동기 응답과 비동기 반응을 대조하고 빠진 설계를 소유 stage로 돌려보낸다 |
| `context-boundary` | BC별 구성과 의존 경로를 확정 경계·데이터 소유권에 대조하고 최종 검증을 요청한다 |

- 장기 보관할 결정은 프로젝트의 `docs/adr/`를 사용한다. 관련 모델·메서드에서 ADR의 근거로 이동할 수 있다. 클래스 다이어그램과 ADR, 프로젝트 모델 문서는 Git으로 추적한다.
- 마지막 `context-boundary`가 `completed/OK`를 반환하면 실행기가 `harness-domain-model-check.mjs`로 설계 전체를 검사한다. 검사에 실패하면 작성한 stage를 `owner_stage`로 알려 주는 `gate_error`를 반환한다. 업무 규칙의 의미와 모델 선택 근거는 각 stage와 리뷰에서 확인한다.
- 요구사항 변경은 가장 이른 소유 stage에서 재개한다. 기존 파일과 유효한 결정은 보존하고 영향받는 산출물을 갱신한다. 사용자가 변경된 확정 요구사항을 승인한 뒤 전술 설계를 재개하며, 다시 실행한 설계 stage의 결과도 새로 승인한다.
- `tactical-to-code`의 구현 설계는 포트별 인터페이스·구현체 경로, 기술과 조립 지점을 정한다. 마지막 `tactical-data`의 `harness-design-freeze-check.mjs`가 업무 연결과 인프라 구현 연결을 확인하면 `to-ticket`이 시작할 수 있다. 설계 결함은 `DESIGN_NOT_FROZEN`으로 보고한다.

### 3. `to-ticket`

완료된 tactical design과 구현 결정(technology·UI·API·data)을 구현 가능한 **vertical slice**로 나눈다. 한 ticket은 한 바운디드 컨텍스트가 소유한 업무(BIZ) 하나다.

```text
❌ Entity → Repository → Service → Controller

✅ 실패 횟수 기록 + 잠금 전이
✅ 잠긴 계정 로그인 차단
✅ 관리자 잠금 해제
```

각 ticket에는 소유 INV/EX/AC와 강제 위치·검증 테스트, 접하는 컨텍스트의 공개 계약과 호출 포트, 데이터 소유권 및 구현체 연결, 의존한 결정, 선행 ticket, 완료 기준이 포함된다. 상류 컨텍스트의 공개 API ticket이 하류 소비 ticket보다 먼저 온다. 계획은 독립 리뷰를 통과한 뒤 사용자가 직접 승인해야만 발행된다.

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

Plan마다 새로운 `implementation_agent`를 사용한다. setup에서 확인한 `.harness/context-budget.json`의 수치로 to-ticket은 계획을 분할하고 orchestrator는 실행 중 인계 여부를 판단한다.

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

`meta-harness-pilot`은 Codex 구독으로 Harness 동작을 점검하는 14-case suite다. 자체 4개 파일 중심 사례와 공개 skill-routing 8개 사례에 기존 `p0` 기준선의 `implement-wrapper-dependency`, `code-review-isolation`을 재사용해 범위를 넓혔다. 초기 `baseline: null` 상태에서는 품질·정책 verdict와 절대 비용만 보고하며 회귀율은 계산하지 않는다. subagent 축은 격리된 reviewer spawn이 불가능할 때 올바르게 차단하는 `code-review-isolation` 동작만 측정한다.

```sh
node bin/harness-eval.mjs run --suite meta-harness-pilot
```

---

## Skill Catalog

사용자가 직접 시작하는 스킬은 `.codex/skills/`에 두며, 내부 절차는 `.harness/internal-skills/`에 둔다.

### Workflow / entrypoint

| Skill | 역할 |
| --- | --- |
| [`setup`](.codex/skills/setup/SKILL.md) | repository 초기 설정 |
| [`orchestrator`](.codex/skills/orchestrator/SKILL.md) | subagent skill 실행과 파일 기반 결과·상태 전이 조율 |

내부 작성·모델링·리뷰·구현 절차는 `.harness/internal-skills/*/GUIDE.md`에 있으며 상위 workflow/agent가 읽는다. 사용자 공개 스킬 목록에는 등록하지 않는다.

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
| `tactical_designer` | 확정된 전술 설계에서 기술·UI handoff·API·data 결정 정리 |
| `tactical_implementation_agent` | 확정된 전술 설계와 결정에서 code·test 구현 |
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
npx --yes github:omegafrog/harness-codex install --provider codex        # .codex, 공용 .harness 자산
npx --yes github:omegafrog/harness-codex install --provider claude-code  # .claude/** (skills, agents, provider 코드, hook), 공용 .harness 자산
```

Codex와 Claude Code의 provider 코드는 각각 `.codex/harness/`와 `.claude/harness/`에 설치된다. Claude Code만 설치해도 workflow 실행기가 역할과 sandbox 정책을 검사하는 데 쓰는 `.codex/agents/*.toml`은 포함된다. `update`는 설치된 provider를 유지하며, `update --provider <값>`을 주면 설치 구성을 바꾸고 빠진 provider의 관리 파일은 백업 후 제거한다. `$setup`은 설치된 provider만 선택지로 보여 주고, workflow binding은 setup이 정한 provider와 같아야 한다.


**메인 세션 쓰기 가드.** workflow worktree의 메인 orchestrator 세션은 제품 코드·테스트·Spec·계획·`docs/contracts/`를 직접 쓰지 않고 소유 stage에 맡긴다. PreToolUse hook(`.harness/scripts/harness-write-guard.mjs`)이 이를 집행한다. Codex는 `$setup`이 `~/.codex/hooks.json`에 "Guarding Harness orchestrator writes"를 등록하며 `/hooks`에서 신뢰해야 동작하고, Claude Code는 설치기가 `.claude/settings.local.json`의 `PreToolUse`(`Edit|Write|MultiEdit|NotebookEdit|Bash`)에 등록한다. `update`는 Claude 등록을 복구하고 Codex 사용자 hook이 없거나 신뢰되지 않았으면 안내하며 Doctor가 같은 상태를 보고한다. `.io/`와 `.harness/agents/`의 지침·실행 문서만 쓸 수 있고, stage 실행기와 하위 agent의 쓰기는 막지 않는다. `apply_patch`·Edit·Write와 리다이렉션·`tee`·`sed -i` 등 대상이 글자로 보이는 셸 쓰기만 판별하며, 스크립트·인터프리터·포매터가 내부에서 쓰는 파일과 MCP 파일 도구는 볼 수 없다.

설치가 끝나면 Codex CLI에서 `$setup`을 실행한다. 모델·effort·tracker·관측성 선택은 Codex 내부의 네이티브 선택 UI에서 제출하며 별도 터미널이나 설치기 메뉴를 열지 않는다. 스킬은 `harness-setup.mjs --answers`가 한 번에 반환하는 질문 전체를 한 화면에서 전달하고, 제출한 답만 session JSON에 보존해 적용한다. 선행 답이 바뀌어 맞지 않게 된 질문만 다시 묻는다. 입력 대기 중인 숨은 PTY를 만들지 않는다. 이 단계에서 프로젝트별 `.harness/harness.yaml`과 컨텍스트·트래커 설정을 정한다.

로컬 관측성은 **OpenTelemetry Collector → VictoriaLogs**, **Actuator → VictoriaMetrics**, **공식 MCP 두 개 → 에이전트**로 구성한다. 프로젝트의 `node .harness/scripts/harness-setup.mjs --root <절대 경로>` CLI가 사용 여부·로그/메트릭 포트·보존 기간·OTLP HTTP 포트·여러 프로젝트/서비스의 앱·컨테이너 기준 Actuator URL을 수집하고 compose·Collector·scrape·provider-neutral MCP 설정·실행 profile을 준비한다. 기본 포트는 Logs 9428, Metrics 8428, OTLP 4318이며 모두 loopback으로 제한한다. Docker bridge를 사용하며 host 공개 포트만 loopback에 제한한다. WSL 앱→Collector는 공개 localhost, Metrics→WSL 앱은 컨테이너의 host.docker.internal 주소를 사용하고 내부 수집·MCP는 service DNS로 연결한다. `victorialogs-local-setup` 스킬이 기존 Spring 개발 profile에 OTel SDK/appender 또는 외부 Java agent와 개발용 Actuator/Prometheus registry를 연결한다. production artifact에는 개발 의존성을 넣지 않는다. 진단 v1 schema·오프라인 검사와 workspace별 구현/테스트 메모리 지침도 배포한다. 데이터와 queue는 원본 프로젝트 session 내부에 보존하며 setup 자체는 서버를 시작하지 않는다. [배포 안내](.harness/internal-skills/victorialogs-local-setup/assets/README.md)를 따른다.


설치되는 핵심 런타임은 다음과 같다.

```text
.codex/skills/*                 Codex skill 사본
.codex/agents/*                  Harness agent profile
.harness/workflows/*               workflow 정의
.harness/schemas/*                 workflow schema
.harness/scripts/*                 workspace 및 lifecycle script
.harness/harness-lock.json         설치 기준선과 파일 hash
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

업데이트는 `.harness/harness-lock.json`의 설치 기준선을 사용한다.

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

`install`과 `update`는 관리 파일 경로만 `.git/info/exclude`에 추가한다. `.harness/agents/`의 실행 지침과 검증 프로필은 프로젝트 소유 파일로 Git에 보인다. 기존 설치에서 예전 경로의 지침은 새 위치에 같은 파일이 없을 때만 복사한다. 계약 검사기 `.harness/contracts.mjs`와 CI workflow `.github/workflows/harness-contracts.yml`은 관리 파일로 제외되며 CI 검사를 도입하는 프로젝트만 `git add -f`로 커밋한다.

이미 Git이 추적하는 Harness 런타임 파일은 exclude만으로 untrack되지 않는다. 먼저 추적 대상을 확인하고, 팀 정책상 로컬 런타임으로 전환할 파일만 명시적으로 추적 해제한다. 기존 프로젝트별 Codex 설정까지 일괄 추적 해제하지 않도록 주의한다.

```bash
git ls-files .agents .codex
git rm --cached .codex/agents/<managed-profile>.toml
```

공유할 프로젝트 지침과 결정은 `AGENTS.md`, ADR, 도메인 문서에 보관한다. stakeholder 카드(`docs/domain/stakeholders/`)는 프로젝트 소유 문서이므로 제외되지 않고 Git에 보이며, 설치·업데이트가 만들거나 고치지 않는다. Harness 런타임은 checkout마다 설치·업데이트하고, 서버·인프라 실행 지침은 `.harness/agents/EXEC.md`에 둔다.

설치/업데이트는 번들에 포함된 스킬을 직접 복사하며 별도 `npx skills` 설치에 의존하지 않는다. `update`는 Harness 관리 경로를 항상 최신 릴리스와 같게 맞춘다. 로컬에서 수정한 관리 파일은 백업한 뒤 최신본으로 교체하고, upstream에서 사라진 관리 자산은 수정 여부와 관계없이 백업한 뒤 삭제하며 lock 항목과 빈 디렉터리(구 `.codex/harness-runtime` 포함)도 정리한다. `--no-backup`이면 백업하지 않는다. `install`은 `--force` 없이는 로컬 수정을 보존한다. 이전 업데이트가 남긴 빈 Harness skill 디렉터리도 함께 지우며, Harness가 모르는 이름의 skill 디렉터리는 건드리지 않는다. PR 템플릿은 관리 자산이며 기존 사용자 템플릿도 기본 보존/force 백업 규칙을 따른다.

설치·업데이트는 `Project readiness`를 별도로 보고한다. `project_preparation_required`이면 caller가 setup의 준비 복구와 내부 `sync-contracts` 절차로 실제 소스/CI/실행 지침을 조사해 실행 프로필·통합 계약을 보완하고 doctor를 재실행한다. 직접 구현은 `harness-workspace-preflight.mjs --workspace-root <workspace_root> --for-implementation --json`, wrapper dispatch는 같은 실제 gate를 통과해야 시작한다. 파일 누락을 구현 커밋 뒤까지 미루거나 빈 manifest로 완료 검사를 우회하지 않는다.

## 진행 상황 보기

agent 없이 실행 기록만 읽는 읽기 전용 명령이다. 작업 worktree(또는 프로젝트) 디렉터리에서 실행한다.

```bash
node .harness/scripts/harness-progress.mjs            # 한 번 출력
node .harness/scripts/harness-progress.mjs --watch    # 3초마다 갱신 (--watch 5 처럼 초 지정)
```

단계별 상태·경과 시간·회차·대기 사유를 보여 주고, 실행 중인 stage 아래에 하위 agent(reviewer)와 그 stage agent의 마지막 명령·메시지를 한 줄로 보여 주며(Codex 대화 기록을 읽음), `running`인데 실행기 프로세스가 없으면 "정지됨"으로 표시한다. 기록된 단계만 집계하므로 전체 진행률(%)은 계산하지 않는다.
