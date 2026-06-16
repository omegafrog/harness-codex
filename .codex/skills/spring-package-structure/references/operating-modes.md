## Input Parsing

Extract these fields from natural language:

| Field | Required | Default |
|---|---:|---|
| `projectName` | no | infer from repo or root package, otherwise `app` |
| `rootPackage` | yes | ask if missing |
| `modules` | yes | ask if missing |
| `buildTool` | no | Gradle |
| `architectureStyle` | no | `ddd-lite` |
| `includeTestStructure` | no | `true` |

If `rootPackage` or `modules` is missing, ask a concise question before generating or editing files.

Normalize:

- Module names to kebab-case for Gradle project names.
- Java package segments to lowercase alphanumeric package names.
- `app` as the Spring Boot executable module.
- `common` as the global shared type module.

## Operating Modes

- If the user asks to "제안", "설계", "구조만 보여줘", output the structure and rules without editing files.
- If the user asks to "생성", "만들어줘", "적용", "세팅", "프로젝트에 추가", create or patch files in the repository.
- When patching, inspect existing Gradle files and source roots first. Preserve existing style and do not overwrite unrelated content.
- In create/patch mode, always create or update root `ARCHITECTURE.md`.
- In proposal mode, include the proposed `ARCHITECTURE.md` content as a section but do not write the file.

