# Harness Codex

Codex workflow skill과 custom agent profile을 대상 저장소에 project-local로 설치한다.

## 설치

GitHub 저장소에서 현재 project에 설치:

```bash
npx --yes github:omegafrog/harness-codex install
```

로컬 checkout을 개발 중일 때만 저장소 root에서 다음 명령을 사용한다.

```bash
npx . install --project <target-project>
```

설치 결과:

```text
.agents/skills/*
.codex/agents/code_researcher.toml
.codex/agents/spec_reviewer.toml
.codex/agents/standards_reviewer.toml
```

기존 agent profile은 보존한다. 덮어쓰려면 `--force`를 사용한다.

```bash
npx --yes github:omegafrog/harness-codex install --force
```

agent profile만 설치하려면 `--agents-only`, skill만 설치하려면 `--skills-only`를 사용한다.

설치 후 생성된 `harness-lock.json`을 기준으로 안전하게 업데이트할 수 있다.

```bash
npx --yes github:omegafrog/harness-codex update --project <target-project>
npx --yes github:omegafrog/harness-codex lock --project <target-project>
```

`update`는 unchanged/upstream 변경만 반영하고 locally modified/conflict 파일은 보존한다. 현재 상태를 의도적으로 새 기준으로 기록하려면 `lock`을 사용한다. 설치 상태와 workflow·permission·installer drift를 점검하려면 다음을 실행한다.

```bash
npx --yes github:omegafrog/harness-codex-doctor --project <target-project> --native-profile eval-workspace
```
