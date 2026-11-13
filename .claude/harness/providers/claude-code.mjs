export const id = 'claude-code';

export function prepareOutputSchema(schema) {
  const description = 'Keep status and code paired: completed=OK; action_required=REVIEW_REQUIRED|SPEC_REVISION_REQUIRED|PLAN_REVISION_REQUIRED|IMPLEMENTATION_REVISION_REQUIRED|USER_DECISION_REQUIRED; blocked=ENVIRONMENT_UNAVAILABLE|PERMISSION_REQUIRED|DEPENDENCY_INCOMPLETE|INPUT_MISSING|MODEL_BINDING_UNAVAILABLE; failed=EXECUTION_ERROR|INVALID_INPUT|ARTIFACT_WRITE_FAILED; cancelled=CANCELLED. Envelope and result status/code must match.';
  schema.properties.status.description = description;
  schema.properties.code.description = description;
  schema.properties.result.properties.status.description = description;
  schema.properties.result.properties.code.description = description;
  return schema;
}
