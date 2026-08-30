---
name: gh-open-pr
description: Write GitHub pull request bodies with automatic issue-closing triggers. Use when creating or editing a PR and the body must close an issue when merged.
---

# gh-open-pr

## Overview

Write a GitHub pull request body. Add a closing trigger when the linked issue should close after merge.

## Core Rules

- When automatic closing is required, state it on one line in the PR body.
- Recommended phrases: `Closes #123`, `Fixes #123`, `Resolves #123`
- Use `#123` for issues in the same repository.
- Put one closing trigger on each line when closing multiple issues.
- Do not add a closing trigger when the issue must remain open.
- Do not rely on the title; include the trigger in the body.

## Writing Order

1. Confirm the linked issue number and repository scope.
2. Write a PR title that makes the issue intent clear.
3. Add the implementation intent or problem, change flow, and test or verification results to the body.
4. Include a Mermaid diagram when it makes the change flow easier to understand.
5. Record the test and verification results.
6. Put the closing line at the bottom when the issue should close.
7. Confirm that the closing phrase targets the intended issue and will close it on merge.

## Body Example

```md
## Implementation Intent / Problem
- Implement comment creation for authenticated users.
- Fix unauthenticated access to the comment creation API.

## Change Flow
- On login, `loginService` validates the username/password match, then `TokenProvider` issues an access token.


```mermaid
```

## Verification
- Confirmed successful comment creation through `Postman` after login.

Closes #123
```

## Notes

- Automatic closing usually occurs when the PR merges into the default branch.
- Use the correct repository qualifier for issues in another repository.
- Do not leave a closing trigger on an issue that should remain open.
