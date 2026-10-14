// Detects "the context doesn't contain the answer" non-answers.
//
// These were being logged as successful outcomes (18 of 28 successes as of
// 2026-09-22), which inflated skill-history success rates to 1.0 and got
// recycled as episodic context for later tasks. Deliberately narrow: an
// honest "I don't know" is a valid answer; only a refusal *because the
// attached context lacks it* is a prompt artifact.

const REFUSAL_PATTERNS: RegExp[] = [
  /\b(provided |given |the )?context (does not|doesn't|did not) (contain|mention|include|provide|say)/i,
  /\bbased on the (provided |given )?context,? (there is|there's) no (mention|information)/i,
  /\bno (mention|information)[^.]{0,40}\bin the (provided |given )?context\b/i,
];

// Only the first 400 chars are scanned: refusals lead the answer. Tradeoffs,
// accepted: a refusal after a long preamble is missed, and an answer that
// opens by quoting such a phrase as content is flagged.
export function isContextRefusal(text: string): boolean {
  const head = text.slice(0, 400);
  return REFUSAL_PATTERNS.some((re) => re.test(head));
}
