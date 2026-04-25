---
name: spring-package-structure
description: Create or propose initial Spring Boot module and package skeletons plus an executor-facing ARCHITECTURE.md. Use when a user gives a root package and module list and wants Gradle multi-module layout, empty Spring package structure, dependency direction, package responsibilities, starter files or .gitkeep placeholders, ARCHITECTURE.md implementation guidance, and ArchUnit/Semgrep-checkable structure rules without generating domain models, aggregates, entities, value objects, business policies, or use case details.
---

# Spring Package Structure

## Purpose

Create the initial empty structure for a Spring project so later implementation has clear module boundaries and dependency direction.

This skill does not design domain knowledge. Do not infer or generate:

- Domain model names.
- Aggregates.
- Entity or VO classes.
- Business policies.
- Detailed use case flows.
- Arbitrary domain names not given by the user.
- Meaningless placeholders such as `SampleEntity`, `BaseDomain`, or `AbstractAggregate`.

Only produce:

- Gradle multi-module structure proposal or repository patch.
- Spring package structure.
- Layer responsibilities.
- Dependency direction.
- Initial empty class/interface locations or `.gitkeep` placeholders.
- Root `ARCHITECTURE.md` that future executors must read before implementation.
- ArchUnit/Semgrep-checkable structure rules.

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

## Module Principles

Use feature boundaries as modules:

```text
{projectName}
├── {projectName}-app
├── {projectName}-common
├── {projectName}-{featureA}
└── {projectName}-{featureB}
```

Rules:

- `app` is the executable Spring Boot module.
- `common` contains only global shared types.
- Every other module is an independent feature boundary.
- Feature modules depend on `common` by default.
- `app` depends on `common` and all feature modules.
- Feature modules may depend on another feature module's `api` package only.
- Feature modules must not depend on another feature module's `domain`, `infrastructure`, or `presentation`.

## Feature Module Package Structure

For each non-`app`, non-`common` module, create this structure:

```text
{rootPackage}.{module}
├── api
├── presentation
├── application
│   ├── command
│   ├── query
│   ├── result
│   └── port
│       ├── in
│       └── out
├── domain
│   ├── model
│   ├── event
│   └── exception
└── infrastructure
    ├── persistence
    ├── client
    ├── messaging
    └── config
```

Use `.gitkeep` files for empty packages unless the user asks for concrete starter interfaces. Prefer `.gitkeep` because this skill must not invent domain concepts.

If test structure is enabled:

```text
src/test/java/{rootPackagePath}/{module}
├── application
├── domain
└── infrastructure
```

## Package Responsibilities

### `api`

Public contract usable by other modules. It may contain `command`, `result`, and `{ModuleName}Api.java` only when the user asks for starter interfaces.

Rules:

- Do not expose internal domain objects.
- Other modules may reference only this package.
- Do not reference `domain`, `infrastructure`, or `presentation` from external modules.

### `presentation`

HTTP controllers and request/response DTOs.

Responsibilities:

- Receive HTTP requests.
- Convert request DTOs to application commands.
- Call application service.
- Convert results to response DTOs.

Forbidden:

- Business/domain rules.
- Direct repository calls.
- Direct infrastructure calls.

### `application`

Use case orchestration layer.

Responsibilities:

- Transaction boundary.
- Domain object calls.
- Repository port calls.
- External system port calls.
- Use case flow composition.

Forbidden:

- Direct entity state mutation.
- SQL/JPA/Redis implementation dependency.
- Direct HTTP client dependency.

### `application.port.in`

Optional inbound use case contracts. Keep empty for simple structures unless requested.

### `application.port.out`

Output ports so application does not depend on implementation technology.

May later contain:

- Repository contracts.
- External API contracts.
- Messaging publisher contracts.
- Cache/Redis access contracts.

Implementations belong in `infrastructure`.

### `domain`

Location for future domain objects only.

Create empty `model`, `event`, and `exception` packages. Do not create domain classes.

