# Product Spec

1. **Problem and Context**
   Identify the circumstances in which the problem occurs, how it manifests, and what impact it currently has.

2. **Goals and Desired Outcomes**
   Focus on the outcome the product should produce rather than only describing what should be built. Capture one product intent per feature: the user's reason for wanting it (what it protects or enables for whom) and what level is sufficient for that reason. Restating the feature ("users can log in with email") is not an intent. When the request does not state the reason, ask it together with the feature's decision question (see the intent question rule in the Product Spec GUIDE). Do not ask the user to list what is out of bounds.

3. **Users and Actors**
   Identify the users, external systems, and other participants involved in the product or workflow.

4. **Ubiquitous Language and Terminology**
   Define all agreed business concepts, actors/roles, business states, and rules needed by the product. Reuse or clarify the consumer project's current `CONTEXT.md` terms, then update that shared project glossary for every domain term defined in Product Spec section 4; terms do not belong only to the current plan set.

5. **Core Use Cases**
   Describe the main user flows, including how each flow begins, progresses, and ends.

6. **Business Rules and Invariants**
   Identify conditions and rules necessary for the requested use cases. For a required numeric, length, boundary, format, validation or delete-propagation rule, capture its purpose and sufficient level. Reuse existing evidence or a reasonable platform default where possible; ask only when the required outcome materially depends on an otherwise unresolved decision. Do not add optional rules just to fill this topic.

7. **States and State Transitions**
   For features that have states, define the possible states, how transitions occur, and what conditions or events trigger each transition.

8. **Failures, Exceptions, and Boundary Conditions**
   Identify potential failures, exceptional cases, and boundary conditions. Focus on the expected system response or user-visible result rather than on how the problem should be technically resolved.

9. **Inputs and Outputs**
   Determine what information is required, what information is optional, and what results or feedback should be presented.

10. **Scope and Non-goals**
    Define what is included in the current work, what is explicitly excluded, and what may be deferred to future work.

11. **Priorities and Trade-offs**
    Review the answers from the previous topics to determine the minimum set of use cases that must be implemented and which requirements should take precedence when they conflict.

12. **Success Conditions and Acceptance Criteria**
    Convert all agreed requirements, rules, flows, exceptions, and outcomes into clear and verifiable statements.

13. **End-user Scenarios**
    Turn the acceptance criteria into the end-user scenarios the final E2E runs: actor, action and the result the user sees, each linked to its UC/BR/AC IDs. Ask the user only when an expected result is not settled by the agreed requirements. Execution environment belongs to the Architecture Spec.
