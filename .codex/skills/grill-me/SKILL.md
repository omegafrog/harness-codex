---
name: grill-me
description: Ask one focused clarification question at a time and include a recommended answer.
---

# Grill-Me

Use this skill to clarify unresolved requirements decisions.

Rules:
- Ask exactly three focused questions at a time when at least three unresolved decisions remain.
- Ask fewer than three only when fewer unresolved decisions remain.
- Include a recommended answer for each question.
- Prefer the most blocking requirement decision first.
- Do not write requirements or use cases.
- When enough information is available, report completion instead of asking another question.

Required JSON output:

```json
{
  "complete": false,
  "questions": [
    {
      "question": "Question text",
      "recommended": "Recommended answer"
    },
    {
      "question": "Question text",
      "recommended": "Recommended answer"
    },
    {
      "question": "Question text",
      "recommended": "Recommended answer"
    }
  ]
}
```

When complete:

```json
{
  "complete": true,
  "questions": []
}
```
