import { EnvironmentInternalError, EnvironmentRequestInvalidError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationEngineInternalError,
  OrchestrationProjectorDecodeError,
  OrchestrationThreadSettleBlockedError,
} from "./Errors.ts";
import { classifyDispatchFailure } from "./http.ts";

const refusal = (detail: string) =>
  new OrchestrationCommandInvariantError({
    commandType: "thread.create",
    detail,
  });

describe("classifyDispatchFailure", () => {
  const reasonOf = (cause: unknown) =>
    Effect.runPromise(Effect.flip(classifyDispatchFailure(cause)));

  it("maps an invariant refusal to a 400 invalid_command carrying the refusal text", async () => {
    const error = (await reasonOf(
      refusal("Thread 'abc' already exists and cannot be created twice."),
    )) as EnvironmentRequestInvalidError;
    expect(error).toBeInstanceOf(EnvironmentRequestInvalidError);
    expect(error.reason).toBe("invalid_command");
    expect(error.detail).toBe(
      "Orchestration command invariant failed (thread.create): Thread 'abc' already exists and cannot be created twice.",
    );
  });

  it("maps a blocked settle to a 400 invalid_command", async () => {
    const error = (await reasonOf(
      new OrchestrationThreadSettleBlockedError({ threadId: "t-1" }),
    )) as EnvironmentRequestInvalidError;
    expect(error).toBeInstanceOf(EnvironmentRequestInvalidError);
    expect(error.reason).toBe("invalid_command");
    expect(error.detail).toContain("still needs attention");
  });

  it("maps an idempotent retry of a refused command to the same 400 with the saved refusal", async () => {
    const error = (await reasonOf(
      new OrchestrationCommandPreviouslyRejectedError({
        commandId: "cmd-1",
        detail: "Thread 'abc' already exists and cannot be created twice.",
      }),
    )) as EnvironmentRequestInvalidError;
    expect(error).toBeInstanceOf(EnvironmentRequestInvalidError);
    expect(error.reason).toBe("invalid_command");
    expect(error.detail).toContain("already exists and cannot be created twice");
  });

  it("keeps an engine-internal failure a 500", async () => {
    const error = (await reasonOf(
      new OrchestrationEngineInternalError({
        commandType: "thread.create",
        detail: "Failed to generate an event identifier.",
      }),
    )) as EnvironmentInternalError;
    expect(error).toBeInstanceOf(EnvironmentInternalError);
    expect(error.reason).toBe("orchestration_dispatch_failed");
  });

  it("keeps unrelated dispatch failures 500s", async () => {
    for (const cause of [
      new Error("boom"),
      new OrchestrationProjectorDecodeError({ eventType: "thread.created", issue: "bad" }),
    ]) {
      const error = (await reasonOf(cause)) as EnvironmentInternalError;
      expect(error).toBeInstanceOf(EnvironmentInternalError);
      expect(error.reason).toBe("orchestration_dispatch_failed");
    }
  });
});