### `infrastructure`

Technology implementations:

- JPA entities.
- Spring Data repositories.
- Repository adapters.
- HTTP client adapters.
- Message consumer/publisher adapters.
- Redis adapters.
- Technical configuration.

Forbidden:

- Controller directly calling infrastructure.
- Domain referencing infrastructure.
- Application referencing infrastructure implementations.

### `common`

Use:

- Common exceptions.
- Time abstraction.
- Common event interfaces.
- Identifier base types.
- Common response wrappers.
- Page response.

Do not use common for:

- Feature-specific domain models.
- Feature-specific status values.
- Feature-specific repositories.
- Feature-specific DTOs.

`common` is not a dumping ground.

### `app`

Spring Boot executable module:

```text
{rootPackage}
├── {ProjectName}Application.java
└── global
    ├── config
    ├── exception
    ├── security
    └── web
```

Rules:

- Own Spring Boot startup.
- Own global config, security, exception handling, and web config.
- Do not contain business logic.
- Do not directly depend on feature module internals beyond normal Spring composition.

## Dependency Direction

Inside a feature module:

```text
presentation -> application -> domain
infrastructure -> application.port.out -> domain
```

Module direction:

```text
app -> common
app -> feature modules
feature module -> common
feature module -> other feature module api only
feature module -> other feature module domain/infrastructure/presentation forbidden
```

## Gradle Guidance

For Kotlin DSL settings:

```kotlin
rootProject.name = "{projectName}"

include(
    "{projectName}-app",
    "{projectName}-common",
    "{projectName}-{moduleA}",
    "{projectName}-{moduleB}"
)
```

Feature module dependencies:

```kotlin
dependencies {
    implementation(project(":{projectName}-common"))
}
```

App module dependencies:

```kotlin
dependencies {
    implementation(project(":{projectName}-common"))
    implementation(project(":{projectName}-{moduleA}"))
    implementation(project(":{projectName}-{moduleB}"))
}
```

Adapt to Groovy DSL if the repo uses `settings.gradle` or `build.gradle`.

## Forbidden Structure

Do not create top-level technical layers like:

```text
com.example
├── controller
├── service
├── repository
├── entity
└── dto
```

Prefer:

```text
com.example.payment
├── presentation
├── application
├── domain
└── infrastructure
```

## Verification Rules To Suggest

Suggest these rules after structure generation:

- `..presentation..` must not depend on `..infrastructure..`.
- `..domain..` must not depend on `..application..`, `..presentation..`, or `..infrastructure..`.
- `..application..` must not depend on `..infrastructure..`.
- `..infrastructure..` may depend on `..domain..` and `..application.port.out..`.
- `{moduleA}` may depend on `{moduleB}.api`.
- `{moduleA}` must not depend on `{moduleB}.domain`, `{moduleB}.infrastructure`, or `{moduleB}.presentation`.

## ARCHITECTURE.md

Create or update root `ARCHITECTURE.md` whenever the structure is generated or patched. This file is the executor-facing contract for later implementation work.

Rules:

- Keep it factual and structural.
- Do not add domain model names, aggregate names, entity names, business policies, or use case details.
- Include only decisions derived from the user's module/package input and this skill's structure rules.
- If the file already exists, update the sections owned by this skill without deleting unrelated user-authored sections.
- Make clear that executors must read `ARCHITECTURE.md` before adding code.

Use this template:

~~~markdown
# Architecture

## Purpose
This document defines the initial Spring module and package structure that executors must follow before adding implementation code.

## Scope
- Defines Gradle modules.
- Defines package responsibilities.
- Defines dependency direction.
- Defines forbidden references.
- Does not define domain models, aggregates, entities, value objects, business policies, or use case flows.

## Project Inputs
- Project name: `{projectName}`
- Root package: `{rootPackage}`
- Build tool: `{buildTool}`
- Architecture style: `{architectureStyle}`
- Test structure: `{includeTestStructure}`

