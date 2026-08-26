import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  DEFAULT_STALL_WINDOW_MS,
  type DelegationProgress,
  classifyDelegation,
} from "./staleness.ts";

const NOW = "2026-08-26T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const minutesAgo = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(NOW_MS - minutes * 60_000));

const progress = (overrides: Partial<DelegationProgress> = {}): DelegationProgress => ({
  state: "running",
  childThreadId: "thread-child",
  latestTurnState: "running",
  lastActivityAt: minutesAgo(1),
  createdAt: minutesAgo(5),
  deadlineAt: null,
  ...overrides,
});

describe("classifyDelegation", () => {
  it("says nothing about a child that is working", () => {
    assert.strictEqual(classifyDelegation(progress(), NOW), undefined);
  });

  it("ignores delegations that already reached a terminal state", () => {
    assert.strictEqual(
      classifyDelegation(progress({ state: "completed", latestTurnState: "completed" }), NOW),
      undefined,
    );
  });

  for (const turnState of ["completed", "interrupted", "error"]) {
    it(`fails a live delegation whose child turn is ${turnState} with no handoff`, () => {
      // The run-one failure: work done, report never made. Deterministic — no
      // clock is consulted, so a slow model can never be mistaken for this.
      const verdict = classifyDelegation(progress({ latestTurnState: turnState }), NOW);
      assert.strictEqual(verdict?.reason, "child_turn_ended_without_handoff");
      assert.strictEqual(verdict?.autoFail, true);
    });
  }

  it("prefers the deterministic verdict over a timing one", () => {
    // Both conditions hold. The reported reason must be the provable one.
    const verdict = classifyDelegation(
      progress({
        latestTurnState: "completed",
        deadlineAt: minutesAgo(60),
        lastActivityAt: minutesAgo(600),
      }),
      NOW,
    );
    assert.strictEqual(verdict?.reason, "child_turn_ended_without_handoff");
  });

  it("flags an overdue child without failing it", () => {
    // A slow child and a hung one are indistinguishable from here, so this
    // raises a hand rather than killing work that may still land.
    const verdict = classifyDelegation(progress({ deadlineAt: minutesAgo(1) }), NOW);
    assert.strictEqual(verdict?.reason, "overdue");
    assert.strictEqual(verdict?.autoFail, false);
  });

  it("flags a child that has produced no activity for the stall window", () => {
    const verdict = classifyDelegation(
      progress({ lastActivityAt: minutesAgo(DEFAULT_STALL_WINDOW_MS / 60_000 + 1) }),
      NOW,
    );
    assert.strictEqual(verdict?.reason, "no_progress");
    assert.strictEqual(verdict?.autoFail, false);
  });

  it("does not treat a recently started child with no activity yet as stalled", () => {
    assert.strictEqual(
      classifyDelegation(progress({ lastActivityAt: null, createdAt: minutesAgo(2) }), NOW),
      undefined,
    );
  });

  it("fails a delegation that was never bound to a child thread", () => {
    const verdict = classifyDelegation(
      progress({
        state: "pending",
        childThreadId: null,
        latestTurnState: null,
        createdAt: minutesAgo(120),
      }),
      NOW,
    );
    assert.strictEqual(verdict?.reason, "never_started");
    assert.strictEqual(verdict?.autoFail, true);
  });

  it("gives an in-flight spawn time to bind its child", () => {
    assert.strictEqual(
      classifyDelegation(
        progress({
          state: "pending",
          childThreadId: null,
          latestTurnState: null,
          createdAt: minutesAgo(1),
        }),
        NOW,
      ),
      undefined,
    );
  });

  it("never consults a field the sweep itself writes", () => {
    // Guards the heartbeat mistake structurally: the progress record has no
    // updated_at or heartbeat field to key off, by construction. If someone adds
    // one, this test is where the argument has to happen.
    const keys = Object.keys(progress()).sort();
    assert.deepStrictEqual(keys, [
      "childThreadId",
      "createdAt",
      "deadlineAt",
      "lastActivityAt",
      "latestTurnState",
      "state",
    ]);
  });
});
