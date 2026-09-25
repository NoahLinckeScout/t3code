import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
} from "./environmentHttp.ts";

const traceId = "trace-1";

describe("environment HTTP errors", () => {
  // A client squashes the cause and shows `message`; an empty one becomes a generic
  // "The environment request failed." that names nothing the reader can act on.
  it("each carries a message that names its reason", () => {
    const errors = [
      new EnvironmentRequestInvalidError({
        code: "invalid_request",
        reason: "invalid_command",
        traceId,
      }),
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId,
      }),
      new EnvironmentScopeRequiredError({
        code: "insufficient_scope",
        requiredScope: "orchestration:read",
        traceId,
      }),
      new EnvironmentOperationForbiddenError({
        code: "operation_forbidden",
        reason: "current_session_revoke_not_allowed",
        traceId,
      }),
      new EnvironmentResourceNotFoundError({
        code: "not_found",
        reason: "thread_not_found",
        traceId,
      }),
      new EnvironmentInternalError({
        code: "internal_error",
        reason: "orchestration_snapshot_failed",
        traceId,
      }),
    ] as const;
    const details = [
      "invalid_command",
      "missing_credential",
      "orchestration:read",
      "current_session_revoke_not_allowed",
      "thread_not_found",
      "orchestration_snapshot_failed",
    ];
    errors.forEach((error, index) => {
      expect(error.message).toContain(details[index]);
    });
  });

  // The dispatch route surfaces a refused command (invariant refusal, blocked
  // settle) as this error with the refusal's own text; the optional detail must
  // survive the JSON round trip a client performs and stay absent when unset.
  it("EnvironmentRequestInvalidError round-trips an optional detail", () => {
    const withDetail = new EnvironmentRequestInvalidError({
      code: "invalid_request",
      reason: "invalid_command",
      traceId,
      detail: "Thread 'abc' already exists and cannot be created twice.",
    });
    expect(withDetail.message).toContain("already exists and cannot be created twice");

    const encoded = JSON.parse(
      JSON.stringify(Schema.encodeUnknownSync(EnvironmentRequestInvalidError)(withDetail)),
    );
    const decoded = Schema.decodeUnknownSync(EnvironmentRequestInvalidError)(encoded);
    expect(decoded.detail).toBe("Thread 'abc' already exists and cannot be created twice.");

    const withoutDetail = Schema.decodeUnknownSync(EnvironmentRequestInvalidError)({
      _tag: "EnvironmentRequestInvalidError",
      code: "invalid_request",
      reason: "invalid_command",
      traceId,
    });
    expect(withoutDetail.detail).toBeUndefined();
    expect(withoutDetail.message).toBe("The environment rejected the request (invalid_command).");
  });
});
