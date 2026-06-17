Event storming standards:
- Event storming starts from extracted use cases.
- Register each use case as the initial command for its event storming flow.
- Follow the happy path first, then model exception flows.
- The usual flow shape is command -> event -> policy -> event -> command -> event, but choose the smallest coherent sequence that fits the use case.
- Every event storming element must express exactly one meaning. Split combined validations, conditions, or actions into separate elements. For example, split `이메일이 중복되지 않고 입력 형식이 유효한 경우` into command `이메일 중복을 검증하라` and command `입력 형식 유효성을 검증하라`.
- Do not mix policies and commands in one element. For example, split `인증 정보가 유효하면 인증을 완료한다` into policy `인증 정보가 유효한 경우` and command `인증을 완료하라`.
- A policy is a rule that watches an event and decides the next action or branch.
- A policy is especially important at conditional, branching, validation, or failure points.
- Every use case section must explicitly extract commands, events, policies, and external systems.
- If no external system exists, write 없음 in the external systems table.

Post-it definitions:
- Command: an instruction to the system to perform an action. Write in imperative form. Use 🟦.
  Example style: 로그인을 요청하라, 던전 탐사를 시작하라, 제작품을 판매 등록하라.
- Event: a fact that happened in the domain. Write in past tense. Use 🟧.
  Example style: 로그인이 요청되었다, 재료가 획득되었다, 독점도가 상승했다.
- Policy: a rule that decides what happens after an event. Use 🟪.
  Write policies as conditions or decision criteria, not commands.
  Example style: 이메일이 사용 가능한 경우, 결제가 승인된 경우, 독점도가 100에 도달한 경우.
- System: the owning system or domain area for commands, events, and policies. Represent as a box or name in the document.
  Example style: 제작 시스템, 시장 시스템, 저장 시스템.
- External system: a system outside the modeled domain boundary. Use 🟩.
  Example style: 브라우저 로컬 저장소, 외부 LLM API.

Traceability rules:
- Every event storming section must reference exactly one source use case.
- The initial command must be derived from the use case goal or first user action.
- Do not create event storming flows that cannot be traced to a use case.
- If the ChangeSet implies behavior but the affected UC slice does not cover it, write it under 확인 필요 instead of modeling it as a full flow.
- Preserve use case IDs such as UC-01, UC-02, etc.

Output document rules:
- Write the executor-facing output to docs/use-cases/<UC-ID>/event-storming.md.
- Do not write event-storming content for unaffected use cases.
- Maintain docs/design/이벤트 스토밍.md, when present, as a summary/index of UC slices rather than the executor-facing source.
- If docs/design/이벤트 스토밍.md and the affected UC slice conflict, do not resolve the conflict by guessing. Report the conflict as 확인 필요 for upstream design reconciliation.
- Use the exact output template below.
- If a business policy field is unknown, stop instead of writing the template.
- If a non-blocking foundational technical field is unknown, keep the field and write `기반 기술 결정 확인 필요`.
- Before reporting event storming as complete, validate every command, event, policy, and external system entry against the completion gate below. If any entry fails, do not report completion. Revise the entry or write the violation under 확인 필요 with a concrete question.

Completion gate:
- Each event storming element has exactly one meaning.
- No policy is mixed with a command.
- Every command is imperative.
- Every event is past tense.
- Every policy is a condition or decision criterion.
- The document is complete only when all five conditions pass.

