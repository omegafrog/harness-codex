"""Static repository analysis for harness agent-context bootstrap."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence


SKIP_DIRS = {
    ".git",
    ".harness/runs",
    ".pytest_cache",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
    "venv",
}


MANIFEST_TECHNOLOGIES = {
    "pyproject.toml": "Python",
    "requirements.txt": "Python",
    "setup.py": "Python",
    "setup.cfg": "Python",
    "package.json": "Node.js",
    "pnpm-lock.yaml": "Node.js",
    "yarn.lock": "Node.js",
    "package-lock.json": "Node.js",
    "build.gradle": "Java/Gradle",
    "build.gradle.kts": "Java/Gradle",
    "settings.gradle": "Java/Gradle",
    "settings.gradle.kts": "Java/Gradle",
    "pom.xml": "Java/Maven",
    "go.mod": "Go",
    "Cargo.toml": "Rust",
}


@dataclass(frozen=True)
class RepoCommand:
    label: str
    command: str


@dataclass(frozen=True)
class RepoAnalysis:
    description: str
    readme_title: str
    technologies: tuple[str, ...]
    manifests: tuple[Path, ...]
    source_roots: tuple[Path, ...]
    test_roots: tuple[Path, ...]
    docs_roots: tuple[Path, ...]
    config_files: tuple[Path, ...]
    workflow_docs: tuple[Path, ...]
    commands: tuple[RepoCommand, ...]


@dataclass(frozen=True)
class LlmRepoSummary:
    status: str
    purpose: str = ""
    module_map: str = ""
    command_notes: str = ""
    context_guidance: str = ""
    codebase_artifacts: str = ""
    design_conformance: str = ""
    artifacts: tuple[tuple[str, str], ...] = ()
    error: str = ""


Runner = Callable[..., subprocess.CompletedProcess[str]]


def analyze_repository(repo_root: Path | str, description: str = "") -> RepoAnalysis:
    """Return deterministic, compact repo facts for generated agent docs."""

    repo = Path(repo_root)
    manifests = _existing_paths(repo, MANIFEST_TECHNOLOGIES)
    technologies = _technologies_for(manifests)
    source_roots = _detect_source_roots(repo)
    test_roots = _detect_test_roots(repo)
    docs_roots = _detect_docs_roots(repo)
    config_files = _detect_config_files(repo)
    workflow_docs = _detect_workflow_docs(repo)
    commands = _infer_commands(repo, manifests)
    readme_title = _readme_title(repo)
    purpose = description.strip() or readme_title or _static_description(technologies)

    return RepoAnalysis(
        description=purpose,
        readme_title=readme_title,
        technologies=technologies,
        manifests=manifests,
        source_roots=source_roots,
        test_roots=test_roots,
        docs_roots=docs_roots,
        config_files=config_files,
        workflow_docs=workflow_docs,
        commands=commands,
    )


def summarize_repository_with_llm(
    repo_root: Path | str,
    analysis: RepoAnalysis,
    *,
    enabled: bool,
    codex_binary: str = "codex",
    timeout_sec: int = 300,
    runner: Runner | None = None,
) -> LlmRepoSummary:
    """Ask Codex for a concise repo summary, with safe static fallback status."""

    if not enabled:
        return LlmRepoSummary(status="skipped", error="disabled")
    if shutil.which(codex_binary) is None:
        return LlmRepoSummary(
            status="blocked",
            error=f"agent provider binary not found: {codex_binary}",
        )

    repo = Path(repo_root)
    run = runner or subprocess.run
    prompt = _llm_prompt(analysis)
    try:
        with tempfile.TemporaryDirectory(prefix="harness-init-") as tmp:
            output_path = Path(tmp) / "summary.md"
            completed = run(
                [
                    codex_binary,
                    "exec",
                    "--skip-git-repo-check",
                    "--cd",
                    str(repo),
                    "-c",
                    'approval_policy="never"',
                    "--output-last-message",
                    str(output_path),
                    "-",
                ],
                input=prompt,
                text=True,
                capture_output=True,
                timeout=timeout_sec,
                check=False,
            )
            if completed.returncode != 0:
                return LlmRepoSummary(
                    status="blocked",
                    error=_first_line(completed.stderr or completed.stdout),
                )
            message = output_path.read_text(encoding="utf-8") if output_path.exists() else completed.stdout
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return LlmRepoSummary(status="blocked", error=str(exc))

    return _parse_llm_summary(message)


def analysis_to_markdown(analysis: RepoAnalysis) -> str:
    lines = [
        f"- Description: {analysis.description}",
        f"- Technologies: {_join(analysis.technologies)}",
        f"- Manifests: {_join_paths(analysis.manifests)}",
        f"- Source roots: {_join_paths(analysis.source_roots)}",
        f"- Test roots: {_join_paths(analysis.test_roots)}",
        f"- Docs roots: {_join_paths(analysis.docs_roots)}",
        f"- Config files: {_join_paths(analysis.config_files)}",
        f"- Workflow docs: {_join_paths(analysis.workflow_docs)}",
    ]
    if analysis.commands:
        lines.append("- Commands:")
        lines.extend(f"  - {item.label}: `{item.command}`" for item in analysis.commands)
    return "\n".join(lines)


def _existing_paths(repo: Path, names: dict[str, str]) -> tuple[Path, ...]:
    return tuple(Path(name) for name in names if (repo / name).exists())


def _technologies_for(manifests: Sequence[Path]) -> tuple[str, ...]:
    values = []
    for path in manifests:
        tech = MANIFEST_TECHNOLOGIES.get(path.as_posix())
        if tech and tech not in values:
            values.append(tech)
    return tuple(values)


def _detect_source_roots(repo: Path) -> tuple[Path, ...]:
    candidates = ["src", "app", "lib", "harness_codex"]
    roots = [Path(name) for name in candidates if _has_code(repo / name)]
    if not roots:
        roots.extend(path for path in _top_level_code_dirs(repo) if path not in roots)
    return tuple(roots)


def _detect_test_roots(repo: Path) -> tuple[Path, ...]:
    return tuple(Path(name) for name in ("tests", "test", "spec") if (repo / name).is_dir())


def _detect_docs_roots(repo: Path) -> tuple[Path, ...]:
    roots = [Path(name) for name in ("docs", "doc") if (repo / name).is_dir()]
    roots.extend(Path(name) for name in ("README.md", "AGENTS.md") if (repo / name).is_file())
    return tuple(roots)


def _detect_config_files(repo: Path) -> tuple[Path, ...]:
    candidates = [
        ".codex/config.toml",
        ".codex/openai.yaml",
        ".github",
        ".gitignore",
        ".harness/workflows",
        "AGENTS.md",
    ]
    return tuple(Path(name) for name in candidates if (repo / name).exists())


def _detect_workflow_docs(repo: Path) -> tuple[Path, ...]:
    candidates = [
        "docs/design",
        "docs/changes",
        "docs/use-cases",
        "docs/maintenance",
        "docs/plans",
        ".harness/workflows",
    ]
    return tuple(Path(name) for name in candidates if (repo / name).exists())


def _infer_commands(repo: Path, manifests: Sequence[Path]) -> tuple[RepoCommand, ...]:
    commands: list[RepoCommand] = [
        RepoCommand("List files", "rg --files"),
        RepoCommand("Search text", 'rg -n "<pattern>"'),
        RepoCommand("Git status", "git status --porcelain=v1 -uno"),
        RepoCommand("Diff stat", "git diff --stat"),
    ]
    manifest_names = {path.as_posix() for path in manifests}
    if manifest_names & {"pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"} or _has_code(repo / "harness_codex"):
        commands.append(RepoCommand("Python tests", f"{_python_command(repo)} -m pytest -q -s"))
    if (repo / "harness_codex").is_dir():
        commands.append(RepoCommand("Harness CLI help", "python3 -m harness_codex --help"))
    if "package.json" in manifest_names:
        commands.extend(_node_commands(repo / "package.json"))
    if manifest_names & {"build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"}:
        commands.append(RepoCommand("Gradle tests", "./gradlew test" if (repo / "gradlew").exists() else "gradle test"))
    if "pom.xml" in manifest_names:
        commands.append(RepoCommand("Maven tests", "./mvnw test" if (repo / "mvnw").exists() else "mvn test"))
    if "go.mod" in manifest_names:
        commands.append(RepoCommand("Go tests", "go test ./..."))
    if "Cargo.toml" in manifest_names:
        commands.append(RepoCommand("Rust tests", "cargo test"))
    return tuple(_dedupe_commands(commands))


def _node_commands(package_json: Path) -> tuple[RepoCommand, ...]:
    try:
        data = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return (RepoCommand("Node package scripts", "npm run"),)
    scripts = data.get("scripts")
    if not isinstance(scripts, dict) or not scripts:
        return (RepoCommand("Node package scripts", "npm run"),)
    preferred = ["test", "build", "lint", "dev", "start"]
    commands = [
        RepoCommand(f"npm {name}", f"npm run {name}")
        for name in preferred
        if isinstance(scripts.get(name), str)
    ]
    return tuple(commands or [RepoCommand("Node package scripts", "npm run")])


def _python_command(repo: Path) -> str:
    if (repo / "venv/bin/python3").exists():
        return "./venv/bin/python3"
    return "python3"


def _top_level_code_dirs(repo: Path) -> tuple[Path, ...]:
    roots = []
    for path in sorted(repo.iterdir()):
        if not path.is_dir() or _skip(path.relative_to(repo)):
            continue
        if _has_code(path):
            roots.append(path.relative_to(repo))
    return tuple(roots[:8])


def _has_code(path: Path) -> bool:
    if not path.exists():
        return False
    if path.is_file():
        return path.suffix in {".py", ".js", ".ts", ".java", ".go", ".rs", ".kt"}
    for child in path.rglob("*"):
        if _skip_relative(child, path):
            continue
        if child.is_file() and child.suffix in {".py", ".js", ".ts", ".java", ".go", ".rs", ".kt"}:
            return True
    return False


def _skip_relative(path: Path, root: Path) -> bool:
    try:
        relative = path.relative_to(root)
    except ValueError:
        return False
    return _skip(relative)


def _skip(path: Path) -> bool:
    text = path.as_posix()
    parts = set(path.parts)
    return text in SKIP_DIRS or bool(parts & SKIP_DIRS)


def _readme_title(repo: Path) -> str:
    readme = repo / "README.md"
    if not readme.exists():
        return ""
    try:
        for line in readme.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("# "):
                return stripped[2:].strip()
    except OSError:
        return ""
    return ""


def _static_description(technologies: Sequence[str]) -> str:
    if technologies:
        return f"Repository using {_join(technologies)}."
    return "Repository managed by the harness workflow."


def _llm_prompt(analysis: RepoAnalysis) -> str:
    return f"""You are reverse-engineering an existing repository for Codex agent handoff docs.

