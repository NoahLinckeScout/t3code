import { describe, expect, it } from "vite-plus/test";
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
    expect(decodeSpawnInput({ ...base, workdir: "/bulk/repo" }).workdir).toBe("/bulk/repo");
  });

  it("accepts an absolute windows path", () => {
    expect(decodeSpawnInput({ ...base, workdir: "C:\\repos\\t3code" }).workdir).toBe(
      "C:\\repos\\t3code",
    );
  });

  it("rejects a relative path", () => {
    // The stored value becomes the child's cwd verbatim, so a relative path
    // would resolve against whatever the provider process happens to start in.
    expect(() => decodeSpawnInput({ ...base, workdir: "packages/contracts" })).toThrow();
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
    expect(rejection?.reason).toBe("handoff_rejected");
    expect(rejection?.detail ?? "").toMatch(/honest status is blocked/);
  });

  it("accepts a blocked handoff with no validation", () => {
    // Blocked is the honest terminal state for work that could not run, so it
    // must stay reachable without evidence or children will pad to look done.
    expect(handoffRejection(handoff({ status: "blocked", validation: [] }))).toBeUndefined();
  });

  it("accepts a completed handoff that cites what it ran", () => {
    expect(handoffRejection(handoff())).toBeUndefined();
  });
});

describe("briefRejection", () => {
  it("accepts a brief inside the budget", () => {
    expect(briefRejection(JSON.stringify(handoff()), "handoff")).toBeUndefined();
  });

  it("rejects a brief that is carrying a transcript", () => {
    const rejection = briefRejection("x".repeat(MAX_BRIEF_BYTES + 1), "handoff");
    expect(rejection?.reason).toBe("handoff_rejected");
    expect(rejection?.detail ?? "").toMatch(/do not paste content/);
  });

  it("reports an oversized message as a message rejection", () => {
    const rejection = briefRejection("x".repeat(MAX_BRIEF_BYTES + 1), "message");
    expect(rejection?.reason).toBe("message_rejected");
  });
});
