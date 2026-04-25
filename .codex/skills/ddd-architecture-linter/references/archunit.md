# ArchUnit Reference

Use ArchUnit for package dependencies, layer direction, bounded-context boundaries, and role constraints.

## Required Imports

Generated tests should generally include:

```java
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Controller;
import org.springframework.stereotype.Repository;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.RestController;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.methods;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noMethods;
```

Prefer package-private test class:

```java
@AnalyzeClasses(
        packages = ArchitectureRulesTest.ROOT_PACKAGE,
        importOptions = ImportOption.DoNotIncludeTests.class
)
class ArchitectureRulesTest {
    static final String ROOT_PACKAGE = "com.example";
}
```

## Gradle Dependencies

For Gradle:

```groovy
dependencies {
    testImplementation "com.tngtech.archunit:archunit-junit5:1.3.0"
}
```

If the project uses Kotlin DSL, adapt to:

```kotlin
dependencies {
    testImplementation("com.tngtech.archunit:archunit-junit5:1.3.0")
}
```

Optional dedicated task:

```groovy
tasks.register("architectureRules", Test) {
    useJUnitPlatform()
    include "**/*ArchitectureRulesTest.class"
}
```

For Kotlin DSL:

```kotlin
tasks.register<Test>("architectureRules") {
    useJUnitPlatform()
    include("**/*ArchitectureRulesTest.class")
}
```

When installing into an existing repo, patch the existing Gradle style and avoid duplicating dependency entries.

## Domain Rules

Generate these unless disabled:

```java
@ArchTest
static final ArchRule domain_should_not_depend_on_spring_or_infra =
        noClasses()
                .that().resideInAPackage("..domain..")
                .should().dependOnClassesThat()
                .resideInAnyPackage(
                        "org.springframework..",
                        "org.springframework.data..",
                        "org.springframework.web..",
                        "org.springframework.kafka..",
                        "org.springframework.web.reactive.function.client..",
                        "org.springframework.cloud.openfeign..",
                        "jakarta.persistence..",
                        "javax.persistence..",
                        ROOT_PACKAGE + "..infra..",
                        ROOT_PACKAGE + "..adapter.."
                )
                .because("Domain은 비즈니스 규칙만 가져야 하고 외부 기술 구현에 의존하면 안 된다.");
```

If the user combines JPA Entity and Domain Model, remove only `jakarta.persistence..` and `javax.persistence..`.

```java
@ArchTest
static final ArchRule domain_should_not_be_spring_component =
        noClasses()
                .that().resideInAPackage("..domain..")
                .should().beAnnotatedWith(Service.class)
                .orShould().beAnnotatedWith(Component.class)
                .orShould().beAnnotatedWith(Repository.class)
                .orShould().beAnnotatedWith(Controller.class)
                .orShould().beAnnotatedWith(RestController.class)
                .because("Domain 객체는 Spring Bean이나 HTTP 어댑터가 아니어야 한다.");
```

```java
@ArchTest
static final ArchRule domain_should_not_have_public_setter =
        noMethods()
                .that().areDeclaredInClassesThat().resideInAPackage("..domain..")
                .and().haveNameMatching("set[A-Z].*")
                .should().bePublic()
                .because("상태 변경은 Aggregate 행위 메서드로 해야 한다.");
```

## Application Rules

```java
@ArchTest
static final ArchRule application_should_not_depend_on_infra_or_adapter =
        noClasses()
                .that().resideInAPackage("..application..")
                .should().dependOnClassesThat()
                .resideInAnyPackage(
                        ROOT_PACKAGE + "..infra..",
                        ROOT_PACKAGE + "..adapter.."
                )
                .because("Application Service는 구현체가 아니라 Port에 의존해야 한다.");
```

```java
@ArchTest
static final ArchRule application_should_not_depend_on_technology_clients =
        noClasses()
                .that().resideInAPackage("..application..")
                .should().dependOnClassesThat()
                .resideInAnyPackage(
                        "org.springframework.data.jpa.repository..",
                        "org.springframework.web.reactive.function.client..",
                        "org.springframework.kafka.core..",
                        "org.springframework.cloud.openfeign.."
                )
                .because("Application Service는 JpaRepository, WebClient, KafkaTemplate, FeignClient를 직접 알면 안 된다.");
```

```java
@ArchTest
static final ArchRule application_services_should_reside_in_application =
        classes()
                .that().haveSimpleNameEndingWith("ApplicationService")
                .should().resideInAPackage("..application..")
                .because("Application Service는 application 계층에 위치해야 한다.");
```

## Controller Rules

```java
@ArchTest
static final ArchRule controller_should_not_depend_on_repository =
        noClasses()
                .that().resideInAnyPackage("..controller..", "..web..", "..api..")
                .should().dependOnClassesThat()
                .haveSimpleNameEndingWith("Repository")
                .because("Controller는 Repository를 직접 호출하지 않고 Application Service만 호출해야 한다.");
```

```java
@ArchTest
static final ArchRule controller_should_not_depend_on_infra_or_adapter =
        noClasses()
                .that().resideInAnyPackage("..controller..", "..web..", "..api..")
                .should().dependOnClassesThat()
                .resideInAnyPackage(
                        ROOT_PACKAGE + "..infra..",
                        ROOT_PACKAGE + "..adapter.."
                )
                .because("Controller는 외부 기술 구현체에 직접 의존하면 안 된다.");
```

Controller domain return checks are often noisy in ArchUnit. Prefer Semgrep WARNING unless the project has consistent response DTO naming.

## Bounded Context Rules

For each explicit forbidden dependency relation, generate a named rule:

```java
@ArchTest
static final ArchRule payment_should_not_depend_on_seat_internal_model =
        noClasses()
                .that().resideInAPackage(ROOT_PACKAGE + "..payment..")
                .should().dependOnClassesThat()
                .resideInAnyPackage(
                        ROOT_PACKAGE + "..seat.domain..",
                        ROOT_PACKAGE + "..seat.infra..",
                        ROOT_PACKAGE + "..seat.adapter.."
                )
                .because("Payment BC는 Seat BC 내부 모델을 직접 참조하면 안 된다. Port 또는 Client를 사용해야 한다.");
```

Rules:

- Generate only explicit relations unless the user asks for full BC isolation.
- Include `{toBC}.domain`, `{toBC}.infra`, `{toBC}.adapter`.
- Do not block `{toBC}.application.port` if cross-BC collaboration through a port is intentional.
- Name rules with lower snake case.

## Test Existence Recommendations

If the user asks for test existence checks, describe them as optional custom rules or Gradle tasks:

- Aggregate class should have corresponding unit test.
- Application Service should have use case test.
- Outbox Publisher should have retry test.
- Inbox Handler should have duplicate message test.

Keep these as recommendations unless the project has reliable naming conventions.
