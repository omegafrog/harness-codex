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

    def test_review_outcomes_define_plan_statuses(self) -> None:
        for path in (PUBLIC_IMPLEMENT, INTERNAL_IMPLEMENT):
            with self.subTest(path=path):
                text = path.read_text()
                self.assertIn("unresolved blocker", text)
                self.assertIn("status to `blocked`", text)
                self.assertIn("review cannot finish", text)
                self.assertIn("remain `in-progress`", text)

    def test_completed_requires_code_review_without_blockers(self) -> None:
        contract = STATUS_CONTRACT.read_text()

        self.assertIn("code review 완료", contract)
        self.assertIn("unresolved blocker 없음", contract)
        self.assertIn("code review blocker 발생", contract)


if __name__ == "__main__":
    unittest.main()
