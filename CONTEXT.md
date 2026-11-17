# 프로젝트 컨텍스트

## 유비쿼터스 언어

| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |
|---|---|---|---|---|---|---|---|
| Behavioral Eval | 행동 평가 | Behavioral Eval | Capability | 실제 Codex와 harness를 고정 시나리오로 실행해 workflow 수행을 평가하는 것 | - | 단순 결과 평가 | `docs/specs/496/product-spec.md` |
| Hard Gate | 하드 게이트 | Hard Gate | Rule | 결정론적으로 검증하며 하나라도 위반하면 해당 평가를 실패시키는 조건 | - | 품질 점수 | `docs/specs/496/product-spec.md` |
| Required Outcome | 필수 결과 | Required Outcome | Rule | 평가 시나리오가 반드시 달성해야 하는 최소 결과 | - | 최종 답변만 | `docs/specs/496/product-spec.md` |
| Quality Score | 품질 점수 | Quality Score | Measure | 필수 결과와 정책을 통과한 실행의 품질 차이를 수치화한 값 | - | 성공 여부 | `docs/specs/496/product-spec.md` |
| Trajectory Quality | 경로 품질 | Trajectory Quality | Measure | workflow 실행 경로의 중복·불필요한 역추적·절차 준수 품질을 나타내는 값 | - | 단순 latency | `docs/specs/496/product-spec.md` |
| Side-effect Safety Boundary | 부작용 안전 경계 | Side-effect Safety Boundary | Boundary | 평가 또는 workflow 실행이 파괴적 작업·권한 밖 작업·외부 시스템 변경으로 안전한 실행 범위를 벗어나지 않도록 하는 경계 | - | 단순 policy 위반 | `docs/specs/496/product-spec.md` |
| Inconclusive | 판정 불가 | Inconclusive | Evaluation State | 유효한 실행 evidence를 확보하지 못해 harness 동작을 판단할 수 없는 평가 상태 | - | 실패와 동일시 | `docs/specs/496/product-spec.md` |
| Eval Runner | 평가 실행기 | Eval Runner | Capability | 평가 case의 환경 준비·실행·관찰·안전 경계·수집·판정·정리를 연결하는 실행 경계 | - | Workflow orchestrator | `docs/specs/496/architecture-spec.md` |
| Grader | 판정기 | Grader | Capability | 관찰된 실행 결과를 Hard Gate·Required Outcome·Quality Score 계약으로 판정하는 것 | - | Workflow router | `docs/specs/496/architecture-spec.md` |
| External System Port | 외부 시스템 포트 | External System Port | Port | 외부 시스템 호출과 side effect를 통제된 adapter 경계로 통과시키는 계약 | - | 직접 외부 호출 | `docs/specs/496/architecture-spec.md` |
| Execution Line | 실행 라인 | Execution Line | Boundary | dependency chain이 순차적으로 이어지는 workspace 실행 경로 | - | parallel group | `docs/specs/496/architecture-spec.md` |
| Fixed Group Base | 고정 그룹 기준점 | Fixed Group Base | Constraint | 같은 parallel group의 모든 plan이 공유하는 시작 commit | - | 완료 결과를 base로 사용 | `docs/specs/496/architecture-spec.md` |
| Case Manifest | 평가 케이스 선언 | Case Manifest | Contract | 평가 case의 workflow·outcome·gate·quality·환경 조건을 versioned ID로 선언하는 문서 | - | free-form 평가 조건 | `docs/specs/496/architecture-spec.md` |
| Preflight | 사전 검증 | Preflight | Gate | 실행 전에 manifest·reference·fixture·환경 전제를 검증하는 단계 | - | 실행 중 검증 | `docs/specs/496/architecture-spec.md` |
| System Target | 시스템 목표 | System Target | Contract | 요구사항과 시스템 특성에 따라 선택한 정량 목표와 성장 시나리오를 출처·신뢰도·근거와 함께 기록하는 판단 입력 | - | 검증된 실측치로 일괄 간주 | `docs/specs/506/product-spec.md` |
| Scaling Boundary | 재검토 경계 | Scaling Boundary | Boundary | 현재 아키텍처의 유효성을 다시 판단해야 하는 관찰 가능한 수치 또는 조건 | - | 보장된 처리 용량 | `docs/specs/506/product-spec.md` |
| Architecture Decision | 아키텍처 결정 | Architecture Decision | Decision | 명시적 요구사항과 목표, 대안, 근거, trade-offs 및 재검토 경계를 연결한 설계 결정 | - | 기술 선호만으로 확정 | `docs/specs/506/product-spec.md` |
| Code Validation Run | 코드 정합성 검증 실행 | Code Validation Run | Execution Purpose | 코드의 단위·회귀 동작이 기존 계약을 유지하는지 확인하는 실행. 그 자체로 Architecture Decision을 검증하지 않으므로 Decision 참조를 요구하지 않는다. | maintenance test | Decision Validation Run과 혼동 | `docs/architecture/adr-013-execution-observation-purpose.md` |
| Decision Validation Run | 결정 조건 검증 실행 | Decision Validation Run | Execution Purpose | 특정 요구사항·System Target 등 승인된 Architecture Decision의 조건 충족 여부를 확인하도록 의도적으로 설계한 실행. 관련 Decision ID를 명시한다. | decision-bound test | 일반 코드 검증으로 취급 | `docs/architecture/adr-013-execution-observation-purpose.md` |
| Source | 출처 | Source | Knowledge Object | Engineering 판단에 참고한 문서의 발행 주체와 출처 성격 및 평가 정보를 식별하는 객체 | - | Principle과 동일시 | `docs/specs/506/product-spec.md` |
| Claim | 주장 | Claim | Knowledge Object | 특정 Source가 명시한 원자적 주장과 원문 위치·적용 맥락·한정 조건 | - | 일반화된 규칙으로 자동 간주 | `docs/specs/506/product-spec.md` |
| Principle | 공학 원칙 | Principle | Knowledge Object | 지지·반대 Claim과 적용 조건·예외를 종합하고 승인 lifecycle을 관리하는 Engineering 규칙 | - | 출처 권위만으로 확정 | `docs/specs/506/product-spec.md` |
| Local Evidence | 로컬 관측 근거 | Local Evidence | Knowledge Object | 원래 프로젝트와 측정 환경에서 수집한 관측 결과로 유효성 및 실행 상태를 구분하는 근거 | - | 프로젝트 간 무조건 일반화 | `docs/specs/506/product-spec.md` |
| Learning Mode | 학습 모드 | Learning Mode | Workflow Mode | 사용자가 설계를 제안·방어하고 Reviewer가 목표·근거에 기반한 이의를 제기하여 승인 조건을 검토하는 방식 | - | Reviewer의 정답 대행 | `docs/specs/506/product-spec.md` |
| Unrequested Behavior | 요청되지 않은 동작 | Unrequested Behavior | Rule | 승인된 Spec·plan에 근거 없이 구현에 들어간 동작. 사용자가 유지 또는 제거를 정할 때까지 완료를 막는다 | - | 구현 세부 | `docs/architecture/adr-010-bounded-review-repair.md` |
| Sufficient Level | 충분한 수준 | Sufficient Level | Rule | 제품 의도를 만족하는 관찰 가능한 사용자 흐름·완료 조건. 명시 요구와 해당 조건을 안전하고 온전하게 충족하는 데 필수인 작업을 구현·리뷰의 범위로 정한다 | - | 엄밀도 | `.codex/internal-skills/product-spec/references/template.md` |
| Stakeholder Card | Stakeholder 카드 | Stakeholder Card | Project Document | 사용자가 `docs/domain/stakeholders/SH-xx.md`에 직접 등록한 이해관계 당사자 또는 제약 출처의 역할·목표·불편·제약·권한·용어·모르는 것. 프로젝트 소유 문서이며 Harness가 만들거나 고치지 않는다 | SH 카드 | 에이전트가 대신 만든 persona | `.codex/internal-skills/stakeholder-analysis/GUIDE.md` |
| Expert Lens | 전문가 관점 | Expert Lens | Role | Harness가 관리하는 기본 검토자 카드(도메인·보안)로, 원하는 것이 아니라 지식으로 요청을 검토한다. 이해관계 당사자인 stakeholder와 구분한다 | LENS | stakeholder와 동일시 | `.codex/internal-skills/stakeholder-analysis/references/lenses/domain.md` |
| Candidate Requirement | 후보 요구사항 | Candidate Requirement | Proposal | persona가 요청의 특정 문구에서 제안한, 요청이 정하지 않은 결정(CAND). 요청이 이미 말한 범위를 되풀이한 것은 후보가 아니다. 사용자가 채택하기 전에는 요구사항이 아니며 기각·보류한 후보는 새 결정 없이 되살리지 않는다 | CAND | 채택 전 요구사항 | `.codex/internal-skills/stakeholder-analysis/GUIDE.md` |
| Request Anchor | 요청 앵커 | Request Anchor | Rule | 후보 요구사항이 근거로 인용하는 요청 원문의 정확한 부분 문자열. 없으면 채택 대상이 아니라 참고용 `요청 범위 밖 관찰`이 된다 | - | 요청 의역 | `.codex/internal-skills/stakeholder-persona/GUIDE.md` |
| Requirements Document | 요구사항 명세 | Requirements Document | Project Document | 새 기능 요청의 요구사항을 `docs/specs/<plan-set-id>/requirements.md` 한 문서에 단계별로 모아 가는 living spec. 상태는 draft와 fixed이며 `requirements-fix`가 coverage gate를 통과하면 승인 질문 없이 fixed로 확정한다. 확정 뒤에는 사용자의 명시적 수정 지시로만 바뀐다 | requirements.md | Product Spec | `.codex/internal-skills/requirements-fix/references/template.md` |
| Business Activity | 업무 | Business Activity | Unit | 행위자가 한 번에 끝내는 업무 하나(BIZ). 목적·주체·시나리오·규칙·예외·완료 조건·이벤트 흐름을 가지며 서브도메인 하나에 속한다 | BIZ | 기능 | `.codex/internal-skills/requirements-fix/references/template.md` |
| Subdomain Candidate | 서브도메인 후보 | Subdomain Candidate | Proposal | 업무를 목적·언어·행위자 차이로 묶은 가설(SD). 이벤트 근거로 검증하고 core·supporting·generic으로 분류해 사용자가 확인하면 확정된다. 바운디드 컨텍스트가 아니다 | SD | 바운디드 컨텍스트 | `.codex/internal-skills/subdomain-classification/GUIDE.md` |
| Domain Event | 도메인 이벤트 | Domain Event | Business Fact | 업무에서 일어난 사실을 한국어 과거형으로 쓴 이름(예: 게시글이 작성됨). 클릭·저장·API 호출 같은 기술 사건은 이벤트가 아니다 | - | 기술 이벤트 | `.codex/internal-skills/event-storming/GUIDE.md` |
| Hotspot | 핫스팟 | Hotspot | Open Question | 이벤트 흐름에서 이벤트·정책·예외의 결과를 바꾸는데 요청이 정하지 않은 결정(HS). 사용자가 답하면 업무 규칙이나 예외 시나리오로 기록한다 | HS | - | `.codex/internal-skills/event-storming/GUIDE.md` |
| Tactical Design Document | 전술 설계 문서 | Tactical Design Document | Project Document | 확정된 요구사항을 전술 설계로 옮겨 `docs/specs/<plan-set-id>/tactical-design.md` 한 문서에 단계별로 모아 가는 plan set 문서. 다섯 stage가 각자 모델 후보·Aggregate·Domain Service·Application Service·통합 설계 절만 채우고 결정 이력에 출처를 남긴다. 문서 이름은 흐름을 따르므로 `domain-model` 같은 stage 이름은 파일이 아니라 stage를 가리킨다. 프로젝트의 현재 모델 기준인 `docs/architecture/domain-model.md`와 구분한다 | tactical-design.md | requirements.md | `.codex/internal-skills/domain-model/references/template.md` |
| Consistency Decision | 일관성 결정 | Consistency Decision | Decision | Aggregate에 걸친 규칙(CON)을 즉시 일관성과 최종 일관성(분리) 중 무엇으로 지킬지 정한 업무 결정. 즉시 일관성은 같은 컨텍스트에서 한 연산이 함께 바꾸는 Aggregate를 병합하고, 연산이 읽기만 하는 Aggregate(`조회 전용 Aggregate`)는 병합하지 않으며, 컨텍스트가 다른 Aggregate는 병합하지 않고 통합 설계의 동기 확인·호출로 지킨다. 요구사항이나 사용자 답을 출처로 하며 에이전트 제안만으로 확정하지 않고 Saga·Outbox는 최종 일관성 결정에서만 검토한다 | CON | - | `.codex/internal-skills/aggregate-design/GUIDE.md` |
| Decision Owner | 판단 소유자 | Decision Owner | Role | 컨텍스트 맵의 관계에서 두 컨텍스트의 규칙이 어긋날 때 결과를 정하는 컨텍스트. 다른 쪽은 그 결과를 받아들이며 근거가 없으면 `미정`이다. upstream·downstream 방향과 같지 않다 | - | upstream과 동일시 | `.codex/internal-skills/bounded-context/GUIDE.md` |