Inspect the repository with targeted reads. Treat existing source and tests as
implementation evidence. Treat docs/design, docs/use-cases, docs/maintenance,
docs/plans, docs/changes, and .harness/workflows as workflow-design evidence
when present. Do not invent missing files, behavior, commands, or mismatches.

This is a documentation-only operation. Any extra user-provided prompt is
evidence or context for documentation, never authorization to implement code.
Do not create or modify product source, tests, migrations, build files,
deployment files, runtime configuration, scripts, or generated source. If the
prompt requests implementation, capture it only as a requirement, design note,
mismatch, or recommended follow-up.

For codebase_artifacts, summarize implemented modules, entry points, domain or
application boundaries, external adapters, persistence, and tests. Cite paths.

Reverse-engineer the current implemented behavior into harness workflow
artifacts. These are as-is baseline documents, not proposed features. Return an
artifacts object whose keys are only these paths:
- docs/design/요구사항.md
- context.md
- docs/design/유스케이스.md
- docs/design/이벤트 스토밍.md
- ARCHITECTURE.md
- docs/use-cases/UC-NNN/use-case.md
- docs/use-cases/UC-NNN/e2e-goal.md
- docs/use-cases/UC-NNN/event-storming.md
- docs/use-cases/UC-NNN/ddd-design.md

