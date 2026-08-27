/**
 * Recognising a turn that a provider CLI killed but reported as a success.
 *
 * ## Why this exists, and why it is text matching
 *
 * Five threads died mid-turn against `cursor-agent` and every one of them was
 * recorded as `state: completed`. The provider event log shows why: on those
 * turns `session/prompt` returned **succeeded** with `stopReason: "end_turn"`,
 * exactly like a healthy turn. The only trace of the failure anywhere in the ACP
 * stream is a line of assistant text emitted just before the stream ended:
 *
 *     Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)
 *     Error: RetriableError: [resource_exhausted] Error
 *
 * There is no structured signal to key off. No ACP error response, no non-`ready`
 * session status, no `lastError`. So either the harness records these as
 * successes — the failure mode this project exists to eliminate — or it reads the
 * one signal the provider does send.
 *
 * This is not policing model prose. The string is emitted by a known program in a
 * fixed format, and is parsed the way compiler output is parsed. But it is still a
 * heuristic over text, so it is deliberately conservative: see `isFinalLine`.
 */

/**
 * A provider CLI error line: `Error: RetriableError: [code] detail`.
 *
 * The code is captured rather than enumerated. `canceled` and `resource_exhausted`
 * are the two observed, but the set belongs to the provider and guessing at its
 * membership would mean silently mis-classifying the next one.
 */
const PROVIDER_ERROR_LINE = /^Error:\s*(\w*Error):\s*\[(\w+)\]\s*(.*)$/;

/**
 * How much of a turn's trailing output to keep in memory while it streams.
 *
 * Only the last line matters, so this holds a small window rather than the
 * transcript. A turn that streams megabytes still costs this much.
 */
export const TRAILING_TEXT_LIMIT = 4096;

export interface ProviderTransportFailure {
  /** The provider's error class, e.g. `RetriableError`. */
  readonly kind: string;
  /** The provider's status code, e.g. `canceled`, `resource_exhausted`. */
  readonly code: string;
  /** Whatever detail the provider supplied, which is often very little. */
  readonly detail: string;
  /** The matched line, verbatim, for recording as the turn's error. */
  readonly line: string;
}

/** Keeps the trailing window of a stream without retaining the whole thing. */
export const appendTrailingText = (existing: string, delta: string): string => {
  const combined = existing + delta;
  return combined.length <= TRAILING_TEXT_LIMIT
    ? combined
    : combined.slice(combined.length - TRAILING_TEXT_LIMIT);
};

/**
 * Classify the trailing text of a finished turn.
 *
 * The rule is that the error line must be the **last non-empty line** of the
 * turn. That restriction is what makes this safe to act on: an agent that
 * discusses one of these failures quotes it mid-analysis and keeps writing, so
 * the quote is never the last thing it says. A thread doing exactly that —
 * diagnosing these deaths while they happened — is why the rule is not "contains
 * a RetriableError line anywhere".
 *
 * A turn whose genuine final word is a bare provider error line has, either way,
 * not produced a usable result.
 */
export const providerTransportFailure = (
  trailingText: string,
): ProviderTransportFailure | undefined => {
  const lines = trailingText.split("\n");
  let lastNonEmpty: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index]?.trim() ?? "";
    if (candidate.length > 0) {
      lastNonEmpty = candidate;
      break;
    }
  }
  if (lastNonEmpty === undefined) return undefined;

  const match = PROVIDER_ERROR_LINE.exec(lastNonEmpty);
  if (!match) return undefined;
  const [, kind, code, detail] = match;
  if (kind === undefined || code === undefined) return undefined;
  return { kind, code, detail: detail ?? "", line: lastNonEmpty };
};

/**
 * The message recorded as the turn's error.
 *
 * Deliberately preserves the provider's own line verbatim instead of
 * substituting a friendlier summary. When `[resource_exhausted]` arrived, its
 * entire payload was the word "Error" — and a reader who sees that, rather than a
 * harness-authored gloss, can tell that the provider said nothing useful rather
 * than assuming a quota was hit.
 */
export const transportFailureMessage = (failure: ProviderTransportFailure): string =>
  failure.detail.length > 0 && failure.detail !== "Error"
    ? `Provider reported ${failure.kind} [${failure.code}]: ${failure.detail}`
    : `Provider reported ${failure.kind} [${failure.code}] with no further detail. The turn ended without a usable result.`;
