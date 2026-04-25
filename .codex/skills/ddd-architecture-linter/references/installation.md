# Installation Reference

Use this when the user asks to install, apply, set up, or add the DDD architecture linter to a repository.
Also use this when the user asks to add, modify, disable, remove, run, or fix existing architecture lint rules.

## Repository Inspection

Inspect before editing:

- Build files: `build.gradle`, `build.gradle.kts`, `settings.gradle`, `settings.gradle.kts`, module build files.
- Test source roots: `src/test/java`, `src/test/kotlin`, module-specific test roots.
- Root package from existing Java files if the user did not provide one.
- Existing GitHub Actions workflows under `.github/workflows`.
- Existing Semgrep config under `.semgrep`, `semgrep.yml`, or `.semgrep.yml`.
- Existing ArchUnit tests, especially files named `*ArchitectureRulesTest.java`.
- Existing lint tasks such as `architectureRules`.
- Existing Gradle tasks and dependency version catalog.

Do not replace whole build files. Patch only the relevant dependency/task blocks.

## Files To Create Or Patch

Default install targets:

```text
build.gradle or build.gradle.kts
src/test/java/<root-package-path>/ArchitectureRulesTest.java
.semgrep/ddd-architecture.yml
.github/workflows/architecture-lint.yml
```

If the project is multi-module:

- Put `ArchitectureRulesTest.java` in the module that owns the Java/Spring code.
- Add ArchUnit dependency to that module's test dependencies.
- Put `.semgrep/ddd-architecture.yml` at repository root unless the user has a central config elsewhere.
- CI should run the module's test task or the aggregate architecture test task.

When modifying existing lint rules:

- Patch the existing `ArchitectureRulesTest.java` instead of creating a sibling file.
- Patch the existing Semgrep config instead of creating a second DDD config, unless no config exists.
- Preserve existing rule IDs when changing behavior.
- Use a new stable rule ID only for genuinely new Semgrep checks.
- Avoid broad rewrites of CI and Gradle files.

## Gradle Patching

Groovy DSL dependency:

```groovy
dependencies {
    testImplementation "com.tngtech.archunit:archunit-junit5:1.3.0"
}
```

Kotlin DSL dependency:

```kotlin
dependencies {
    testImplementation("com.tngtech.archunit:archunit-junit5:1.3.0")
}
```

If the project uses a version catalog, prefer adding:

```toml
[versions]
archunit = "1.3.0"

[libraries]
archunit-junit5 = { module = "com.tngtech.archunit:archunit-junit5", version.ref = "archunit" }
```

Then use:

```kotlin
testImplementation(libs.archunit.junit5)
```

Add an optional Gradle task only when it matches the style:

Groovy:

```groovy
tasks.register("architectureRules", Test) {
    useJUnitPlatform()
    include "**/*ArchitectureRulesTest.class"
}
```

Kotlin:

```kotlin
tasks.register<Test>("architectureRules") {
    useJUnitPlatform()
    include("**/*ArchitectureRulesTest.class")
}
```

If tests already use JUnit Platform globally, do not duplicate broad test configuration.

## Semgrep Installation

Do not silently install global tools. If local Semgrep verification is expected and `semgrep` is missing, request approval and install it instead of only reporting that it is unavailable.

Installation preference:

1. CI: use `semgrep/semgrep-action`.
2. Local with pipx when available: `pipx install semgrep`.
3. Local user install when pipx is unavailable: `python3 -m pip install --user semgrep`.
4. Local with Homebrew when available: `brew install semgrep`.
5. Local with Docker when available: `docker run --rm -v "$PWD:/src" semgrep/semgrep semgrep --config .semgrep/ddd-architecture.yml /src`.

If Codex needs to run `pipx`, `pip`, `brew`, or Docker image pulls and network access is blocked, request approval through the execution tool.

If all installation methods are unavailable, denied, or fail, report:

- the attempted command
- the failure reason
- the exact command the user can run later
- whether ArchUnit verification still passed

## CI Workflow

Default GitHub Actions workflow:

```yaml
name: Architecture Lint

on:
  pull_request:
  push:
    branches: [ main ]

jobs:
  architecture-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "21"
      - name: Run ArchUnit tests
        run: ./gradlew architectureRules
      - name: Run Semgrep
        uses: semgrep/semgrep-action@v1
        with:
          config: .semgrep/ddd-architecture.yml
```

Adjust Java version, Gradle command, branch names, and module paths to match the repo.

## Verification

After installing, run what is locally available:

```text
./gradlew architectureRules
semgrep --config .semgrep/ddd-architecture.yml src/main/java
```

If Semgrep is not installed, request approval to install it, then run Semgrep. Verify only ArchUnit only when Semgrep installation is unavailable, denied, or fails.

If dependency download fails because of sandboxed network access, request approval before retrying.

For rule-only changes, run the narrowest available checks:

```text
./gradlew architectureRules
semgrep --config .semgrep/ddd-architecture.yml src/main/java
```

If the repo has no `architectureRules` task, use:

```text
./gradlew test --tests '*ArchitectureRulesTest'
```

## Final Report

When installation mode edits files, final response must include:

- Files created or changed.
- Whether this was install, rule addition, rule modification, rule disable/remove, or validation-only mode.
- How to run ArchUnit locally.
- How to run Semgrep locally.
- Whether verification was run.
- Any commands skipped because a required tool was unavailable.