## Modules
| Module | Role |
|---|---|
| `{projectName}-app` | Spring Boot executable module and global configuration |
| `{projectName}-common` | Global shared types only |
| `{projectName}-{feature}` | Feature boundary module |

## Feature Module Package Layout
Each feature module must use:

```text
{rootPackage}.{module}
├── api
├── presentation
├── application
│   ├── command
│   ├── query
│   ├── result
│   └── port
│       ├── in
│       └── out
├── domain
│   ├── model
│   ├── event
│   └── exception
└── infrastructure
    ├── persistence
    ├── client
    ├── messaging
    └── config
```

## Package Responsibilities
| Package | Responsibility | Forbidden |
|---|---|---|
| `api` | Public contract for other modules | Exposing internal domain objects |
| `presentation` | HTTP controllers and request/response mapping | Domain rules, repository calls, infrastructure calls |
| `application` | Use case orchestration and transaction boundary | Infrastructure implementation dependency, direct entity state mutation |
| `application.port.in` | Optional inbound use case contracts | Domain-specific invention without design input |
| `application.port.out` | Repository/external API/messaging/cache ports | Technology implementation |
| `domain` | Future domain model/event/exception location | Spring, application, presentation, infrastructure dependency |
| `infrastructure` | Persistence/client/messaging/config implementations | Being called directly by presentation/domain |

## Common Module Rules
`common` may contain global exceptions, time abstractions, common event interfaces, identifier base types, common response wrappers, and page responses.

`common` must not contain feature-specific domain models, status values, repositories, or DTOs.

## App Module Rules
`app` owns Spring Boot startup, global configuration, security, exception handling, and web configuration.

`app` must not contain business logic.

## Dependency Direction
```text
presentation -> application -> domain
infrastructure -> application.port.out -> domain

app -> common
app -> feature modules
feature module -> common
feature module -> other feature module api only
feature module -> other feature module domain/infrastructure/presentation forbidden
```

## Forbidden Structures
Do not create top-level technical packages such as `controller`, `service`, `repository`, `entity`, or `dto` under the root package.

Do not create placeholder domain classes such as `SampleEntity`, `BaseDomain`, or `AbstractAggregate`.

## Executor Checklist
- Read this file before creating implementation code.
- Add new code inside the correct feature module.
- Use `presentation`, `application`, `domain`, and `infrastructure` according to their responsibilities.
- Expose cross-module contracts through `api`.
- Do not reference another feature module's internal packages.
- Do not invent domain models before the domain design exists.

## Lintable Rules
- `..presentation..` must not depend on `..infrastructure..`.
- `..domain..` must not depend on `..application..`, `..presentation..`, or `..infrastructure..`.
- `..application..` must not depend on `..infrastructure..`.
- Feature modules may depend on another feature module's `api` package only.
~~~

## Output Format

Always output in this order:

1. 적용 기준
2. 전체 모듈 구조
3. 모듈별 패키지 구조
4. 패키지별 책임
5. 의존성 방향
6. 생성할 초기 파일 목록
7. ARCHITECTURE.md 내용
8. 금지 규칙
9. 검증 규칙 예시
10. 최종 복사용 구조

When files are created or patched, add a short implementation summary before the final structure:

- Created/changed files.
- Whether `ARCHITECTURE.md` was created or updated.
- Assumptions.
- Commands run.
- Verification result if any.

## File Creation Rules

When creating structure:

- Use `.gitkeep` to preserve empty directories.
- Create Gradle module directories only for modules requested by the user.
- Create package directories under `src/main/java/{rootPackagePath}/{modulePackage}`.
- Create test directories only when `includeTestStructure` is true.
- Create or update root `ARCHITECTURE.md`.
- Do not create domain classes.
- Do not create sample controllers, services, repositories, entities, DTOs, or use cases unless the user explicitly asks for starter code.
- If starter code is requested, keep it contract-only and avoid domain-specific names not supplied by the user.
