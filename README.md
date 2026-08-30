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