## Tracker lifecycle 용어

- Lifecycle status: configured tracker가 소유하는 planned/in-progress/blocked/completed 네 실행 상태. Beads의 open/in_progress/blocked/closed는 이에 대응하는 mirror다.
- Backlog classification: 아직 실행 대상으로 채택되지 않은 후보 분류. harness_classification=backlog/committed로 기록하며 lifecycle 상태를 대신하지 않는다.
- Execution phase: planning/implementation/test/review의 현재 작업 단계. harness_phase metadata이며 독립 상태나 task type이 아니다.
- Tracker mirror: exact external_ref와 harness_tracker_version=1로 canonical ticket에 연결된 신규 Beads 항목. 로컬 운영 Bead와 구분한다.

## 사용 규칙

- `CONTEXT.md`는 유비쿼터스 언어만 담는다.
- 구현 세부, 계획, 스펙, scratch pad는 넣지 않는다.
- 코드 식별자, 파일 경로, CLI 명령, JSON 키, 프로토콜 이름은 호환이 필요할 때 원형을 유지한다.
- Product Spec에서 정의한 도메인 개념·행위자/역할·업무 상태·규칙 용어는 특정 ticket에 한정하지 않고 프로젝트 공유 vocabulary로 `CONTEXT.md`에 기록한다. 새 capability가 새로운 canonical 용어면 의미가 기존 항목과 겹치지 않는지 확인한 뒤 추가한다.
- 의미가 합의된 기존 canonical 용어의 정의가 요구 변경으로 달라지면 같은 항목을 갱신하고 승인된 대체·폐기는 아래 lifecycle을 따른다. UI 문구나 설명용 표현, framework/package/API/code 식별자는 도메인 언어가 아니면 추가하지 않는다.
- 중요한 결정이 생기면 곧바로 ADR로 남긴다.
- 현행 canonical term과 승인된 폐기·대체 관계를 과거 Spec·코드의 명칭보다 먼저 확인한다. 폐기 용어는 현행 alias로 다시 등록하지 않는다.
- 용어 폐기 시 아래 기록을 남기고 대체어·Context·승인 근거를 연결한다. 호환 API/JSON/CLI 식별자는 필요한 경계와 제거 조건을 명시한 경우에만 원형을 유지한다. historical 문서와 폐기 기록은 삭제하지 않는다.

