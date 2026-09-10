# ADR-005: Grader 책임 경계

- 상태: Accepted
- 결정일: 2026-09-10

## Context

평가 결과를 판정하는 역할과 실행을 제어하는 역할이 섞이면 grader가 workflow routing이나 repair를 암묵적으로 소유하게 된다. 또한 QualityGrader가 실행 당시 존재하지 않았던 workspace 상태를 직접 조회하면 평가가 재현되지 않는다.

## Decision

Grader를 네 책임으로 분리한다.

```text
HardGateGrader
→ 금지 규칙 위반 판정
OutcomeGrader
→ case 요구 결과 달성 판정
QualityGrader
→ 달성 방식·결과 품질 평가
EfficiencyCollector
→ resource usage 측정
```

최종 case 판정은 Eval Runner가 조합한다.

```text
passed = hard_gates == pass
       AND required_outcome == pass
       AND quality >= threshold
```

QualityGrader 입력은 raw workspace가 아니라 versioned artifact bundle로 제한한다.

```yaml
quality_grader_input:
  - case_spec
  - normalized_trajectory
  - normalized_events
  - final_output
  - relevant_diff
  - outcome_evidence
```

QualityGrader는 `task_quality`, `trajectory_quality`, dimension별 score, rationale을 반환한다. evaluator model, model config, rubric version을 snapshot한다. Model timeout, invalid structured output, rubric execution error는 `inconclusive`로 처리한다.

Grader는 artifact만 평가하며 실행 제어, workflow 변경, repair 지시, Hard Gate/Outcome override를 하지 않는다.

`OutcomeGrader`는 versioned artifact bundle에 포함된 correlation으로 연결된 성공한 `tool_call`/`tool_result`, case manifest의 `outcome_evidence` 규칙, 그리고 수집된 repository-relative artifact 목록만 사용한다. final text나 self-reported process event는 Required Outcome 증거가 아니다.

## Consequences

- 안전·정확성·품질·효율성 판정의 책임이 분리된다.
- QualityGrader의 입력과 rubric 버전을 재현할 수 있다.
- Artifact bundle 생성 계약이 grader 실행의 선행 조건이 된다.
- Runner가 최종 판정 조합 책임을 가지므로 grader 간 결합을 줄인다.
