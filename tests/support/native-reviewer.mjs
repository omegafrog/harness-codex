// Inside a stage, plan/spec review records are accepted only for a reviewer the subagent hook bound.
// Tests that model a stage bind one the same way the hook does: claim, bind on start, stop with the result.
import { join } from 'node:path';

export async function bindNativeReviewer({ root, scope, attemptId, executionId, reviewerId, parentSessionId, verdict = 'pass', findings = [] }) {
  const { updateReviewAttempt } = await import(`file://${join(root, '.harness/src/workflow/review-attempts.mjs')}`);
  const nativeReview = { verdict, findings };
  await updateReviewAttempt({ root, scope, action: 'claim', attemptId, reviewerId, nativeAgentId: reviewerId, parentSessionId, executionId });
  await updateReviewAttempt({ root, scope, action: 'bind-native', attemptId, nativeAgentId: reviewerId, parentSessionId });
  await updateReviewAttempt({ root, scope, action: 'stop-native', attemptId, nativeAgentId: reviewerId, parentSessionId, nativeResult: JSON.stringify(nativeReview), nativeReview });
}
