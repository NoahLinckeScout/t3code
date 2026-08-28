/**
 * How a caller learns its own thread id without MCP.
 *
 * An MCP-capable thread already knows its id: the credential was minted for it.
 * A thread driving the server through `POST /api/orchestration/dispatch` has no
 * such context, so its bearer session is the only identity the server holds.
 *
 * The binding is the session's `subject`. A session issued with
 * `subject = "thread:<uuid>"` is bound to that thread; anything else (the
 * default `"browser"`, a tool's `"scout-rsi"`, an empty string) is not bound.
 * `agent.whoami` resolves through this service and fails closed with
 * `self_not_bound` when there is no binding — a caller that cannot bind must
 * never be told a thread id it did not bring.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class SelfNotBoundError extends Schema.TaggedErrorClass<SelfNotBoundError>()(
  "SelfNotBoundError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const THREAD_SUBJECT_PREFIX = "thread:";

const decodeThreadIdOption = Schema.decodeUnknownOption(ThreadId);

/** `"thread:<uuid>"` → that ThreadId; anything else → undefined. */
export const threadIdFromSessionSubject = (subject: string): ThreadId | undefined => {
  if (!subject.startsWith(THREAD_SUBJECT_PREFIX)) {
    return undefined;
  }
  const candidate = subject.slice(THREAD_SUBJECT_PREFIX.length);
  const decoded = decodeThreadIdOption(candidate);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

export interface OrchestrationSelfIdentityShape {
  /**
   * The authenticated caller's thread id, or `self_not_bound` when the session
   * carries no thread binding.
   */
  readonly selfThreadId: Effect.Effect<ThreadId, SelfNotBoundError>;
}

export class OrchestrationSelfIdentity extends Context.Service<
  OrchestrationSelfIdentity,
  OrchestrationSelfIdentityShape
>()("t3/orchestration/Services/OrchestrationSelfIdentity") {}

/** Binds a session subject to its thread, failing closed otherwise. */
export const selfIdentityFromSessionSubject = (
  subject: string,
): OrchestrationSelfIdentityShape => ({
  selfThreadId: Effect.gen(function* () {
    const threadId = threadIdFromSessionSubject(subject);
    if (threadId === undefined) {
      return yield* new SelfNotBoundError({
        detail:
          "This session is not bound to a thread, so the server will not guess one. Issue the session with subject 'thread:<threadId>' to bind it.",
      });
    }
    return threadId;
  }),
});

/**
 * The identity for callers that reach the dispatch boundary without a session
 * binding at all — WebSocket dispatch, tests. Every whoami through it fails
 * closed, which is the correct answer for a caller the server cannot bind.
 */
export const unboundSelfIdentity: OrchestrationSelfIdentityShape =
  selfIdentityFromSessionSubject("");
