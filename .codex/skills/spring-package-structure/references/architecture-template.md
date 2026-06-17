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

