import { ThreadId } from "@t3tools/contracts";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export class OrchestrationCommandJsonParseError extends Schema.TaggedError<OrchestrationCommandJsonParseError>()(
  "OrchestrationCommandJsonParseError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Invalid orchestration command JSON: ${this.detail}`;
  }
}

export class OrchestrationCommandDecodeError extends Schema.TaggedError<OrchestrationCommandDecodeError>()(
  "OrchestrationCommandDecodeError",
  {
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Invalid orchestration command payload: ${this.issue}`;
  }
}

export class OrchestrationCommandInvariantError extends Schema.TaggedError<OrchestrationCommandInvariantError>()(
  "OrchestrationCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Orchestration command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export class OrchestrationThreadSettleBlockedError extends Schema.TaggedError<OrchestrationThreadSettleBlockedError>()(
  "OrchestrationThreadSettleBlockedError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This thread still needs attention. Resolve or interrupt it first, then try again.";
  }
}

export class OrchestrationCommandPreviouslyRejectedError extends Schema.TaggedError<OrchestrationCommandPreviouslyRejectedError>()(
  "OrchestrationCommandPreviouslyRejectedError",
  {
    commandId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Command previously rejected (${this.commandId}): ${this.detail}`;
  }
}

/**
 * An engine-side failure (event identifier generation, a command that somehow
 * produced no events) that happens to surface through the same dispatch path
 * as client refusals. It is deliberately NOT part of `OrchestrationCommandRejection`:
 * these are server faults, so the HTTP mapping keeps them as 500s and the
 * engine records no rejection receipt — a retry should retry, not replay a
 * refusal the client never caused.
 */
export class OrchestrationEngineInternalError extends Schema.TaggedError<OrchestrationEngineInternalError>()(
  "OrchestrationEngineInternalError",
  {
    commandType: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Orchestration engine failed internally (${this.commandType}): ${this.detail}`;
  }
}

export const OrchestrationCommandRejection = Schema.Union([
  OrchestrationCommandInvariantError,
  OrchestrationThreadSettleBlockedError,
  // An idempotent retry of a refused command replays the persisted rejection
  // receipt as this error. It is the same refusal the first attempt saw, so
  // consumers that classify rejections (the dispatch HTTP 400 mapping) must
  // classify the replay identically instead of falling back to a 500.
  OrchestrationCommandPreviouslyRejectedError,
]);
export type OrchestrationCommandRejection = typeof OrchestrationCommandRejection.Type;
export const isOrchestrationCommandRejection = Schema.is(OrchestrationCommandRejection);

export class OrchestrationCommandIdConflictError extends Schema.TaggedError<OrchestrationCommandIdConflictError>()(
  "OrchestrationCommandIdConflictError",
  {
    commandId: Schema.String,
    receiptAggregateKind: Schema.String,
    receiptAggregateId: Schema.String,
    commandAggregateKind: Schema.String,
    commandAggregateId: Schema.String,
  },
) {
  override get message(): string {
    return `Command id '${this.commandId}' already used for ${this.receiptAggregateKind} '${this.receiptAggregateId}'; refusing to replay its receipt for ${this.commandAggregateKind} '${this.commandAggregateId}'.`;
  }
}

export class OrchestrationProjectorDecodeError extends Schema.TaggedError<OrchestrationProjectorDecodeError>()(
  "OrchestrationProjectorDecodeError",
  {
    eventType: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Projector decode failed for ${this.eventType}: ${this.issue}`;
  }
}

export class OrchestrationListenerCallbackError extends Schema.TaggedError<OrchestrationListenerCallbackError>()(
  "OrchestrationListenerCallbackError",
  {
    listener: Schema.Literals(["read-model", "domain-event"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Orchestration ${this.listener} listener failed: ${this.detail}`;
  }
}

export type OrchestrationDispatchError =
  | ProjectionRepositoryError
  | OrchestrationCommandRejection
  | OrchestrationCommandIdConflictError
  | OrchestrationEngineInternalError
  | OrchestrationProjectorDecodeError
  | OrchestrationListenerCallbackError;

export type OrchestrationEngineError =
  | OrchestrationDispatchError
  | OrchestrationCommandJsonParseError
  | OrchestrationCommandDecodeError;

export function toProjectorDecodeError(eventType: string) {
  return (error: Schema.SchemaError): OrchestrationProjectorDecodeError =>
    new OrchestrationProjectorDecodeError({
      eventType,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}
