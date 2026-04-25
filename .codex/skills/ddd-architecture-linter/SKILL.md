---
name: ddd-architecture-linter
description: Create, install, run, or modify Java/Spring DDD architecture linting infrastructure. Use when a user wants Codex to set up ArchUnit/Semgrep/Gradle/CI linting, run architecture lint checks, add a new architecture rule, change severity, disable or remove an existing rule, or update rules that prevent code from breaking domain/application/infra/controller, aggregate, messaging, transaction, or bounded-context boundaries.
---

# DDD Architecture Linter

## Purpose

Create, install, run, or modify static architecture checks for Java/Spring DDD projects. Prefer repository changes over illustrative output. If a repository already has linting infrastructure, update the existing ArchUnit/Semgrep/Gradle/CI files instead of generating a separate replacement.

The generated/installed infrastructure must include:

- `build.gradle` ArchUnit/Semgrep dependency snippets.
- A complete `ArchitectureRulesTest.java`.
- A complete `.semgrep/ddd-architecture.yml`.
- GitHub Actions CI example or patch.
- Local install/run commands for required tools.
- Violation examples, corrected examples, and phased rollout steps.

When modifying an existing linter, update only the relevant ArchUnit, Semgrep, Gradle, or CI rule/configuration and then run the available validation commands.

The goal is not style checking. The goal is to block code that breaks the chosen DDD implementation flow:

```text
Requirements -> Use Cases -> Event Storming -> Bounded Context
-> Domain Model -> Aggregate -> Application Service -> Communication
-> Infra / Adapter
```

## Core Philosophy

Always preserve these rules unless the user explicitly disables them:

- Domain contains business rules only.
- Application composes use case flow only.
- Infra owns external technology implementations.
- Controller calls Application Service only.
- Other bounded contexts' internal models are not referenced directly.
- State changes happen through aggregate behavior methods, not setters.
- Messaging goes through Outbox/Inbox and considers idempotency.

## Workflow

1. Parse the user's natural-language project description.
2. Determine the requested mode: initial install, add rule, modify rule, disable/remove rule, run validation, or repair failing architecture lint.
3. Inspect existing build files, ArchUnit tests, Semgrep configs, CI workflows, package structure, and source roots before editing.
4. Extract project info, package structure, bounded contexts, forbidden direct dependencies, disabled rules, and requested severities.
5. If information is missing, do not ask follow-up questions by default unless the requested edit would be unsafe or ambiguous. Use assumptions and list them in the final report.
6. Patch the repository directly. Generate new files only when existing lint infrastructure is absent.
7. Run available validation commands after changes when feasible.
8. If Semgrep is required by the requested lint workflow and `semgrep` is not available, attempt to install it after requesting approval for the install command. Do not stop at reporting that Semgrep is missing unless installation is unavailable, denied, or fails.

## Input Extraction

Extract these fields when present:

- Language, framework, build tool, root package.
- Domain, application, application port, infra, adapter, controller/web/api packages.
- Bounded context list.
- Explicitly forbidden direct dependencies.
- Disabled rules.
- JPA Entity and Domain Model separation.
- Messaging usage and required Outbox/Inbox policy.
- Requested operation: install, add rule, change rule, disable/remove rule, run lint, or fix lint failure.
- Existing build files, CI files, test source roots, ArchUnit tests, and Semgrep config locations.

Use these defaults when missing, and report them in `## 1. 가정`:

- Root package: `com.example`.
- Build tool: Gradle.
- Package structure: `domain`, `application`, `application.port`, `infra`, `adapter`, `controller`.
- JPA Entity and Domain Model: separated.
- Bounded contexts: none, unless inferred confidently from the user's examples.
- If the user asks for linting rules or changes to rules, patch the repository. Do not stop at examples unless the user explicitly says they only want a proposal.

## Interpretation

Map natural language to rules:

| User says | Interpret as |
|---|---|
| domain은 Spring을 몰라야 해 | domain must not depend on Spring |
| 도메인은 순수하게 유지해줘 | domain must not depend on Spring, JPA, infra, adapter |
| application은 구현체를 몰라야 해 | application must not depend on infra/adapter |
| service에서 jpa repository 바로 쓰지 마 | application must not depend on JpaRepository |
| 상태를 직접 바꾸면 안 돼 | forbid `setStatus`, `setState`, and direct status/state assignment |
| 다른 BC 내부 모델 가져오지 마 | forbid cross-BC domain dependency |
| KafkaTemplate 바로 쓰지 마 | forbid direct KafkaTemplate publishing |
| outbox 쓰게 해줘 | require Outbox instead of direct publish |
| 트랜잭션 안에서 외부 호출 조심 | warn on Client/Gateway calls inside `@Transactional` |
| 컨트롤러에서 도메인 반환하지 마 | warn/error on controller domain return |
| API DTO로 변환해 | require controller response DTO boundary |

## Default Rules

