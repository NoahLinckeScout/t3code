import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

export function wasBootstrapThreadNotCreated(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "not-created"
  );
}

/**
 * The server refused the command's model selection: the named Claude instance
 * does not list the model. Retrying cannot succeed — the payload itself needs
 * correcting.
 */
export function isUnknownModelSelectionError(error: unknown): boolean {
  return isOrchestrationDispatchCommandError(error) && error.reason === "unknown_model";
}
