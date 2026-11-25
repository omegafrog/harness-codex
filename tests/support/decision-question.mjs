// A stage question as a worker returns it now: the settled rules and the reason to decide now as `context`, and under each
// option an `effect`, an `example` and `excludes` (the options of other questions of the batch that cannot hold with it). Older fixtures pass their bare question through withDecisionContext.
export const decisionContext = { settled_rules: ['요청은 이 기능의 범위를 정한다'], why_now: '이 결정이 있어야 이 단계의 규칙을 확정할 수 있다' };

export function withDecisionContext(question) {
  return {
    ...question,
    context: question.context ?? decisionContext,
    options: question.options.map((option) => ({
      ...option,
      effect: option.effect ?? `${option.label}을 고르면 화면과 동작이 이렇게 달라진다`,
      example: option.example ?? `같은 상황에서 ${option.label}을 적용하면 ${option.consequence ?? option.label}`,
      excludes: option.excludes ?? [],
    })),
  };
}
