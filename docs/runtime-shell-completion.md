# Runtime Shell Completion

`harness` 런타임은 Bash/Zsh 자동완성 스크립트를 제공한다.

자동완성은 현재 리포지토리 파일 시스템을 직접 탐색한다. 따라서 `change_set_id`, `uc_id`, `work_item_id`, `run_id`, `stage` 같은 파라미터를 외우지 않고 `Tab`으로 후보를 볼 수 있다.

## Bash

리포지토리 루트에서 다음을 실행한다.

```bash
source scripts/harness-completion.bash
```

항상 켜두려면 `~/.bashrc`에 추가한다.

```bash
source /path/to/harness-codex/scripts/harness-completion.bash
```

## Zsh

리포지토리 루트에서 다음을 실행한다.

```zsh
source scripts/harness-completion.zsh
```

항상 켜두려면 `~/.zshrc`에 추가한다.

```zsh
source /path/to/harness-codex/scripts/harness-completion.zsh
```

## 자동완성 대상

| 명령 | 자동완성 후보 |
| --- | --- |
| `harness changes show <TAB>` | `docs/changes/active/*.md`, `docs/changes/completed/*.md`의 ChangeSet ID |
| `harness run-change <TAB>` | ChangeSet ID |
| `harness run-use-case <CHG-ID> <TAB>` | 해당 ChangeSet 문서에 포함된 `UC-*` ID |
| `harness run-work-item <CHG-ID> <TAB>` | 해당 ChangeSet 문서에 포함된 `UC-*`, `MAINT-*` ID |
| `harness stages list <TAB>` | ChangeSet ID |
| `harness artifacts show <CHG-ID> <TAB>` | 런타임 stage ID |
| `harness artifacts accept <CHG-ID> <TAB>` | 런타임 stage ID |
| `harness run-stage <CHG-ID> <TAB>` | 런타임 stage ID |
| `harness resume <TAB>` | `.harness/runs/*`의 run ID |
| `harness report <TAB>` | `.harness/runs/*`의 run ID |
| `harness changes create-from-design --uc <TAB>` | `docs/use-cases/*`의 UC ID |
| `harness changes create-from-design --change-set-id <TAB>` | ChangeSet ID |

## Repo root 탐색 기준

기본 탐색 루트는 현재 Git 리포지토리 루트다.

다른 경로를 기준으로 후보를 찾고 싶으면 `--repo-root`를 먼저 입력한다.

```bash
harness --repo-root ../other-project run-use-case <TAB>
```

이 경우 자동완성은 `../other-project/docs/changes/active`, `../other-project/docs/use-cases`, `../other-project/docs/maintenance`, `../other-project/.harness/runs`를 기준으로 후보를 만든다.

## 후보 산출 규칙

- ChangeSet ID: `docs/changes/active/*.md`, `docs/changes/completed/*.md`의 파일명 stem
- UC ID: `docs/use-cases/*` 디렉토리명 또는 선택된 ChangeSet 문서 안의 `UC-*` 토큰
- Maintenance ID: `docs/maintenance/*` 디렉토리명 또는 선택된 ChangeSet 문서 안의 `MAINT-*` 토큰
- Work item ID: UC ID + Maintenance ID + `docs/plans/{active,completed}/*` 디렉토리명
- Run ID: `.harness/runs/*` 디렉토리명
- Stage ID: 런타임 기본 stage 이름 + `.harness/stages/<CHG-ID>/*.md`의 파일명 stem

## 예시

```bash
harness run-use-case CHG-20260507-001 UC-001 --preview
harness run-work-item CHG-20260507-001 MAINT-001 --plan
harness artifacts show CHG-20260507-001 verify-work-item
harness resume run-abc123def456
```
