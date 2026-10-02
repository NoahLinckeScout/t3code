import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isUnknownModelSelectionError,
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
} from "./orchestration.ts";

describe("wasBootstrapThreadDeleted", () => {
  it("accepts only a confirmed deleted bootstrap thread", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(true);
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({ message: "Failed to create worktree." }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadDeleted(new Error("connection lost"))).toBe(false);
  });
});

describe("wasBootstrapThreadNotCreated", () => {
  it("accepts only a confirmed never-created bootstrap thread", () => {
    const notCreated = new OrchestrationDispatchCommandError({
      message: "A separate worktree requires a base commit.",
      bootstrapThreadDisposition: "not-created",
    });
    expect(wasBootstrapThreadNotCreated(notCreated)).toBe(true);
    expect(wasBootstrapThreadDeleted(notCreated)).toBe(false);
    expect(
      wasBootstrapThreadNotCreated(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(false);
    expect(
      wasBootstrapThreadNotCreated(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
        }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadNotCreated(new Error("connection lost"))).toBe(false);
  });
});

describe("isUnknownModelSelectionError", () => {
  it("accepts only a confirmed unknown-model rejection", () => {
    expect(
      isUnknownModelSelectionError(
        new OrchestrationDispatchCommandError({
          message: "Provider instance 'claudeAgent' has no model 'glm-5.3-flash-or'.",
          reason: "unknown_model",
        }),
      ),
    ).toBe(true);
    expect(
      isUnknownModelSelectionError(
        new OrchestrationDispatchCommandError({ message: "Failed to dispatch" }),
      ),
    ).toBe(false);
    expect(
      isUnknownModelSelectionError(
        new OrchestrationDispatchCommandError({
          message: "Failed to dispatch",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(false);
    expect(isUnknownModelSelectionError(new Error("connection lost"))).toBe(false);
  });
});
