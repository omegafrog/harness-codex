---
name: grill-me
description: Ask focused clarification questions and include recommended answers.
---

# Grill-Me

Use this skill to clarify unresolved stage decisions.

Rules:
- Ask no more than three focused questions at a time.
- Prefer the most blocking unresolved decisions first.
- Ask only unresolved decisions needed for the current stage.
- Include a recommended answer for each question.
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