### Always ERROR

- Domain must not depend on Spring, infra, adapter, Kafka, Redis, WebClient, Feign.
- Domain must not have public setters.
- Domain must not be annotated as Spring components.
- Application must not depend on infra/adapter implementations.
- Application must not depend on JpaRepository directly.
- Application must not call `setStatus` or `setState` directly.
- Explicitly configured cross-BC domain/infra/adapter dependencies are forbidden.

If JPA Entity and Domain Model are combined, disable only the domain-to-JPA prohibition and list it under `## 비활성화된 규칙`.

### Default WARNING

- `@Transactional` method calls Client/Gateway/API/Broker/Publisher/Template.
- Controller returns a domain object directly.
- Query DTO is reused as command DTO.
- VO final fields are not enforced.

### Messaging ERROR When Messaging Is In Scope

- Application directly uses `KafkaTemplate`.
- Application directly calls publish/send on broker/event bus objects.
- Message publishing without Outbox.
- Message consuming without Inbox/idempotency.

## ArchUnit Requirements

Use ArchUnit for "who may depend on whom":

- Domain package dependency and annotation rules.
- Application package dependency rules.
- Controller dependency rules.
- Bounded context boundary rules.
- ApplicationService placement rules.

Generate explicit BC rules only for relationships the user listed. Do not create every BC pair unless the user asks for full isolation.

Use `ROOT_PACKAGE` in generated Java and make package patterns configurable from extracted values.

Read [references/archunit.md](references/archunit.md) for required rule shapes and code-generation notes.

## Semgrep Requirements

Use Semgrep for "what code shape is forbidden":

- Direct aggregate status/state mutation from application/service packages.
- Direct JpaRepository, WebClient, KafkaTemplate usage in application/service packages.
- Direct message publishing.
- Public setters in domain packages.
- Client/Gateway/Repository/Publisher/Template fields in domain packages.
- External calls inside `@Transactional` methods as warnings.

Read [references/semgrep.md](references/semgrep.md) for required YAML rules and severity guidance.

## Installation Requirements

When installing into a repository:

- Detect Gradle Groovy vs Kotlin DSL and patch the existing build file instead of replacing it.
- Add ArchUnit as a test dependency.
- Create the architecture test under the existing test source root, usually `src/test/java/<root package>/ArchitectureRulesTest.java`.
- Create `.semgrep/ddd-architecture.yml`.
- Add a CI workflow when the project uses GitHub Actions or the user requests CI.
- Add local run instructions, and add Gradle tasks only when they fit the existing build style.
- Do not install global programs silently. If Semgrep is not already available and local verification is expected, request approval and install it with the least invasive available method.
- Prefer `pipx install semgrep` when `pipx` exists, otherwise use `python3 -m pip install --user semgrep` when user-site installs are available, otherwise use Homebrew or Docker only if those tools are present and appropriate.
- Prefer CI Semgrep action for GitHub Actions as the CI path, but still attempt a local Semgrep install for local verification when the user asks to run or test the linter.

Read [references/installation.md](references/installation.md) before patching project files.

## Existing Rule Changes

When the user asks to add, modify, disable, or remove a rule:

- Locate existing ArchUnit tests and Semgrep YAML before creating new files.
- Preserve naming and formatting style of existing rules.
- Add ArchUnit rules for dependency/layer/BC relationship checks.
- Add Semgrep rules for code-shape checks.
- Change severity in Semgrep YAML when requested.
- For disabled rules, prefer removing or commenting the specific rule only when the project convention allows comments; otherwise document the disabled rule in final output.
- Do not duplicate equivalent rules with new IDs.
- Run `./gradlew architectureRules` or the closest existing Gradle test command.
- Run Semgrep if it is installed. If it is missing, request approval to install it and then run Semgrep. If installation is denied or fails, report the exact install and run commands plus the failure reason.

## Output Format

When creating or changing files, report in this order:

```markdown
# DDD Architecture Linter

## 1. 변경 요약
## 2. 변경 파일
## 3. 적용/수정된 규칙
## 4. 검증 결과
## 5. 실행 방법
## 6. 남은 주의 사항
```

When the user explicitly asks for a proposal only, use the longer artifact-oriented structure from the relevant references.

## Quality Bar

- Reflect the user's root package, package names, BC list, and explicit dependency constraints.
- Do not present assumed package names as facts.
- Do not force all BC combinations unless requested.
- Keep noisy rules as WARNING.
- Keep ArchUnit and Semgrep responsibilities separate.
- When installing, preserve existing build/CI style and avoid rewriting unrelated configuration.
- When changing existing rules, avoid duplicate rule IDs and update the existing rule in place.
- Make generated Java compile as far as possible without project-specific helper classes.
- Make generated Semgrep YAML runnable.
- Make local and CI execution paths explicit.
- Include violation/correction examples only when the user asks for them or when introducing a non-obvious new rule.
