"""부작용이 있는 런타임 단계의 명령 정책 검사."""

from __future__ import annotations

import shlex
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.models import RunMode, StepKind


class PolicyEffect(str, Enum):
    """명령 정책 평가 결과."""

    ALLOW = "allow"
    DENY = "deny"
    REQUIRE_APPROVAL = "require_approval"


@dataclass(frozen=True)
class CommandRequest:
    """정책 평가에 필요한 명령과 런타임 문맥."""

    step_id: str
    step_kind: StepKind
    command: str
    mode: RunMode
    repo_root: Path
    workdir: Path
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PolicyDecision:
    """명령 실행 결과에 기록되는 구조화된 정책 결과."""

    effect: PolicyEffect
    rule_id: str
    reason: str
    metadata: Mapping[str, Any] = field(default_factory=dict)

    @property
    def allowed(self) -> bool:
        return self.effect == PolicyEffect.ALLOW

    def as_metadata(self) -> dict[str, Any]:
        return {
            "effect": self.effect.value,
            "rule_id": self.rule_id,
            "reason": self.reason,
            **dict(self.metadata),
        }


class PolicyEngine:
    """셸과 git 명령이 실행 경계를 넘기 전에 정책을 평가한다."""

    _SECRET_FILENAMES = frozenset(
        {
            ".env",
            "id_rsa",
            "id_dsa",
            "id_ecdsa",
            "id_ed25519",
            "credentials",
            "credentials.json",
            ".netrc",
        }
    )
    _READ_COMMANDS = frozenset({"cat", "less", "more", "head", "tail", "sed", "awk"})
    _MUTATION_COMMANDS = frozenset(
        {
            "chmod",
            "chown",
            "cp",
            "install",
            "mkdir",
            "mv",
            "rm",
            "rmdir",
            "sed",
            "tee",
            "touch",
        }
    )
    _GIT_MUTATION_SUBCOMMANDS = frozenset(
        {
            "add",
            "am",
            "apply",
            "checkout",
            "cherry-pick",
            "clean",
            "commit",
            "merge",
            "mv",
            "pull",
            "push",
            "rebase",
            "reset",
            "restore",
            "revert",
            "rm",
            "stash",
            "switch",
        }
    )

    def evaluate(self, request: CommandRequest) -> PolicyDecision:
        tokens = _split_command(request.command)
        lowered_command = " ".join(request.command.lower().split())

        if not tokens:
            return PolicyDecision(
                effect=PolicyEffect.DENY,
                rule_id="empty-command",
                reason="빈 명령은 실행할 수 없습니다.",
            )

        dangerous = self._deny_dangerous_command(tokens, lowered_command)
        if dangerous is not None:
            return dangerous

        path_violation = self._deny_outside_worktree_write(tokens, request)
        if path_violation is not None:
            return path_violation

        if self._is_plan_mode_mutation(tokens, request):
            return PolicyDecision(
                effect=PolicyEffect.DENY,
                rule_id="plan-mode-mutation",
                reason="plan 모드에서는 변경 명령을 실행할 수 없습니다.",
                metadata={"mode": request.mode.value},
            )

        approval = self._require_approval(tokens)
        if approval is not None:
            return approval

        return PolicyDecision(
            effect=PolicyEffect.ALLOW,
            rule_id="default-allow",
            reason="명령이 기본 정책을 통과했습니다.",
        )

    def _deny_dangerous_command(
        self,
        tokens: tuple[str, ...],
        lowered_command: str,
    ) -> PolicyDecision | None:
        command = Path(tokens[0]).name
        lowered_tokens = tuple(token.lower() for token in tokens)

        if command == "sudo":
            return _deny("deny-sudo", "sudo 명령은 허용되지 않습니다.")

        if command == "rm" and "-rf" in lowered_tokens and "/" in tokens[1:]:
            return _deny("deny-rm-rf-root", "루트 디렉터리 삭제 명령은 허용되지 않습니다.")

        if command == "chmod" and "-r" in lowered_tokens and "777" in lowered_tokens:
            return _deny("deny-recursive-world-writable", "재귀적 777 권한 변경은 허용되지 않습니다.")

        if command in {"curl", "wget"} and "| sh" in lowered_command:
            return _deny("deny-pipe-to-shell", "다운로드한 스크립트를 셸로 바로 실행할 수 없습니다.")

        if command == "git" and len(tokens) > 2:
            subcommand = tokens[1].lower()
            if subcommand == "push" and any(
                token in {"--force", "-f", "--force-with-lease"}
                for token in lowered_tokens[2:]
            ):
                return _deny("deny-force-push", "강제 push는 허용되지 않습니다.")

        if command in self._READ_COMMANDS and any(
            Path(token).name in self._SECRET_FILENAMES for token in tokens[1:]
        ):
            return _deny("deny-secret-read", "일반적인 시크릿 파일 출력은 허용되지 않습니다.")

        return None

    def _deny_outside_worktree_write(
        self,
        tokens: tuple[str, ...],
        request: CommandRequest,
    ) -> PolicyDecision | None:
        if not _looks_like_write(tokens):
            return None

        for raw_path in _candidate_write_paths(tokens):
            if raw_path.startswith("-"):
                continue

            resolved = _resolve_command_path(raw_path, request.workdir)
            if not _is_relative_to(resolved, request.repo_root) and not _is_relative_to(
                resolved, request.workdir
            ):
                return PolicyDecision(
                    effect=PolicyEffect.DENY,
                    rule_id="outside-worktree-write",
                    reason="리포지토리 또는 worktree 밖에 쓰는 명령은 허용되지 않습니다.",
                    metadata={"path": str(resolved)},
                )

        return None

    def _is_plan_mode_mutation(
        self,
        tokens: tuple[str, ...],
        request: CommandRequest,
    ) -> bool:
        if request.mode != RunMode.PLAN:
            return False

        command = Path(tokens[0]).name

        if command in self._MUTATION_COMMANDS or _has_redirection(tokens):
            return True

        if command == "git" and len(tokens) > 1:
            return tokens[1].lower() in self._GIT_MUTATION_SUBCOMMANDS

        return False

    def _require_approval(self, tokens: tuple[str, ...]) -> PolicyDecision | None:
        command = Path(tokens[0]).name
        lowered_tokens = tuple(token.lower() for token in tokens)

        if command == "git" and len(tokens) > 1:
            subcommand = tokens[1].lower()
            if subcommand == "push":
                return _approval("approval-git-push", "git push는 실행 전 승인이 필요합니다.")
            if subcommand == "reset" and "--hard" in lowered_tokens[2:]:
                return _approval(
                    "approval-git-reset-hard",
                    "git reset --hard는 실행 전 승인이 필요합니다.",
                )

        delete_targets = [token for token in tokens[1:] if not token.startswith("-")]
        if command == "rm" and len(delete_targets) > 1:
            return _approval("approval-mass-delete", "여러 경로 삭제는 실행 전 승인이 필요합니다.")

        if command in {"curl", "wget"}:
            return _approval("approval-network", "외부 네트워크 호출은 실행 전 승인이 필요합니다.")

        if _looks_like_dependency_install(tokens):
            return _approval("approval-dependency-install", "의존성 설치는 실행 전 승인이 필요합니다.")

        return None


