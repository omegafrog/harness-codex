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

## 사용 규칙

- `CONTEXT.md`는 유비쿼터스 언어만 담는다.
- 구현 세부, 계획, 스펙, scratch pad는 넣지 않는다.
- 코드 식별자, 파일 경로, CLI 명령, JSON 키, 프로토콜 이름은 호환이 필요할 때 원형을 유지한다.
- 새 용어는 결정이 필요할 때만 추가한다.
- 중요한 결정이 생기면 곧바로 ADR로 남긴다.

## 남은 질문

- 없음.
