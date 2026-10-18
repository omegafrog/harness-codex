# DDD 설계·검증 workflow 검토

검토 기준: Harness `58fe965`, pstack mirror `6f131f1`. pstack의 스킬은 실행 지시로 채택하지 않고 기존 workflow와 비교했다. 현재 범위는 workflow 계약과 문서이며, 모든 소비자 프로젝트의 도메인 코드를 재설계하는 작업은 아니다.

## 확인한 부족과 반영

| 기존 근거 | 확인한 연결 부족 | 반영 |
|---|---|---|
| `ddd-design` Boundary rule, `codebase-design` Module Granularity | 새 경계를 억제하는 규칙은 이미 있으나 조사 결과에 기존 Aggregate·공개 operation·우회 경로가 필수가 아니었음 | spec-me `domain-baseline`, code-research의 source/commit 기반 모델 확인과 기존 owner 확장 비교 |
| Architecture template §3.7, Spec reviewer profile | rule owner 표는 있으나 reviewer는 주어진 diff/Spec만 읽게 제한됨 | caller/source/test 접근 허용, 객체/함수 기반 enforcement와 setter/직접 쓰기·정책 중복·로직 유출 검토 |
| `CONTEXT-MAP.md`, ticket-scoped class/state SVG | Context는 남지만 모델의 구현 상태·근거와 다음 설계의 재사용 경로가 약함 | 링크 중심 durable model 문서, implemented/accepted-target 구분, 설계·구현에서 대조 갱신 |
| Architecture template §5, System Targets | 통신/배포 표는 있지만 선택 근거·현재 운영 사실·추출 trigger 전달이 약함 | 내부 직접 호출부터 비교, transaction/failure semantics, 현재 배포와 점진 추출 근거 |
| `to-ticket`, `implement`, `PlanCheckpointStore.tests` | rule/target ID와 코드·측정·실행 증거가 별도 계약으로 연결되지 않음 | 기존 acceptance/test-contract 문자열과 checkpoint journal에 traceability/measurements 보존; integration 후 대표 경로 재검증 |
| `evaluate-harness` | 단회 suite 결과만으로 개선 효과를 과신할 여지 | workload·실제 완료/오류·동일 조건·교차 반복·편차·측정 한계 계약 |
| `e2e-test` | 실행·cleanup은 있지만 기능별 coverage 지도와 지도 유지보수 흐름이 없음 | `maintain-verification`, 사용자 경로 지도, 기존 runner 재사용 |
| pstack `correct` | 반복 교정을 더 많은 지침으로만 쌓을 수 있음 | 구조/type/lint/gate/test 우선, 근거 있는 반복 오류와 실패 재현, 자동 검사와 리뷰 계약 구분 |
| pstack eval | 기존 eval 경로·raw bundle이 평가 맥락을 드러낼 수 있음 | 별도 blind 비교 프로토콜, 신원/경로/rubric 접근 확인, 일반 suite와 분리 |
| workflow loader와 로컬 `.agents/skills` 사본 | 원본 checkout에서도 설치 사본이 `.codex/skills`보다 우선해 수정한 지침을 가릴 수 있음 | 기존 source-checkout 판별 재사용, source에서는 `.codex/skills` 우선; consumer 우선순위 유지 |
| installer update의 skill descriptor | SKILL.md만 관리해 새 reference와 기존 supporting 파일 변경이 consumer에 누락될 수 있음 | skill 폴더의 supporting 파일을 동일 lock/conflict 계약으로 배포 |
| checkpoint write/reconcile의 top-level merge | `tests: {status: ...}` 갱신이 기존 추적·baseline 증거를 최신 projection에서 제거함 | 생략한 traceability/measurements는 보존; 현재 검증 상태·명령은 새 결과로 대체해 과거 성공 플래그가 최신 실패를 덮지 않음; 명시한 evidence 배열 교체는 허용 |

## 채택하지 않은 부분과 이유

- pstack `architect`의 모든 설계마다 복수 모델·두 경쟁 안 생성: 작은 변경의 비용과 scaffolding을 늘린다. 기존 owner 확장부터 검토하고 실질적 대안/불확실성에만 비교를 적용한다.
- pstack 조율 상태 저장소, PR 감시와 자동 merge: 기존 tracker/Beads/checkpoint/승인 경계를 중복한다.
- 모든 Context의 서버화, 모든 도메인 타입의 클래스화, 사용되지 않는 repository/event/port 생성: 소유권·일관성·실제 경계 요구 없이 추가하지 않는다.
- 메서드 수나 로그 수를 성능/추적성 지표로 사용: 사용자 경로의 실제 결과·workload·상관 ID와 rule별 검증 증거가 필요하다.
- 모든 slice에 새로운 단위/E2E 테스트·UI/server를 만드는 방식: 각 검증 계약은 기존 검사 재사용 또는 해당 없음의 근거를 허용한다. 적용되는 사용자 경로의 미검증을 해당 없음으로 숨기지는 않는다.

## 독립 시나리오 점검

수정한 지침으로 기존 `Orders/Order.cancel()`에 취소 사유를 추가하는 사례, application에서 직접 상태를 쓰는 우회 사례, 실패가 섞인 단회 성능 비교와 신원 누출 사례를 독립 agent가 검토했다. 기존 Aggregate 확장·우회 결함 지적·성능 개선 주장 기각·non-blind 판정이 나왔다. 실제 제품 실행이나 품질 향상 수치의 증거는 아니며 지침 적용의 제한된 forward check다.

## 한계

DDD의 업무 의미와 올바른 Aggregate 경계는 범용 정적 검사만으로 판정하지 못한다. 현재 추가한 의미적 계약은 설계/독립 리뷰가 실행해야 효력이 있다. 기존 deterministic gate는 해당 구조·승인·workspace·journal 보장을 계속 담당한다. blind 비교 프로토콜 추가는 기존 evaluator의 자동 익명화 구현을 뜻하지 않는다. 새로운 workflow의 실제 비용/품질 개선은 대표 사용자 과제의 별도 실행으로 평가해야 한다.

## 검증 기록

- 변경·신규 스킬 15개가 `skill-creator` frontmatter validator를 통과했다. 변경 문서의 로컬 링크와 agent TOML도 확인했다.
- 원본 코드에서 새 회귀 검사 3개가 모두 실패하고, 수정본의 관련 검사 31개가 통과했다. 대상은 source skill 우선순위, supporting reference 갱신·로컬 충돌 보존, checkpoint의 측정·규칙 증거 handoff다.
- `node --test tests/*.test.mjs`: 274개 중 272개 통과, 2개 실패. 두 실패를 변경 전 `58fe965` archive에서도 재현했다. installer skill-only 실행과 설정된 모델 기대값 관련 기존 실패다.
- `python3 -m unittest discover -s tests`: 기존 baseline은 113개 중 14개 실패이며 작업 트리에서도 같은 실패를 확인했다. 전체 `npm test`는 Python 실패 때문에 통과하지 못한다. 기존 실패는 Beads `harness-lqp`에 기록했다.
- 실제 consumer의 모든 사용자 경로, 외부 tracker mutation, live 모델 A/B 비교는 실행하지 않았다. `docs/verification/features.md`의 live 상태는 `not-run`으로 유지한다.