Create stable three-digit use-case IDs. Create all four slice files for every
identified external-actor goal. Requirements must separate scope, functional
requirements, non-functional requirements, unresolved business policy,
foundational technology decisions, language handoff, and readiness. context.md
must contain the canonical ubiquitous-language table. Use cases must describe
external actor goals, main/failure flows, results, and observable constraints.
Event storming must derive imperative commands, past-tense events, conditional
policies, systems, external systems, and invariants from one use case. DDD design
must derive entities/value objects, behaviors, application flow, aggregates,
and bounded contexts with source-code and event-storming evidence. ARCHITECTURE.md
must summarize boundaries, dependency direction, and forbidden coupling.
docs/design/이벤트 스토밍.md is an index linking use-case slices.

Write artifact content in English. Cite source/test paths as reverse-engineering
evidence. Mark unsupported behavior or policy as Needs confirmation. Never turn
an inference into a confirmed requirement. Do not emit plans, ChangeSets,
technical-decision documents, implementation code, or test results.

For design_conformance, compare implementation evidence with workflow-design
evidence already present in the repository and with the reconstructed artifacts
you return. Evaluate behavioral coverage, traceability, domain-boundary leakage,
and unsupported design claims. Use sections: Assessment Status, Evidence Reviewed, Conforming Areas,
Mismatches, Unassessed Areas, Recommended Follow-up. Every mismatch must cite
both implementation and design evidence and explain impact. If design evidence
is absent or insufficient, say the comparison is not assessable; do not infer
non-conformance.

