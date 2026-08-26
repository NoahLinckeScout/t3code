import { assert, describe, it } from "@effect/vitest";

import {
  TRAILING_TEXT_LIMIT,
  appendTrailingText,
  providerTransportFailure,
  transportFailureMessage,
} from "./transportFailure.ts";

describe("providerTransportFailure", () => {
  it("recognises the observed CANCEL death", () => {
    // Verbatim from the turn that killed a thread, recorded as `completed`.
    const failure = providerTransportFailure(
      "...working on the fix\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
    );
    assert.strictEqual(failure?.kind, "RetriableError");
    assert.strictEqual(failure?.code, "canceled");
    assert.strictEqual(failure?.detail, "http/2 stream closed with error code CANCEL (0x8)");
  });

  it("recognises the observed resource_exhausted death", () => {
    const failure = providerTransportFailure(
      "\n\nError: RetriableError: [resource_exhausted] Error",
    );
    assert.strictEqual(failure?.code, "resource_exhausted");
    assert.strictEqual(failure?.detail, "Error");
  });

  it("captures an unseen error code rather than only the two observed", () => {
    const failure = providerTransportFailure("Error: TransportError: [unavailable] backend down");
    assert.strictEqual(failure?.code, "unavailable");
    assert.strictEqual(failure?.kind, "TransportError");
  });

  it("ignores trailing blank lines", () => {
    assert.strictEqual(
      providerTransportFailure("Error: RetriableError: [canceled] gone\n\n  \n")?.code,
      "canceled",
    );
  });

  it("does not fire on a turn that merely discusses one of these failures", () => {
    // This is the observed false positive, not a hypothetical: a coordinator
    // thread was diagnosing these deaths while they happened, quoting the exact
    // line. Matching anywhere in the text would have marked that healthy turn
    // as failed.
    const analysis = [
      "Here's what I found across the four threads:",
      "",
      "```",
      "Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
      "```",
      "",
      "The RST originates upstream at Cursor, so it is not ours to fix at the transport layer.",
    ].join("\n");
    assert.strictEqual(providerTransportFailure(analysis), undefined);
  });

  it("does not fire on ordinary assistant output", () => {
    assert.strictEqual(providerTransportFailure("Done. All 36 tests pass."), undefined);
    assert.strictEqual(providerTransportFailure(""), undefined);
  });

  it("does not fire on prose that merely starts with the word Error", () => {
    assert.strictEqual(
      providerTransportFailure("Error handling in this module needs work."),
      undefined,
    );
  });
});

describe("transportFailureMessage", () => {
  it("keeps the provider's own detail when it said something", () => {
    const failure = providerTransportFailure(
      "Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
    );
    assert.match(transportFailureMessage(failure!), /http\/2 stream closed/);
  });

  it("says plainly when the provider supplied nothing useful", () => {
    // `[resource_exhausted]` arrived with the single word "Error" as its whole
    // payload, and was reasonably misread as an account quota. The recorded
    // message must not imply detail the provider never sent.
    const failure = providerTransportFailure("Error: RetriableError: [resource_exhausted] Error");
    const message = transportFailureMessage(failure!);
    assert.match(message, /no further detail/);
    assert.match(message, /resource_exhausted/);
  });
});

describe("appendTrailingText", () => {
  it("keeps only the trailing window of a long stream", () => {
    let text = "";
    for (let index = 0; index < 100; index += 1) text = appendTrailingText(text, "x".repeat(200));
    assert.strictEqual(text.length, TRAILING_TEXT_LIMIT);
  });

  it("still sees an error line that arrives after a large turn", () => {
    let text = appendTrailingText("", "a lot of streamed output. ".repeat(1000));
    text = appendTrailingText(text, "\nError: RetriableError: [canceled] stream closed");
    assert.strictEqual(providerTransportFailure(text)?.code, "canceled");
  });
});
