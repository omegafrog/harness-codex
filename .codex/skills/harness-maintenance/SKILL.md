---
name: harness-maintenance
description: Update the project-local Harness runtime when the user asks to update, upgrade, or refresh Harness; do not use for application dependency updates.
---

# Harness Maintenance

Use this skill for requests such as “하네스 업데이트해”, “Harness 업그레이드해”, or “refresh the Harness runtime”. The target is the Harness runtime in the current consumer repository, not the application’s package dependencies.

1. Resolve the current repository root with `git rev-parse --show-toplevel`. Do not update a parent checkout, another worktree, or the Harness source repository by assumption.
2. Check that `.codex/harness-lock.json` exists at that root. If it is absent, explain that this checkout is not installed or has no update baseline; do not substitute installation for an update request without the user's direction.
3. Run the update from any directory with the explicit target:

   ```bash
   npx --yes github:omegafrog/harness-codex update --project <repository-root>
   ```

4. `Project readiness: blocked` 또는 doctor의 `project_preparation_required`이면 [setup의 준비 복구](../setup/SKILL.md#설치업데이트-및-구현-전-준비-복구)를 실행해 실제 실행 프로필과 통합 계약을 보완한다. 런타임 파일 배치 성공을 workflow 완료로 보고하지 않는다. 기존 업무 코드·stash·tracker 상태는 보존한다. 그런 다음 진단을 재실행한다.

   Run the installed version's diagnostic command:

   ```bash
   npx --yes --package github:omegafrog/harness-codex harness-codex-doctor --project <repository-root>
   ```

5. Report updated and added files, any `Preserved` files, and the diagnostic result. Never run `harness-codex lock` for preserved files automatically: it accepts the current local content as the new baseline, so the user must review and merge those files first.

The updater preserves files that the project changed locally. A `locally_modified` result means only the checkout changed it; `conflict` means both the checkout and Harness changed it. When either appears, identify the path and preserve it by default. If the user explicitly requests force install/update or replacing local Harness modifications, run the same install/update command with `--force`; this backs up and replaces all selected managed assets, including skills and supporting files. Do not ask for the same authorization again, hand-copy individual skills, or run lock to hide conflicts. Report the backup directory.

## 통합 계약 도구 갱신

관리되는 `.harness/contracts.mjs`와 `.github/workflows/harness-contracts.yml`, `.codex/tools/plantuml-*.mjs`의 설치/충돌 결과를 확인한다. 기본 업데이트는 기존 사용자 수정 파일을 보존한다. 명시적 force 요청은 공통 CLI --force로 관리 자산 전체에 적용하고 세션 백업 위치를 보고한다. 최초 도입으로 대상 `docs/contracts`가 없으면 `sync-contracts`로 실제 업무 모델을 bootstrap하고, `contract_docs` pass 전에 workflow 정상 완료를 선언하지 않는다.

## 설치·진단 정합성

install/update는 같은 native asset synchronizer를 사용하며 PR 템플릿도 관리한다. 프로젝트 설정 .codex/harness.yaml과 업무 문서는 force 대상이 아니다. retired lock 항목은 원장만 제거하며 과거 파일은 보존한다. doctor는 최신 upstream inventory의 skill supporting files·tools·contracts·CI·PR을 stale로 오인하지 않아야 한다. eval의 permission_profile은 event label이며 실제 sandbox/network 설정을 검사한다. 명시적 native permission-profile 참조가 있을 때만 실제 inventory 확인이 필요하다. 오류를 없애기 위해 권한 이름을 임의로 승인하거나 안전 검사를 약화하지 않는다.
