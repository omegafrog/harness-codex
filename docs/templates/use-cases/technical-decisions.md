# <UC-ID>. <유스케이스 이름> Technical Decisions

## 1. 입력

- 유스케이스: `docs/use-cases/<UC-ID>/use-case.md`
- DDD design: `docs/use-cases/<UC-ID>/ddd-design.md`
- E2E goal: `docs/use-cases/<UC-ID>/e2e-goal.md`
- ChangeSet: `docs/changes/active/<CHG-ID>.md`
- Shared decisions: `docs/design/기술결정.md`

## 2. 구현 영향 결정

|영역|결정|이유|구현 반영|테스트/검증 반영|상태|
|---|---|---|---|---|---|
|Persistence| | | | |pending|
|Transaction| | | | |pending|
|External collaboration| | | | |pending|
|Retry/Circuit breaker| | | | |pending|
|Messaging/Outbox/Inbox| | | | |pending|
|Cache| | | | |pending|
|Observability/Audit| | | | |pending|

## 3. Repository 명령

|목적|명령|출처|
|---|---|---|
|Build|`./gradlew build`|`.codex/repository-settings.md`|
|Unit/Integration Test|`./gradlew test`|`.codex/repository-settings.md`|
|E2E Test|`./gradlew e2eTest`|`.codex/repository-settings.md`|

## 4. 미해결 결정

- 없음

## 5. Canonical 반영

- `docs/design/기술결정.md` 업데이트 필요 여부:
- 충돌 여부:
