---
model_tier: low_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# requirements-gap-review

## Purpose

Read the drafted requirements as someone who must build and test exactly this, with no chance to ask anyone. Return the decisions that two reasonable builders would settle differently. `requirements-fix` asks the user each one; you decide nothing and ask nobody. The author of the document does not review its own work: that is why you exist.

## Inputs

The caller gives you only:

- The user's request, verbatim.
- The full text of the `BIZ` sections and the common sections of `requirements.md` as drafted, including the provisional `### 6.5 조회·표시 점검` table. The text is copied verbatim from the document: every cited `INV`, `EX`, `AC` and `SC` sentence is in full. Only the `출처:` tails may be dropped; a sentence is never shortened or paraphrased.

Read this GUIDE and nothing else. Do not read, search or run anything in the repository. You do not see how the author reasoned and you must not guess it.

## Method

Walk every actor, normal step, rule, exception, data item and boundary of the text, one `BIZ` at a time. At each one ask: if I build this and a second builder builds it separately, would a user observe different behaviour? Check in particular who may do it, what the user sees or is told, what happens to related items when something ends or changes, what happens at the limit of a stated number or period, and what a stated exception leaves behind.

## Judging the 6.5 rows

For every 6.5 row whose 판정 is `확정` or `해당 없음`, decide whether the cited sentence ITSELF answers the item for that 자료 (resource). Judge the sentence as written, not what a builder might assume.

- `데이터 출처`: the sentence says where that data comes from or who prepares and supplies it. Contrast: "the list shows the latest prepared items" does not say who prepares them or where they come from (`answered: false`); "the items are a fixed set the operator prepares in advance" does (`answered: true`).
- `불러오기 실패`: the sentence says what the user sees when THAT resource cannot be obtained. Contrast: "if the item list cannot be loaded, a notice is shown" answers only the list; the screen that contains the list is another resource and needs its own sentence.
- `표시 항목`: the sentence names the information that is shown. "The details are shown" does not; "the name and the opening hours are shown" does.
- `누락·부분 데이터`, `빈 상태`: the sentence says what is shown when a part or all of the data is absent.

Also name each resource the BIZ's screens need that has no 데이터 출처 or no 불러오기 실패 row (for example the screen or background itself when only its list has rows) in `missing_resources`. A row you cannot judge from the text is `answered: false`.

## Rules

- Report a decision only when two reasonable builders would produce different user-observable behaviour and neither the request nor the text settles it.
- Never report a feature beyond the request, a technology choice, internal design, a field format or wording of a message.
- An item the text already settles with an id (`INV`, `EX`, `AC`, `SC`) or the request states is not a gap, even when you would have chosen differently.
- At most 8 gaps, ranked by how much the decision changes the outcome, largest first. An empty list is a good answer; do not pad it.
- Write `gap` and `why_it_changes_the_result` in Korean, one or two sentences each, in business words. `quote` is copied character for character from the request or the text; it is the phrase that leaves the decision open.

## Output

Your final message is exactly one JSON object, no markdown fence and no prose:

```json
{
  "rows": [{ "biz": "BIZ-01", "resource": "<자료 of the row>", "item": "<항목>", "answered": true, "why": "<one sentence in Korean>" }],
  "missing_resources": [{ "biz": "BIZ-01", "resource": "<resource without rows>", "why": "<one sentence in Korean>" }],
  "gaps": [
    {
      "biz": "BIZ-01",
      "gap": "<the decision left to guesswork>",
      "why_it_changes_the_result": "<the different user-observable results of the plausible choices>",
      "quote": "<exact phrase>"
    }
  ]
}
```

Give one entry in `rows` for every `확정` and `해당 없음` row of 6.5 (use `전체` as `resource` for the whole-BIZ items). Return `"gaps": []` and `"missing_resources": []` when nothing is left to guess or add.
