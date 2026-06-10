import json
from datetime import date, datetime, timezone
from pathlib import Path

from scripts.check_owasp_standards import check_registry, render_report


REPO_ROOT = Path(__file__).resolve().parents[1]
REGISTRY_PATH = REPO_ROOT / ".codex/security/owasp-standards.json"


def registry() -> dict:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def official_json(url: str):
    if "ASVS" in url:
        return [
            {"tag_name": "latest", "draft": False, "prerelease": False},
            {"tag_name": "v5.0.0_release", "draft": False, "prerelease": False},
        ]
    if "API-Security" in url:
        return [{"name": "2019"}, {"name": "2023"}, {"name": "README.md"}]
    if "owasp-masvs" in url:
        return [
            {"tag_name": "v2.1.0", "draft": False, "prerelease": False},
            {"tag_name": "v2.2.0-beta", "draft": False, "prerelease": True},
        ]
    raise AssertionError(url)


def official_text(url: str) -> str:
    assert "www-project-top-ten" in url
    return (
        "The most current released version is the "
        "[OWASP Top Ten 2025](https://owasp.org/Top10/2025/)."
    )


def test_current_registry_passes_with_official_versions() -> None:
    results, stale = check_registry(
        registry(),
        today=date(2026, 6, 10),
        json_fetcher=official_json,
        text_fetcher=official_text,
    )

    assert stale is False
    assert {result.status for result in results} == {"current"}


def test_new_release_requires_review_without_mutating_registry() -> None:
    def newer_json(url: str):
        if "ASVS" in url:
            return [
                {"tag_name": "v5.0.1_release", "draft": False, "prerelease": False}
            ]
        return official_json(url)

    current = registry()
    results, stale = check_registry(
        current,
        today=date(2026, 6, 10),
        json_fetcher=newer_json,
        text_fetcher=official_text,
    )

    asvs = next(result for result in results if result.standard_id == "asvs")
    assert stale is False
    assert asvs.expected == "5.0.0"
    assert asvs.discovered == "5.0.1"
    assert asvs.status == "update_available"
    assert current["standards"][0]["expected_version"] == "5.0.0"


def test_stale_human_review_requires_review_even_without_new_release() -> None:
    current = registry()
    results, stale = check_registry(
        current,
        today=date(2026, 9, 9),
        json_fetcher=official_json,
        text_fetcher=official_text,
    )
    report = render_report(
        current,
        results,
        checked_at=datetime(2026, 9, 9, tzinfo=timezone.utc),
        stale=stale,
    )

    assert stale is True
    assert "Overall status: `review_required`" in report


def test_network_failure_is_source_error_not_update_claim() -> None:
    def failing_json(url: str):
        raise TimeoutError(url)

    results, _ = check_registry(
        registry(),
        today=date(2026, 6, 10),
        json_fetcher=failing_json,
        text_fetcher=official_text,
    )

    assert any(result.status == "source_error" for result in results)
    assert all(result.status != "update_available" for result in results)


def test_schedule_and_reviewer_reference_registry() -> None:
    workflow = (REPO_ROOT / ".github/workflows/check-owasp-standards.yml").read_text(
        encoding="utf-8"
    )
    reviewer = (
        REPO_ROOT / ".codex/agents/references/security_plan_reviewer.md"
    ).read_text(encoding="utf-8")

    assert 'cron: "17 3 1 * *"' in workflow
    assert "issues: write" in workflow
    assert ".codex/security/owasp-standards.json" in reviewer


def test_baseline_versions_match_registry() -> None:
    current = registry()
    baseline = (
        REPO_ROOT
        / ".codex/skills/harness-security-plan-reviewer/references/owasp-baseline.md"
    ).read_text(encoding="utf-8")
    reviewer = (
        REPO_ROOT / ".codex/agents/references/security_plan_reviewer.md"
    ).read_text(encoding="utf-8")

    expected = {
        standard["id"]: standard["expected_version"]
        for standard in current["standards"]
    }
    assert f"ASVS {expected['asvs']}" in reviewer
    assert f"Top 10:{expected['top-ten']}" in reviewer
    assert f"Top 10:{expected['api-security']}" in reviewer
    assert f"MASVS {expected['masvs']}" in reviewer
    assert expected["asvs"] in baseline
    assert expected["top-ten"] in baseline
    assert expected["api-security"] in baseline
    assert expected["masvs"] in baseline
