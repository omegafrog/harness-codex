// Re-review comparison: each finding of a new review round is marked `recurring` when the previous round of the same
// review already reported it (same rule, file and anchor), or `new` otherwise. The mark is evidence for the user and
// the reviewer of the loop (is the repair converging, or do the same findings come back?); it does not change how a
// finding is classified or repaired. Line numbers are left out of the key because a repair moves them.
const REQUIREMENT_ID = /\b(?:BR|INV|AC|UC|EX|INT|BIZ|HS|AS|BASELINE|S\d+(?:\.\d+)*)-[A-Za-z0-9][\w.-]*/g;
const PATH = /(?:^|[\s(,;'"`])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]{1,8})(?::\d+(?:-\d+)?)?(?=$|[\s),;'"`])/;
const text = (value) => typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
const signature = (value) => text(value).toLowerCase().replace(/[`'"]/g, '').replace(/:\d+(?:-\d+)?/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

export function findingKey(finding = {}) {
  const evidence = `${text(finding.evidence)} ${text(finding.location)}`;
  // Requirement IDs may be cited in the prose as well; a file is taken from the evidence only (prose holds "e.g." and the like).
  const ids = [...new Set([text(finding.rule), text(finding.rule_id), text(finding.intent_ref), ...(`${evidence} ${text(finding.summary)} ${text(finding.description)}`.match(REQUIREMENT_ID) || [])].filter(Boolean))].sort();
  const rule = ids.join(',') || text(finding.kind) || null;
  const file = (text(finding.file) || PATH.exec(` ${evidence} `)?.[1] || '').replace(/^[ab]\//, '').replace(/^\.\//, '').replace(/:\d+(?:-\d+)?$/, '') || null;
  const anchor = text(finding.anchor) || text(finding.symbol) || signature(finding.summary || finding.description) || null;
  return { rule, file, anchor, specific_rule: ids.length > 0 };
}

// Marks every current finding against the previous round's findings. A finding recurs when rule, file and anchor are
// the same, or when it names the same specific rule ID in the same file (the wording of a repeated finding drifts).
export function markRecurrence(previous = [], current = []) {
  const before = previous.filter(Boolean).map((finding) => ({ finding, key: findingKey(finding) }));
  const marks = current.map((finding, index) => {
    const key = findingKey(finding);
    const match = before.find((item) => item.key.rule === key.rule && item.key.file === key.file && item.key.anchor === key.anchor)
      || (key.specific_rule && key.file ? before.find((item) => item.key.rule === key.rule && item.key.file === key.file) : null);
    return { index, id: finding?.id ?? null, recurrence: match ? 'recurring' : 'new', ...(match ? { matches: match.finding?.id ?? null } : {}), key: { rule: key.rule, file: key.file } };
  });
  return { marks, recurring: marks.filter((item) => item.recurrence === 'recurring').length, new: marks.filter((item) => item.recurrence === 'new').length };
}

// Implementation code review: the previous evidence of the same plan is the previous round. Each new (not carried
// forward) review gets `finding.recurrence` and a per-review summary; the evidence gets the round total.
export function annotateImplementationReview(previousEvidence, evidence) {
  if (!previousEvidence?.reviews?.length) return { ...evidence, recurrence: { compared: false, reason: 'first_review_round', recurring: 0, new: evidence.reviews.reduce((sum, review) => sum + (review.report?.findings?.length || 0), 0) } };
  // Assembling the same round again (same reviewers) keeps the comparison that round already made.
  const ids = (item) => item.reviews.map((review) => review?.context_id).sort().join('\0');
  if (ids(previousEvidence) === ids(evidence)) {
    if (!previousEvidence.recurrence) return { ...evidence, recurrence: { compared: false, reason: 'same_review_round', recurring: 0, new: 0 } };
    const earlier = new Map(previousEvidence.reviews.map((review) => [review.role, review]));
    return { ...evidence, recurrence: previousEvidence.recurrence, reviews: evidence.reviews.map((review) => {
      const prior = earlier.get(review.role);
      const marks = prior?.report?.findings || [];
      if (!prior?.recurrence || marks.length !== review.report?.findings?.length) return review;
      return { ...review, recurrence: prior.recurrence, report: { ...review.report, findings: review.report.findings.map((finding, index) => ({ ...finding, recurrence: marks[index].recurrence, ...(marks[index].recurs_from ? { recurs_from: marks[index].recurs_from } : {}) })) } };
    }) };
  }
  const previousFindings = previousEvidence.reviews.flatMap((review) => review?.report?.findings || []);
  let recurring = 0, fresh = 0;
  const reviews = evidence.reviews.map((review) => {
    if (review.carried_forward || !Array.isArray(review.report?.findings)) return review;
    const result = markRecurrence(previousFindings, review.report.findings);
    recurring += result.recurring; fresh += result.new;
    const findings = review.report.findings.map((finding, index) => ({ ...finding, recurrence: result.marks[index].recurrence, ...(result.marks[index].matches ? { recurs_from: result.marks[index].matches } : {}) }));
    return { ...review, report: { ...review.report, findings }, recurrence: { recurring: result.recurring, new: result.new } };
  });
  return {
    ...evidence, reviews,
    recurrence: { compared: true, previous_commit: previousEvidence.review_input?.implementation_commit_sha ?? null, previous_reviewers: previousEvidence.reviews.map((review) => review?.context_id ?? null), recurring, new: fresh },
  };
}
