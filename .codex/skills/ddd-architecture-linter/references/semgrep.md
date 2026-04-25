# Semgrep Reference

Use Semgrep for local code patterns that ArchUnit does not express well.

## Required YAML Shape

Always generate a complete runnable file:

```yaml
rules:
  - id: ...
    languages: [java]
    severity: ERROR
    message: "..."
    paths:
      include:
        - "src/main/java/**/*.java"
    patterns:
      - ...
```

## Core ERROR Rules

### Application Service Direct Status Mutation

```yaml
- id: no-direct-status-mutation-in-application
  languages: [java]
  severity: ERROR
  message: "Application Service에서 상태를 직접 변경하면 안 된다. Aggregate의 행위 메서드를 호출해야 한다."
  paths:
    include:
      - "src/main/java/**/application/**/*.java"
      - "src/main/java/**/service/**/*.java"
  patterns:
    - pattern-either:
        - pattern: $OBJ.setStatus(...)
        - pattern: $OBJ.status = ...
        - pattern: $OBJ.setState(...)
        - pattern: $OBJ.state = ...
```

### Application Service Direct JpaRepository

```yaml
- id: no-jpa-repository-in-application-service
  languages: [java]
  severity: ERROR
  message: "Application Service는 JpaRepository 구현체에 직접 의존하면 안 된다. Repository Port에 의존해야 한다."
  paths:
    include:
      - "src/main/java/**/application/**/*.java"
      - "src/main/java/**/service/**/*.java"
  patterns:
    - pattern-either:
        - pattern: |
            private final $REPO $FIELD;
        - pattern: |
            private $REPO $FIELD;
    - metavariable-regex:
        metavariable: $REPO
        regex: ".*(JpaRepository|CrudRepository|Jpa.*Repository)$"
```

### Application Service Direct WebClient

```yaml
- id: no-webclient-in-application-service
  languages: [java]
  severity: ERROR
  message: "Application Service에서 WebClient를 직접 사용하면 안 된다. Client Port와 Adapter로 분리해야 한다."
  paths:
    include:
      - "src/main/java/**/application/**/*.java"
      - "src/main/java/**/service/**/*.java"
  patterns:
    - pattern-either:
        - pattern: |
            private final WebClient $FIELD;
        - pattern: |
            WebClient $VAR = ...
        - pattern: $WEBCLIENT.get()
        - pattern: $WEBCLIENT.post()
```

### Application Service Direct KafkaTemplate

```yaml
- id: no-kafka-template-in-application-service
  languages: [java]
  severity: ERROR
  message: "Application Service에서 KafkaTemplate을 직접 사용하면 안 된다. Outbox 또는 Message Port를 사용해야 한다."
  paths:
    include:
      - "src/main/java/**/application/**/*.java"
      - "src/main/java/**/service/**/*.java"
  patterns:
    - pattern-either:
        - pattern: |
            private final KafkaTemplate<$K, $V> $FIELD;
        - pattern: $KAFKA_TEMPLATE.send(...)
```

### Application Service Direct Message Publish

```yaml
- id: no-direct-message-publish-in-application-service
  languages: [java]
  severity: ERROR
  message: "Application Service에서 메시지를 직접 발행하면 안 된다. OutboxRepository에 저장한 뒤 별도 Publisher가 발행해야 한다."
  paths:
    include:
      - "src/main/java/**/application/**/*.java"
      - "src/main/java/**/service/**/*.java"
  patterns:
    - pattern-either:
        - pattern: $PUBLISHER.publish(...)
        - pattern: $BROKER.publish(...)
        - pattern: $EVENT_BUS.publish(...)
        - pattern: $MESSAGE_BROKER.send(...)
        - pattern: $MESSAGE_BROKER.publish(...)
```

### Domain Public Setter

```yaml
- id: no-public-setter-in-domain
  languages: [java]
  severity: ERROR
  message: "Domain 객체에 public setter를 두면 안 된다. 상태 변경은 의도가 드러나는 행위 메서드로 해야 한다."
  paths:
    include:
      - "src/main/java/**/domain/**/*.java"
  pattern: |
    public void set$FIELD(...) {
      ...
    }
```

### Domain External Collaborator Field

```yaml
- id: no-client-gateway-in-domain
  languages: [java]
  severity: ERROR
  message: "Domain 객체는 Client/Gateway/Repository 같은 외부 협력 객체에 의존하면 안 된다."
  paths:
    include:
      - "src/main/java/**/domain/**/*.java"
  patterns:
    - pattern-either:
        - pattern: |
            private final $TYPE $FIELD;
        - pattern: |
            private $TYPE $FIELD;
    - metavariable-regex:
        metavariable: $TYPE
        regex: ".*(Client|Gateway|Repository|Publisher|Template)$"
```

## Warning Rules

### External Call Inside Transaction

```yaml
- id: external-call-inside-transaction
  languages: [java]
  severity: WARNING
  message: "@Transactional 안에서 외부 Client/Gateway 호출이 있다. DB 트랜잭션과 외부 호출 분리를 검토해야 한다."
  paths:
    include:
      - "src/main/java/**/*.java"
  patterns:
    - pattern-inside: |
        @Transactional
        public $RET $METHOD(...) {
          ...
        }
    - pattern: $TARGET.$CALL(...)
    - metavariable-regex:
        metavariable: $TARGET
        regex: ".*(Client|Gateway|Api|Broker|Publisher|Template)$"
```

### Controller Returns Domain Object

Use only when package naming makes domain responses detectable:

```yaml
- id: controller-should-not-return-domain-object
  languages: [java]
  severity: WARNING
  message: "Controller는 Domain 객체를 그대로 반환하지 말고 Response DTO로 변환해야 한다."
  paths:
    include:
      - "src/main/java/**/controller/**/*.java"
      - "src/main/java/**/web/**/*.java"
      - "src/main/java/**/api/**/*.java"
  patterns:
    - pattern: |
        public $DOMAIN $METHOD(...) {
          ...
        }
    - metavariable-regex:
        metavariable: $DOMAIN
        regex: ".*(Payment|Reservation|Seat|User|Event|Queue|Aggregate)$"
```

Adapt the regex to the user's actual bounded-context/domain names.

## CI Example

Prefer CI-managed Semgrep so users do not need a global install on every developer machine.

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

If no `architectureRules` Gradle task is installed, use:

```yaml
      - name: Run ArchUnit tests
        run: ./gradlew test --tests '*ArchitectureRulesTest'
```

## Local Semgrep Options

Document at least one local run command:

```bash
semgrep --config .semgrep/ddd-architecture.yml src/main/java
```

If Semgrep is missing, document installation options instead of assuming a global install:

```bash
pipx install semgrep
brew install semgrep
docker run --rm -v "$PWD:/src" semgrep/semgrep semgrep --config .semgrep/ddd-architecture.yml /src
```

## Suppression Guidance

If a warning is intentionally accepted, recommend project-standard suppression:

- Semgrep: `// nosemgrep: rule-id` with a reason in the same line or adjacent comment.
- ArchUnit: narrow package exclusions only when the project has a documented exception.

Never hide ERROR rules through broad path exclusions unless the user explicitly asks.
