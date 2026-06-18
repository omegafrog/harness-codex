# File-Backed Long-Term Memory

Harness long-term memory is explicit repository state under `.harness/memory/`. It stores reusable operational knowledge for planning, implementation, verification, and self-evolution. It is not raw logs, hidden model memory, or run state.

## Structure

```text
.harness/memory/
  index.yaml
  failure-patterns/
  patch-patterns/
  regressions/
  eval-history/
  project/
```

`index.yaml` is the lookup surface. Each entry points to a Markdown file with YAML front matter and reviewable explanation.

## Memory Types

- `failure-pattern`: repeated symptoms, causes, detection signals, known fixes, and risks.
- `patch-pattern`: reusable implementation shape that has worked before.
- `regression`: accepted change that improved one path but damaged another.
- `project-rule`: project-specific or harness-wide rule that should affect future decisions.
- `eval-history`: before/after evaluation summary for harness evolution candidates.

## Promotion Criteria

Promote a memory only when it satisfies these checks:

- Recurrence likelihood: likely to matter again.
- Decision impact: changes what a future planner, executor, verifier, or evolution proposer does.
- Rediscovery cost: expensive enough that storing the lesson is useful.
- Stability: stable or explicitly conditional.
- Evidence: backed by run IDs, evals, ChangeSets, PRs, issues, or approved design documents.
- Scope clarity: states where it applies and where it does not.
- Safety: contains no secrets, credentials, tokens, or personal data.

The most important field is `decision_impact`. A memory that cannot explain future behavior change should not become active memory.

## Scoring

Score each criterion from 0 to 2:

| Criterion | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Recurrence likelihood | one-off | occasional | repeated/common |
| Decision impact | no behavior change | weak influence | clearly changes future action |
| Rediscovery cost | easy to search | moderate | expensive to rediscover |
| Stability | likely temporary | conditional | stable principle/pattern |
| Evidence | none | single source | multiple run/eval/design sources |
| Scope clarity | vague | partly scoped | clear applies/does-not-apply scope |
| Safety | unsafe | needs sanitization | safe |

Suggested decisions:

- `0-5`: do not store.
- `6-8`: keep as run evidence or candidate memory.
- `9-11`: long-term memory candidate.
- `12+`: active long-term memory, after review and required fields pass.

Active memories require:

- `decision_impact`
- `applies_to`
- `evidence`

## Lifecycle

Allowed status values:

- `candidate`: captured but not generalized or reviewed.
- `active`: eligible for future memory lookup.
- `stale`: may still be useful but needs revalidation.
- `deprecated`: superseded by newer knowledge.
- `rejected`: reviewed and intentionally not promoted.

Promotion flow:

```text
raw trace or observation
  -> evidence summary
  -> memory candidate
  -> scoring and review
  -> active, rejected, stale, or deprecated memory
```

## What Not To Store

Do not promote:

- Raw trace logs as active memory.
- Current run state.
- Active ChangeSet status.
- One-off command outputs.
- Easily searchable file paths or constants.
- Unvalidated guesses.
- Generic advice.
- Secrets, credentials, tokens, `.env` values, or personal data.

Raw execution data should become memory only through:

```text
raw trace -> evidence summary -> pattern -> reusable lesson
```

## Runtime Commands

```bash
python3 -m harness_codex memory list
python3 -m harness_codex memory search "plan contract"
python3 -m harness_codex memory score candidate.yaml
```

`memory score` expects scoring criteria under a `scores` mapping so semantic fields such as `decision_impact` can keep their explanatory text:

```yaml
status: active
decision_impact: Validate plan artifacts before implementation.
applies_to:
  stages:
    - plan-writing
evidence:
  - issue:#360
scores:
  recurrence_likelihood: 2
  decision_impact: 2
  rediscovery_cost: 2
  stability: 2
  evidence: 2
  scope_clarity: 2
  safety: 2
```

Memory lookup is advisory. It does not mutate run state, ChangeSets, plans, or source files.

## Evolution Change Manifest References

Harness evolution candidates should reference memory entries in `change-manifest.yaml` so reviewers can see which prior lessons shaped the proposal.

Example:

```yaml
change:
  id: EVL-001
  title: Strengthen plan boundary validation

memory_references:
  - id: incomplete-plan-contract
    type: failure-pattern
    path: .harness/memory/failure-patterns/incomplete-plan-contract.md
    influence: validates plan artifacts before implementation
  - id: add-stage-boundary-validator
    type: patch-pattern
    path: .harness/memory/patch-patterns/add-stage-boundary-validator.md
    influence: uses known boundary-validator patch shape
  - id: strict-validator-blocks-doc-only-change
    type: regression
    path: .harness/memory/regressions/strict-validator-blocks-doc-only-change.md
    influence: keeps docs-only work from being blocked by runtime-only checks
```

The manifest should not copy raw memory bodies. It should link memory IDs and summarize how each entry affected the change.
