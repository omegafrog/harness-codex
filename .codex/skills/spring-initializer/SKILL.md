---
name: spring-initializer
description: Initialize or add Spring Boot projects and modules using Spring Initializr conventions. Use when a user wants to create a new Spring project, reinitialize an empty or existing Spring project safely, add a new Gradle/Maven Spring module, or prepare baseline Spring Boot build files before applying package structure or implementation plans.
---

# Spring Initializer

## Purpose

Initialize Spring Boot project or module infrastructure before package-structure and implementation work.

Use this skill only for project/module bootstrapping. Do not design domain models, aggregates, entities, value objects, use cases, business policies, or DDD components.

## Core Rules

- Prefer Spring Initializr-compatible project metadata and layout.
- Preserve existing user code and configuration.
- Never wipe or reinitialize a non-empty project without explicit user approval.
- When adding a module to an existing multi-module project, patch the existing Gradle/Maven settings instead of replacing them.
- After initialization, the package skeleton may be refined by `spring-package-structure`.

## Input Parsing

Extract:

- Project name.
- Root package/group.
- Artifact/module name.
- Java version.
- Spring Boot version if specified.
- Build tool: Gradle Kotlin DSL, Gradle Groovy DSL, or Maven.
- Packaging: jar or war.
- Dependencies: web, validation, data-jpa, security, actuator, redis, kafka, lombok, testcontainers, etc.
- Whether this is a new project, existing project initialization, or new module addition.

Defaults when missing:

- Build tool: Gradle Kotlin DSL.
- Packaging: jar.
- Java version: use the repository's existing Java version if detectable, otherwise ask or use the current project convention.
- Dependencies: do not invent domain-specific dependencies. Use only Spring Boot starter test plus explicitly requested starters.

Ask before proceeding when:

- Root package/group is missing.
- Target directory is non-empty and the user asked to reinitialize it.
- Spring Boot version cannot be safely inferred and project compatibility matters.
- Adding a module but the parent build structure is ambiguous.

## Operating Modes

### New Project

Create or fetch a Spring Initializr-compatible project skeleton:

```text
settings.gradle.kts
build.gradle.kts
src/main/java/{rootPackagePath}/{ApplicationClass}.java
src/test/java/{rootPackagePath}/{ApplicationClass}Tests.java
```

If network access to Spring Initializr is unavailable, create the equivalent minimal Spring Boot skeleton locally and report that it was generated from Initializr-compatible conventions.

### Existing Project Initialization

Inspect existing files first:

- `settings.gradle(.kts)`
- `build.gradle(.kts)`
- `pom.xml`
- `src/main`
- `src/test`

If the project already contains code, patch only missing baseline Spring Boot configuration. Do not overwrite existing source files.

### New Module Addition

For Gradle multi-module projects:

- Create module directory.
- Add module to `settings.gradle` or `settings.gradle.kts`.
- Create module `build.gradle` or `build.gradle.kts` matching existing style.
- Add baseline `src/main/java` and `src/test/java` roots.
- If the module is executable, add a Spring Boot application class.
- If the module is a feature/library module, do not add an application class unless requested.

For Maven multi-module projects:

- Patch parent `pom.xml` modules.
- Create child `pom.xml`.
- Add source/test roots.

## Spring Initializr Usage

When network is available and the user wants official Initializr output, use `start.spring.io` with equivalent parameters.

Typical API shape:

```text
https://start.spring.io/starter.zip?type=gradle-project-kotlin&language=java&bootVersion=<version>&baseDir=<project>&groupId=<group>&artifactId=<artifact>&name=<name>&packageName=<rootPackage>&packaging=jar&javaVersion=<java>&dependencies=web,validation
```

Respect network sandbox rules. If `curl` or dependency download fails because of network restrictions, request approval before retrying.

## Output/Edits

When editing files, report:

- Initialization mode: new project, existing project baseline, or new module.
- Files created.
- Files patched.
- Assumptions.
- Commands run.
- Any skipped network Initializr call and local fallback.

## Handoff

After Spring initialization:

- Use `spring-package-structure` to create feature module package skeletons and `ARCHITECTURE.md`.
- Use `ddd-architecture-linter` later for ArchUnit/Semgrep linting infrastructure.
- Use implementation planner to record these steps in `docs/plans/active/plan.md`.

## Safety

- Do not delete existing project files.
- Do not overwrite existing build files wholesale.
- Do not add dependencies not requested or required by Spring Boot baseline/test setup.
- Do not generate domain placeholders.
- Do not generate sample controllers/services/repositories/entities.
