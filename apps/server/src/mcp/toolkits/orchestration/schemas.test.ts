import { assert, describe, it } from "@effect/vitest";

import {
  type DelegationHandoff,
  MAX_BRIEF_BYTES,
  briefRejection,
  handoffRejection,
} from "./schemas.ts";

const handoff = (overrides: Partial<DelegationHandoff> = {}): DelegationHandoff => ({
  status: "completed",
  summary: "Fixed the failing migration and added a regression test.",
  artifacts: ["apps/server/src/persistence/Migrations/044_Thing.ts"],
  validation: ["vp test run Migrations — 12 passed"],
  remainingRisks: [],
  nextStep: "Review and merge.",
  ...overrides,
});

describe("handoffRejection", () => {
  it("rejects a completed handoff that lists no validation", () => {
    // The production failure this encodes: a lane reported success for weeks
    // while producing nothing, because nobody required evidence of work.
    const rejection = handoffRejection(handoff({ validation: [] }));
    assert.strictEqual(rejection?.reason, "handoff_rejected");
    assert.match(rejection?.detail ?? "", /honest status is blocked/);
  });

  it("accepts a blocked handoff with no validation", () => {
    // Blocked is the honest terminal state for work that could not run, so it
    // must stay reachable without evidence or children will pad to look done.
    assert.strictEqual(handoffRejection(handoff({ status: "blocked", validation: [] })), undefined);
  });

  it("accepts a completed handoff that cites what it ran", () => {
    assert.strictEqual(handoffRejection(handoff()), undefined);
  });
});

describe("briefRejection", () => {
  it("accepts a brief inside the budget", () => {
    assert.strictEqual(briefRejection(JSON.stringify(handoff()), "handoff"), undefined);
  });

  it("rejects a brief that is carrying a transcript", () => {
    const rejection = briefRejection("x".repeat(MAX_BRIEF_BYTES + 1), "handoff");
    assert.strictEqual(rejection?.reason, "handoff_rejected");
    assert.match(rejection?.detail ?? "", /do not paste content/);
  });

  it("reports an oversized message as a message rejection", () => {
    const rejection = briefRejection("x".repeat(MAX_BRIEF_BYTES + 1), "message");
    assert.strictEqual(rejection?.reason, "message_rejected");
  });
});
