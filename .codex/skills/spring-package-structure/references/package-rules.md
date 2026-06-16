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

