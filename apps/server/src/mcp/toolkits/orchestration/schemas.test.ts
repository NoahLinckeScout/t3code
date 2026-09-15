import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  type DelegationHandoff,
  MAX_BRIEF_BYTES,
  briefRejection,
  handoffRejection,
  SpawnInput,
} from "./schemas.ts";

const decodeSpawnInput = Schema.decodeUnknownSync(SpawnInput);

describe("SpawnInput workdir", () => {
  const base = { role: "implementer", objective: "Ship it", judgment: "Scope of the fix" };

  it("accepts an absolute posix path", () => {
    assert.strictEqual(decodeSpawnInput({ ...base, workdir: "/bulk/repo" }).workdir, "/bulk/repo");
  });

  it("accepts an absolute windows path", () => {
    assert.strictEqual(
      decodeSpawnInput({ ...base, workdir: "C:\\repos\\t3code" }).workdir,
      "C:\\repos\\t3code",
    );
  });

  it("rejects a relative path", () => {
    // The stored value becomes the child's cwd verbatim, so a relative path
    // would resolve against whatever the provider process happens to start in.
    assert.throws(() => decodeSpawnInput({ ...base, workdir: "packages/contracts" }));
  });
});

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
