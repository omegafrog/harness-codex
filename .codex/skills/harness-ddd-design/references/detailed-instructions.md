# harness-ddd-design Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-ddd-design/SKILL.md`

## Purpose

이 스킬은 하나의 Event Storming slice를 기반으로 **후보 DDD 설계**와 문서 안의 누적 Mermaid 시각화를 만든다. 코드는 생성하지 않고, 이 결과는 ChangeSet 전체의 canonical model이 아니다. 여러 Work Item 후보의 병합과 shared `ARCHITECTURE.md` 반영은 후속 `harness-ddd-integration` 단계의 책임이다.

## Invocation

- agent id: `ddd_architect`
- config: `.codex/agents/ddd_architect.toml`
- required input:
  - `docs/changes/active/<CHG-ID>.md`
  - `docs/use-cases/<UC-ID>/use-case.md`
  - `docs/use-cases/<UC-ID>/event-storming.md`
  - `docs/use-cases/<UC-ID>/e2e-goal.md`
- output file:
  - `docs/use-cases/<UC-ID>/ddd-design.md`

## Write boundary

- 쓰기 범위는 `docs/use-cases/<UC-ID>/ddd-design.md` 하나다.
- `ARCHITECTURE.md`를 수정하지 않는다.
- 다른 UC 후보나 downstream technical decision, diagram, plan을 수정하지 않는다.
- 후보 문서 상단에는 `status: candidate`, ChangeSet ID, Work Item ID, Event Storming input hash를 기록한다.

## Slice-first flow

1. active ChangeSet과 selected UC를 확인한다.
2. selected slice의 Use Case, Event Storming, E2E goal을 먼저 읽는다.
3. slice에서 부족한 baseline 정보만 canonical docs와 existing `ARCHITECTURE.md`에서 읽는다.
4. 후보 Aggregate/Entity/Value Object/command/event/state/invariant/relationship을 근거와 함께 작성한다.
5. 다른 Work Item과 공유될 수 있는 Aggregate 또는 Entity는 `Integration Impact`에 명시한다.

## Candidate rules

- 후보의 각 command, event, invariant, state transition은 UC 또는 Event Storming 근거를 남긴다.
- Entity와 VO의 속성·타입·필수 여부·검증 근거를 기록한다.
- Aggregate는 하나의 root와 원자적 일관성 경계를 가진다.
- Application service는 orchestration만 하고 business rule을 포함하지 않는다.
- 기술 stack, storage, adapter, retry, cache, transaction propagation, deployment detail은 technical-decisions 단계로 넘긴다.
- lifecycle, permission, policy, state transition을 결정할 근거가 없으면 추측하지 않고 upstream blocker로 반환한다.

## Cumulative Architecture Visualization

`ddd-design.md` 끝에는 정확히 하나의 `## Architecture Visualization` 영역을 둔다.

- `entity_vo`가 첫 Mermaid 블록을 만들고, `behaviors`는 같은 `entity_vo` 블록을 모델+행위 통합 다이어그램으로 갱신한다.
- 나머지 후속 substep은 그 영역 끝에 자기 블록을 append한다.
- 완성된 기존 블록은 보존한다. `entity_vo`와 `behaviors` rerun은 공유 `entity_vo` marker 범위만 교체하고, 나머지는 자기 범위만 교체한다.
- 별도 diagram 파일이나 두 번째 visualization 섹션을 만들지 않는다.
- Mermaid를 사용한다. ChangeSet 문서 편집기가 Mermaid를 문서 안에서 렌더링한다.
- 블록 순서는 `entity_vo+behaviors → application_flow → aggregates → bounded_contexts`다.
- 각 block은 다음 marker 쌍 중 하나를 사용한다:
  - `<!-- harness:ddd-visualization:entity_vo:start -->` / `<!-- harness:ddd-visualization:entity_vo:end -->`
  - `<!-- harness:ddd-visualization:application_flow:start -->` / `<!-- harness:ddd-visualization:application_flow:end -->`
  - `<!-- harness:ddd-visualization:aggregates:start -->` / `<!-- harness:ddd-visualization:aggregates:end -->`
  - `<!-- harness:ddd-visualization:bounded_contexts:start -->` / `<!-- harness:ddd-visualization:bounded_contexts:end -->`
- 문서 표는 상세 속성, 불변식, 증거의 정본으로 유지한다. Mermaid는 그 후보 내용을 요약해 표현한다.
- shared Aggregate 또는 경계에 대한 Mermaid 주장은 candidate로 남기고, `ddd-design-integration`이 canonical contract를 결정한다.

## Interactive UI Substeps

- UI 실행은 호출마다 하나의 substep만 완료한다: `entity_vo`, `behaviors`, `application_flow`, `aggregates`, `bounded_contexts`.
- 같은 `docs/use-cases/<UC-ID>/ddd-design.md`를 확장하고, 완료된 기존 문서 section과 visualization block을 보존한다.
- `entity_vo` rows must map each model to one `Impact Assessment` row whose `Element Type` is only `Entity` or `Value Object`; lifecycle `Status` such as `new`, `modify`, or `reuse` is never a visual model tag.
- `behaviors`는 별도 visualization을 만들지 않고 공유 `entity_vo` 블록을 갱신한다. Entity/VO method signature는 해당 모델 안에 두고 domain service만 같은 다이어그램의 별도 node로 둔다.
- 기존 문서에 레거시 `behaviors` managed block이 있으면 근거 있는 내용을 공유 블록에 병합한 뒤 레거시 block을 삭제한다.
- `application_flow` writes a Mermaid flow or sequence diagram for service orchestration; it must not turn into pseudocode.
- `aggregates` writes a boundary-focused diagram with one explicit root per aggregate.
- `bounded_contexts` writes context boundaries and exactly one allowed communication type: `internal_http`, `domain_event`, or `shared_database`.
- Every model, service, aggregate, and boundary must record command, event, or policy evidence.

## Handoff

`ddd-design-integration`은 모든 후보의 claim을 정규화해 canonical contract를 만든다. candidate 문서가 나중에 변경되면 input hash 불일치로 integration과 downstream 산출물은 stale이다.
