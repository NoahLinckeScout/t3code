/**
 * Schemas for the orchestration toolkit.
 *
 * These live here rather than in `packages/contracts` on purpose. This toolkit
 * is fork-local, and every symbol it adds to a shared package is a rebase
 * conflict against upstream. Nothing here crosses the websocket wire: the tools
 * are reached over the per-thread MCP endpoint, which carries its own JSON
 * schema derived from these definitions.
 */
import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * A delegation's identity is its own, not the child thread's.
 *
 * A thread id is where a delegation is currently running; it changes when work
 * is retried, and it is meaningless once the thread is archived. Keying the
 * durable record on the thread would make provider identity load-bearing, which
 * is the coupling this toolkit exists to avoid.
 */
export const DelegationId = TrimmedNonEmptyString.pipe(Schema.brand("DelegationId"));
export type DelegationId = typeof DelegationId.Type;

export const OrchestrationMessageId = TrimmedNonEmptyString.pipe(
  Schema.brand("OrchestrationMessageId"),
);
export type OrchestrationMessageId = typeof OrchestrationMessageId.Type;

/**
 * `pending` exists because the durable row is written before the spawn command
 * is dispatched. A crash between the two leaves a `pending` row whose command id
 * can be safely re-dispatched, rather than a child nobody recorded.
 */
export const DelegationState = Schema.Literals([
  "pending",
  "running",
  "completed",
  "blocked",
  "failed",
]);
export type DelegationState = typeof DelegationState.Type;

/**
 * A handoff is a brief, not a transcript. The budget is inherited from a harness
 * that measured the alternative: a 55 KB project document was 52% of one
 * small-context turn's cumulative input, re-sent on every model call because
 * self-hosted routes credit no prompt caching.
 */
export const MAX_BRIEF_BYTES = 64 * 1024;

/**
 * The terminal report a child owes its parent.
 *
 * Deliberately free of repository, branch, and head fields. The reference
 * implementation this generalizes required them, which quietly made every
 * delegation a Git delegation. A caller with a repository to report puts it in
 * `artifacts`.
 *
 * The struct is closed, so "brief, not transcript" is enforced by shape as well
 * as by size: there is nowhere to attach a conversation, and the fields that do
 * exist are short strings whose total is bounded by `MAX_BRIEF_BYTES`.
 */
export const DelegationHandoff = Schema.Struct({
  status: Schema.Literals(["completed", "blocked"]),
  summary: TrimmedNonEmptyString.annotate({
    description: "What was done or what blocked, in a few sentences. Not a transcript.",
  }),
  artifacts: Schema.Array(TrimmedNonEmptyString).annotate({
    description:
      "Durable locations a reader can open: file paths, PR urls, commit shas. Never pasted content.",
  }),
  validation: Schema.Array(TrimmedNonEmptyString).annotate({
    description:
      "Commands actually run and their results. Required when status is completed; claiming completion with no evidence is rejected.",
  }),
  remainingRisks: Schema.Array(TrimmedNonEmptyString),
  nextStep: TrimmedNonEmptyString.annotate({
    description: "The single next action you recommend, or the decision you need from the parent.",
  }),
});
export type DelegationHandoff = typeof DelegationHandoff.Type;

export const DelegationHandoffFromJson = Schema.fromJsonString(DelegationHandoff);

export const SpawnInput = Schema.Struct({
  role: TrimmedNonEmptyString.annotate({
    description:
      "A role declared in this environment's orchestration roles config. Roles name capability, not vendor: the config decides which provider instance and model serve the role.",
  }),
  objective: TrimmedNonEmptyString.annotate({
    description: "What the child owns. Bound it: a child that owns everything owns nothing.",
  }),
  /**
   * The guard against the failure mode that burned 307.8M tokens in the harness
   * this generalizes: a model placed in a loop that was already a script.
   */
  judgment: TrimmedNonEmptyString.annotate({
    description:
      "The specific judgment the child must exercise — what it has to decide that a script could not. If you cannot fill this in, you do not need a model here; write the script instead.",
  }),
  nonGoals: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /**
   * Opaque on purpose. Orchestration should not know what a pull request is.
   */
  resourceLease: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "An opaque string naming a resource only one live delegation may hold, such as 'git:owner/repo#branch' or a worktree path. A second spawn requesting a held lease is refused.",
    }),
  ),
  workdir: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Absolute path the child starts in. Defaults to the parent thread's worktree.",
    }),
  ),
  idempotencyKey: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Replay guard. Spawning twice with one key returns the original delegation instead of a second child.",
    }),
  ),
});
export type SpawnInput = typeof SpawnInput.Type;

