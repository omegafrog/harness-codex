import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_IMPLEMENT = ROOT / ".codex/skills/implement/SKILL.md"
INTERNAL_IMPLEMENT = ROOT / ".codex/internal-skills/implement/SKILL.md"
STATUS_CONTRACT = ROOT / "docs/agents/plan-status.md"


def numbered_steps(path: Path) -> list[str]:
    return [
        match.group(1)
        for line in path.read_text().splitlines()
        if (match := re.match(r"^\d+\. (.+)$", line))
    ]


def step_index(steps: list[str], phrase: str) -> int:
    phrase = phrase.casefold()
    return next(
        index for index, step in enumerate(steps) if phrase in step.casefold()
    )


class PlanStatusPipelineTest(unittest.TestCase):
    def test_review_gates_completion_and_dependent_reconciliation(self) -> None:
        for path in (PUBLIC_IMPLEMENT, INTERNAL_IMPLEMENT):
            with self.subTest(path=path):
                steps = numbered_steps(path)
                review = step_index(steps, "Run `code-review`")
                complete = step_index(steps, "status to `completed`")
                reconcile = step_index(steps, "Reconcile every linked plan")

                self.assertLess(review, complete)
                self.assertLess(review, reconcile)

    def test_review_findings_stay_in_progress_and_enter_repair_loop(self) -> None:
        for path in (PUBLIC_IMPLEMENT, INTERNAL_IMPLEMENT):
            with self.subTest(path=path):
                text = path.read_text()
                self.assertIn("actionable review finding", text)
                self.assertIn("keep the plan `in-progress`", text)
                self.assertIn("rerun `code-review`", text)
                self.assertIn("agent cannot resolve", text)
                self.assertNotIn(
                    "review reports an unresolved blocker, set the plan status to `blocked`",
                    text,
                )
                self.assertIn("review cannot finish", text)

    def test_explicit_in_progress_plan_can_resume(self) -> None:
        for path in (PUBLIC_IMPLEMENT, INTERNAL_IMPLEMENT):
            with self.subTest(path=path):
                text = path.read_text()
                self.assertIn("resume an explicitly requested `in-progress` plan", text)
                self.assertIn("resume an explicitly requested `blocked` plan", text)
                self.assertIn("unblock condition is satisfied", text)
                self.assertIn("Do not start a different plan", text)

    def test_completed_requires_code_review_without_blockers(self) -> None:
        contract = STATUS_CONTRACT.read_text()

        self.assertIn("code review 완료", contract)
        self.assertIn("unresolved blocker 없음", contract)
        self.assertIn("수정 가능한 finding", contract)
        self.assertIn("에이전트가 해결할 수 없는 blocker", contract)
        self.assertIn("blocked --(unblock 조건 해소 확인 + 명시적 재개)--> in-progress", contract)


if __name__ == "__main__":
    unittest.main()