## 폐기 용어

| 폐기 용어 | Context / 의미 | 현행 대체어 또는 제거 | 승인 근거 | 허용되는 호환 사용 / 제거 조건 |
|---|---|---|---|---|
| Domain Model Document, `docs/specs/<plan-set-id>/domain-model.md` | 전술 설계 흐름의 plan set 문서. stage 이름 `domain-model`과 같아 사용자 지시가 stage를 가리키는지 파일을 가리키는지 혼동됐다 | Tactical Design Document, `tactical-design.md` | 사용자 결정(2026-11-16): E2E에서 "domain-model은 그대로 두고 aggregate-design 다시 진행"을 `domain-model.md` 편집 금지로 읽어 aggregate-design이 자기 절을 쓰지 못했다 | 예전 Harness가 만든 진행 중 plan set의 파일 이름과 끝난 stage 기록의 artifact 경로로만 허용하며 실행기의 `migrateLegacyTacticalDesign`이 전술 stage 준비 때 `tactical-design.md`로 바꾸고 `currentTacticalDesignPath`가 기록의 옛 경로를 따라간다. stage 이름 `domain-model`과 프로젝트 문서 `docs/architecture/domain-model.md`는 폐기 대상이 아니다. 예전 이름의 plan set을 가진 진행 중 소비자가 없다고 확인되면 migration, `currentTacticalDesignPath`와 `LEGACY_TACTICAL_DESIGN_DOCUMENT`를 제거한다 |

승인 근거가 확인된 폐기 항목만 기록한다. 과거 코드 명칭을 근거 없이 이 표에 추가하지 않는다.

## 남은 질문

- 없음.