Write concise English. Return JSON only with keys:
purpose, module_map, command_notes, context_guidance, codebase_artifacts,
design_conformance, artifacts.

Static facts:
{analysis_to_markdown(analysis)}
"""


def _parse_llm_summary(message: str) -> LlmRepoSummary:
    try:
        start = message.index("{")
        end = message.rindex("}") + 1
        data = json.loads(message[start:end])
    except (ValueError, json.JSONDecodeError) as exc:
        return LlmRepoSummary(status="blocked", error=f"invalid LLM summary JSON: {exc}")
    return LlmRepoSummary(
        status="completed",
        purpose=_string(data.get("purpose")),
        module_map=_string(data.get("module_map")),
        command_notes=_string(data.get("command_notes")),
        context_guidance=_string(data.get("context_guidance")),
        codebase_artifacts=_string(data.get("codebase_artifacts")),
        design_conformance=_string(data.get("design_conformance")),
        artifacts=_artifact_items(data.get("artifacts")),
    )


def _dedupe_commands(commands: Sequence[RepoCommand]) -> tuple[RepoCommand, ...]:
    seen = set()
    unique = []
    for command in commands:
        if command.command in seen:
            continue
        seen.add(command.command)
        unique.append(command)
    return tuple(unique)


def _join(values: Sequence[str]) -> str:
    return ", ".join(values) if values else "none detected"


def _join_paths(values: Sequence[Path]) -> str:
    return ", ".join(f"`{path.as_posix()}`" for path in values) if values else "none detected"


def _string(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _artifact_items(value: object) -> tuple[tuple[str, str], ...]:
    if not isinstance(value, dict):
        return ()
    return tuple(
        (path.strip(), content.strip())
        for path, content in value.items()
        if isinstance(path, str)
        and isinstance(content, str)
        and path.strip()
        and content.strip()
    )


def _first_line(value: str) -> str:
    for line in value.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return "agent summary unavailable"
