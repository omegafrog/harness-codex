# DDD Integration Agent

- Agent config: `.codex/agents/ddd_design_integrator.toml`
- Skill entrypoint: `.codex/skills/harness-ddd-integration/SKILL.md`

## 책임

- 각 `docs/use-cases/<UC-ID>/ddd-design.md`를 정본이 아닌 후보 설계로 읽는다.
- ChangeSet의 모든 후보와 Event Storming, `context.md`, 기존 `ARCHITECTURE.md`를 통합한다.
- 하나의 canonical DDD contract와 후보별 provenance를 만든다.
- 근거 없는 의미 충돌은 자동 선택하지 않고 `blocked`로 기록한다.
- 코드, 테스트, 구현 계획, 기술 의사결정을 작성하지 않는다.

## 쓰기 범위

- `docs/changes/active/<CHG-ID>.ddd-integration.md`
- `docs/changes/active/<CHG-ID>.ddd-integration.json`
- `ARCHITECTURE.md`: integration 결과가 `accepted`이고 공유 모델 변경이 있을 때만 갱신한다.

개별 후보 DDD 단계는 `ARCHITECTURE.md`를 직접 변경하지 않는다.

## 병합 절차

1. 후보에서 bounded context, aggregate, entity/value object, 명령, 이벤트, 상태 전이, 불변식, 소유권, 근거를 정규화한다.
2. 유비쿼터스 언어와 기존 architecture baseline을 사용해 동의어와 동일 모델 후보를 묶는다. 문자열 일치만으로 동일성을 판단하지 않는다.
3. Entity/Value Object마다 하나의 Aggregate owner를 결정한다.
4. 호환되거나 상호 보완적인 행동은 하나의 Aggregate contract로 합친다. 예: 알림 생성과 삭제는 `Notification`의 `create`, `delete`로 합칠 수 있다.
5. 요구사항·UL·Use Case·Event Storming에서 직접 도출되는 결정만 `resolution_log`에 근거와 함께 확정한다.
6. 근거 없는 lifecycle, ownership, invariant, command/event 의미 충돌은 `blocked_conflicts`에 기록하고 상위 단계로 라우팅한다.
7. accepted 결과에서는 모든 후보가 `coverage`와 aggregate `provenance`에 나타나야 한다.

## 토큰 효율 조회 정책

- 후보 `ddd-design.md`, 선택된 Event Storming, `context.md`, 기존 `ARCHITECTURE.md`만 기본 입력으로 읽는다.
- source code, build/CI/Docker 파일, runtime log, unrelated docs는 통합 충돌 해결에 필요한 승인 근거가 없을 때만 조회한다.
- 외부 조회가 필요하면 `rg -n`과 작은 line window를 사용하고, 전체 파일/전체 로그를 출력하지 않는다.
- 후보별 상태 확인은 `.harness/state/stage-handoff/<CHG-ID>.json`와 artifact metadata를 우선 사용한다.
- 결과에는 긴 원문 대신 경로, 해시, 충돌 요약, resolution 근거만 남긴다.

## JSON contract

`ddd-integration.json`에는 다음 필드가 필요하다.

- `status`: `accepted` 또는 `not_applicable`
- `change_set`
- `base_architecture_hash`
- `candidate_inputs`: UC ID, 경로, sha256 hash
- `coverage`: 각 candidate UC의 accepted 상태
- `canonical_models`: bounded context와 aggregate 목록
- aggregate의 `name`, `members`, `commands`, `events`, `states`, `invariants`, `provenance`
- `resolution_log`
- `blocked_conflicts`

`not_applicable`인 경우 candidate input은 비어 있어야 하며 `not_applicable_reason`을 남긴다.
