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
- conditional baseline input:
  - `docs/design/ubiquitous-language.md` when it exists
- output file:
  - `docs/use-cases/<UC-ID>/ddd-design.md`

## Write boundary

- 쓰기 범위는 `docs/use-cases/<UC-ID>/ddd-design.md` 하나다.
- `ARCHITECTURE.md`를 수정하지 않는다.
- 다른 UC 후보나 downstream technical decision, diagram, plan을 수정하지 않는다.
- 후보 문서 상단에는 `status: candidate`, ChangeSet ID, Work Item ID를 기록한다.
- `input_hashes`에는 현재 입력 바이트의 SHA-256을 아래 키로 모두 기록한다.
  - `change_set_document`: active ChangeSet
  - `use_case`: selected use-case slice
  - `event_storming`: selected event-storming slice
  - `e2e_goal`: selected E2E goal slice
  - `ubiquitous_language`: `docs/design/ubiquitous-language.md`가 존재할 때
- 어떤 입력 hash라도 현재 파일과 다르면 candidate는 stale이다. 기존 후보를 repair할 때도 모든 hash를 새로 계산하며, 유효한 대체 후보가 완성되기 전에는 기존 파일을 삭제하지 않는다.

## Slice-first flow

1. active ChangeSet과 selected UC를 확인한다.
2. selected slice의 Use Case, Event Storming, E2E goal을 먼저 읽는다.
3. slice에서 부족한 baseline 정보만 canonical docs에서 읽는다. 후보 단계에서는 `ARCHITECTURE.md`를 읽지 않는다.
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

`ddd-design.md` 끝에는 정확히 하나의 `## Architecture Visualization` 영역과 정확히 하나의 Mermaid graph만 둔다.

- `entity_vo`가 단일 Mermaid graph를 만들고, `behaviors`, `aggregates`, `application_flow`, `bounded_contexts`는 모두 같은 `entity_vo` managed range를 갱신한다.
- 어떤 substep도 별도 Mermaid block, 별도 Mermaid fence, 별도 managed range를 append하지 않는다.
- 완성된 기존 단일 graph는 보존하되, 후속 substep/rerun은 공유 `entity_vo` marker 범위만 교체한다.
- 별도 diagram 파일이나 두 번째 visualization 섹션을 만들지 않는다.
- Mermaid를 사용한다. ChangeSet 문서 편집기가 Mermaid를 문서 안에서 렌더링한다.
- 단일 graph 안의 시각 표현 순서는 `Entity/VO + Behaviors + Aggregates → Application Flow → Bounded Contexts`다.
- 유일한 marker 쌍은 `<!-- harness:ddd-visualization:entity_vo:start -->` / `<!-- harness:ddd-visualization:entity_vo:end -->`다.
- 기존 문서에 `behaviors`, `application_flow`, `aggregates`, `bounded_contexts` managed block이 있으면 근거 있는 내용을 단일 `entity_vo` graph에 병합한 뒤 레거시 block을 삭제한다.
- 문서 표는 상세 속성, 불변식, 증거의 정본으로 유지한다. Mermaid는 그 후보 내용을 요약해 표현한다.
- shared Aggregate 또는 경계에 대한 Mermaid 주장은 candidate로 남기고, `ddd-design-integration`이 canonical contract를 결정한다.

## Interactive UI Substeps

- UI 실행은 호출마다 하나의 substep만 완료한다: `entity_vo`, `behaviors`, `application_flow`, `aggregates`, `bounded_contexts`.
- 같은 `docs/use-cases/<UC-ID>/ddd-design.md`를 확장하고, 완료된 기존 문서 section과 visualization block을 보존한다.
- 모든 Markdown table은 header와 모든 row의 column 수가 같아야 한다. cell 안에서 literal pipe가 필요하면 code span 안이라도 `\|`로 escape한다.
- `entity_vo` rows must map each model to one `Impact Assessment` row whose `Element Type` is only `Entity` or `Value Object`; lifecycle `Status` such as `new`, `modify`, or `reuse` is never a visual model tag.
- `behaviors`는 별도 visualization을 만들지 않고 공유 `entity_vo` graph를 갱신한다. Entity/VO method signature는 해당 모델 안에 두고 domain service만 같은 graph의 별도 node로 둔다.
- `application_flow`는 별도 Mermaid flow/sequence diagram을 만들지 않는다. 공유 `entity_vo` graph 안에 application service orchestration 노드/edge를 추가한다. Application Service node는 Aggregate boundary 밖에 배치하고, Aggregate root, Domain Service, port 호출 관계를 표시한다. Pseudocode로 바꾸지 않는다.
- `aggregates`는 별도 Aggregate Mermaid 블록을 만들지 않는다. `entity_vo` managed block을 갱신해 Aggregate 이름, Aggregate 경계, root, 포함 Entity/VO를 기존 entity/VO/behavior 그래프 위에 함께 표시한다. Domain Service는 해당 Aggregate 경계 안에 배치한다. Application Service는 Aggregate 경계 밖에 배치한다.
- `bounded_contexts`는 별도 Mermaid block을 만들지 않는다. 공유 `entity_vo` graph 안에 context boundaries와 정확히 하나의 allowed communication type(`internal_http`, `domain_event`, `shared_database`)을 추가한다.
- Every model, service, aggregate, and boundary must record command, event, or policy evidence.

## Handoff

`ddd-design-integration`은 모든 후보의 claim을 정규화해 canonical contract를 만든다. candidate 문서가 나중에 변경되거나 input hash가 현재 source와 불일치하면 integration과 downstream 산출물은 stale이다.