export const SpawnResult = Schema.Struct({
  delegationId: DelegationId,
  state: DelegationState,
  role: Schema.String,
  providerInstanceId: Schema.String,
  model: Schema.String,
  /** A locator, not the delegation's identity. Address the child by delegationId. */
  childThreadId: ThreadId,
  replayed: Schema.Boolean,
});

export const HandoffInput = Schema.Struct({
  handoff: DelegationHandoff,
});

export const HandoffResult = Schema.Struct({
  delegationId: DelegationId,
  state: DelegationState,
  parentThreadId: ThreadId,
});

export const MessageInput = Schema.Struct({
  toDelegationId: Schema.optional(DelegationId),
  toThreadId: Schema.optional(ThreadId),
  body: TrimmedNonEmptyString.annotate({
    description: "The message. A brief, subject to the same size budget as a handoff.",
  }),
  idempotencyKey: TrimmedNonEmptyString.annotate({
    description: "Replay guard. Re-sending with one key does not enqueue a second copy.",
  }),
});

export const MessageResult = Schema.Struct({
  messageId: OrchestrationMessageId,
  toThreadId: ThreadId,
  /** False when this exact message was already enqueued under the same key. */
  enqueued: Schema.Boolean,
  /**
   * Always false. Stated in the result so the contract is visible at the call
   * site rather than only in prose: enqueuing never starts a turn.
   */
  wokeRecipient: Schema.Boolean,
});

export const InboxInput = Schema.Struct({
  includeDelivered: Schema.optional(Schema.Boolean),
});

export const InboxMessage = Schema.Struct({
  messageId: OrchestrationMessageId,
  fromThreadId: ThreadId,
  fromDelegationId: Schema.NullOr(DelegationId),
  body: Schema.String,
  createdAt: Schema.String,
});

export const InboxDelegation = Schema.Struct({
  delegationId: DelegationId,
  state: DelegationState,
  role: Schema.String,
  objective: Schema.String,
  providerInstanceId: Schema.String,
  model: Schema.String,
  childThreadId: Schema.NullOr(ThreadId),
  resourceLease: Schema.NullOr(Schema.String),
  handoff: Schema.NullOr(DelegationHandoff),
  updatedAt: Schema.String,
});

export const InboxResult = Schema.Struct({
  messages: Schema.Array(InboxMessage),
  delegations: Schema.Array(InboxDelegation),
  newMessageCount: NonNegativeInt,
});

export const OrchestrationToolkitErrorReason = Schema.Literals([
  "roles_config_missing",
  "role_not_found",
  "role_disabled",
  "spawn_not_permitted",
  "depth_exceeded",
  "lease_held",
  "delegation_not_found",
  "delegation_not_live",
  "handoff_rejected",
  "message_rejected",
  "dispatch_failed",
  "storage_failed",
]);
export type OrchestrationToolkitErrorReason = typeof OrchestrationToolkitErrorReason.Type;

export class OrchestrationToolkitError extends Schema.TaggedErrorClass<OrchestrationToolkitError>()(
  "OrchestrationToolkitError",
  {
    reason: OrchestrationToolkitErrorReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * A completed handoff with no validation evidence is a claim, not a result.
 *
 * This is the explicit half of "an empty completion is a failure". The
 * structural half is that no code path moves a delegation to `completed` except
 * an accepted handoff, so a child that simply stops leaves its delegation
 * `running` rather than reading as success.
 */
export const handoffRejection = (
  handoff: DelegationHandoff,
): OrchestrationToolkitError | undefined =>
  handoff.status === "completed" && handoff.validation.length === 0
    ? new OrchestrationToolkitError({
        reason: "handoff_rejected",
        detail:
          "A completed handoff must list the validation you actually ran. If you ran nothing, the honest status is blocked.",
      })
    : undefined;

/** Rejects a record that is carrying a conversation instead of a brief. */
export const briefRejection = (
  encoded: string,
  label: "handoff" | "message",
): OrchestrationToolkitError | undefined => {
  const size = Buffer.byteLength(encoded);
  return size > MAX_BRIEF_BYTES
    ? new OrchestrationToolkitError({
        reason: label === "message" ? "message_rejected" : "handoff_rejected",
        detail: `This ${label} is ${size} bytes, over the ${MAX_BRIEF_BYTES}-byte budget. Cite durable paths and let the reader open them; do not paste content.`,
      })
    : undefined;
};
