---
name: grill-me
description: Ask focused clarification questions and include recommended answers.
---

# Grill-Me

Use this skill to clarify unresolved stage decisions.

Rules:
- Ask exactly three focused questions at a time when at least three unresolved decisions remain.
- Ask fewer than three only when fewer unresolved decisions remain.
- Include a recommended answer for each question.
- Prefer the most blocking stage decision first.
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