def _deny(rule_id: str, reason: str) -> PolicyDecision:
    return PolicyDecision(effect=PolicyEffect.DENY, rule_id=rule_id, reason=reason)


def _approval(rule_id: str, reason: str) -> PolicyDecision:
    return PolicyDecision(
        effect=PolicyEffect.REQUIRE_APPROVAL,
        rule_id=rule_id,
        reason=reason,
    )


def _split_command(command: str) -> tuple[str, ...]:
    try:
        return tuple(shlex.split(command, posix=True))
    except ValueError:
        return tuple(command.split())


def _looks_like_write(tokens: tuple[str, ...]) -> bool:
    if _has_redirection(tokens):
        return True

    command = Path(tokens[0]).name
    write_commands = {
        "chmod",
        "chown",
        "cp",
        "install",
        "mkdir",
        "mv",
        "rm",
        "rmdir",
        "tee",
        "touch",
    }
    if command in write_commands:
        return True

    return command == "git" and len(tokens) > 1 and tokens[1].lower() in {
        "apply",
        "checkout",
        "clean",
        "mv",
        "reset",
        "restore",
        "rm",
    }


def _candidate_write_paths(tokens: tuple[str, ...]) -> tuple[str, ...]:
    candidates: list[str] = []
    skip_next = False

    for index, token in enumerate(tokens[1:], start=1):
        if skip_next:
            skip_next = False
            continue

        if token in {">", ">>", "2>", "2>>"}:
            if index + 1 < len(tokens):
                candidates.append(tokens[index + 1])
                skip_next = True
            continue

        if token.startswith((">", ">>")) and len(token.lstrip(">")) > 0:
            candidates.append(token.lstrip(">"))
            continue

        if not token.startswith("-"):
            candidates.append(token)

    return tuple(candidates)


def _has_redirection(tokens: tuple[str, ...]) -> bool:
    return any(
        token in {">", ">>", "2>", "2>>"} or token.startswith((">", ">>"))
        for token in tokens
    )


def _resolve_command_path(raw_path: str, workdir: Path) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = workdir / path
    return path.resolve(strict=False)


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent.resolve(strict=False))
        return True
    except ValueError:
        return False


def _looks_like_dependency_install(tokens: tuple[str, ...]) -> bool:
    command = Path(tokens[0]).name
    lowered = tuple(token.lower() for token in tokens)

    if command in {"pip", "pip3"} and len(tokens) > 1 and lowered[1] == "install":
        return True

    if command in {"npm", "pnpm", "yarn"} and "install" in lowered[1:]:
        return True

    return command == "python3" and len(tokens) > 3 and lowered[1:4] == (
        "-m",
        "pip",
        "install",
    )
