
1. **Discovery Questions**
   Use discovery questions when little or no information is available.
Examples:
   * What problem are you currently trying to solve?
   * What should the user be able to accomplish?
   * What happens in the current process?

2. **Clarification Questions**
   Use clarification questions to make vague, ambiguous, or subjective statements more specific and verifiable.

   Examples:

   * What does “quickly” mean in measurable terms?
   * What does “completed” mean in this workflow?
   * Does “administrator” include both system operators and event managers?

3. **Choice Questions**
   Use choice questions when the possible interpretations or decisions have already been narrowed down. Present concrete alternatives instead of asking an overly broad question.

   Examples:

   * Should a duplicate request return the existing result, produce an error, or be processed again?
   * Should an expired entry permission be renewed automatically or require the user to rejoin the queue?
   * Should this rule apply to all users or only to authenticated users?

   Choice questions should generally be used after discovery questions. Presenting alternatives too early may unnecessarily restrict the user’s intent.

4. **Example Questions**
   Use example questions to convert abstract explanations into concrete scenarios that can later become use cases or acceptance criteria.

   Examples:

   * Can you describe one example of a successful flow?
   * Can you provide an example of a request that must be rejected?
   * What should the user see in a typical successful case?

5. **Counterexample Questions**
   Use counterexample questions to identify the limits, exceptions, and hidden assumptions of a rule.

   Examples:

   * Is there any situation in which this rule should not apply?
   * Should the same restriction apply when an administrator performs the action?
   * Can a user ever bypass this state transition?

6. **Boundary Questions**
   Use boundary questions to determine expected behavior at minimum, maximum, empty, duplicate, expired, or otherwise extreme conditions.

   Examples:

   * What should happen when the available capacity is zero?
   * What should happen when the maximum limit is exceeded?
   * What should happen if two identical requests arrive at the same time?
   * What should happen immediately before and after expiration?

7. **Failure and Exception Questions**
   Use these questions to determine the expected product behavior when an operation cannot be completed. Focus on the response and observable outcome rather than the technical recovery mechanism.

   Examples:

   * What should the user see when the operation fails?
   * Should the previous state be preserved after a failure?
   * What result should be returned when only part of the operation succeeds?
   * Should the user be allowed to retry?

8. **Priority Questions**
   Use priority questions when requirements conflict or when the minimum acceptable product scope must be determined.

   Examples:

   * If ordering accuracy and response speed conflict, which should take precedence?
   * Which use cases must be included in the first release?
   * Which requirement may be deferred if the schedule is limited?
   * Which behavior must never be compromised?

9. **Consistency Questions**
   Use consistency questions to identify contradictions between previously provided answers, rules, states, or use cases.

   Examples:

   * Earlier, duplicate requests were described as invalid, but this use case allows retries. Which rule should take precedence?
   * Can this state be terminal if the user is also allowed to return to the previous state?
   * Does this exception override the ordering rule?

10. **Confirmation Questions**
    Use confirmation questions to verify that an important requirement, rule, or interpretation has been understood correctly.

    Example:

    > My understanding is that a user may not join the same event queue more than once, but may join queues for different events at the same time. Is that correct?

    Confirmation questions should be used selectively when a decision is important or when misunderstanding it would materially affect the Product Spec. The agent should not repeatedly restate every answer.

11. **Completion Questions**
    Use completion questions near the end of the interview to detect missing requirements, exceptions, or concerns before generating the Product Spec.

    Examples:

    * Is there any important user flow that has not been discussed?
    * Is there any situation in which the agreed behavior would be unacceptable?
    * Are there any unresolved decisions that could change the required product behavior?
    * Is there any existing behavior that must remain unchanged?
