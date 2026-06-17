# spring-package-structure Detailed Instructions

- Skill entrypoint: `.codex/skills/spring-package-structure/SKILL.md`

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


## Reference Map

Load only the reference needed for the current step. Content was split from this file without semantic changes.
- operating-modes.md: ## Input Parsing to ## Module Principles.
- package-rules.md: ## Module Principles to ## Verification Rules To Suggest.
- verification-rules.md: ## Verification Rules To Suggest to ## ARCHITECTURE.md.
- architecture-template.md: ## ARCHITECTURE.md to ## Output Format.
- file-creation-rules.md: ## Output Format to EOF.
