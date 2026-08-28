import { CommandId, EventId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationActor } from "./actor.ts";
import { DelegationStore, type DelegationRow } from "./DelegationStore.ts";
import { type StaleVerdict, classifyDelegation } from "./staleness.ts";
import { OrchestrationRoles, type ResolvedRole } from "./roles.ts";
import {
  type DelegationHandoff,
  AbandonedRecordFromJson,
  DelegationHandoffFromJson,
  type DelegationId,
  DelegationId as DelegationIdSchema,
  OrchestrationMessageId,
  OrchestrationToolkitError,
  briefRejection,
  handoffRejection,
} from "./schemas.ts";
import { OrchestrationToolkit } from "./tools.ts";

const isoNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const encodeHandoff = Schema.encodeEffect(DelegationHandoffFromJson);
const encodeAbandoned = Schema.encodeEffect(AbandonedRecordFromJson);
const decodeHandoff = Schema.decodeUnknownEffect(DelegationHandoffFromJson);

const dispatchFailed = (operation: string) => (cause: unknown) =>
  new OrchestrationToolkitError({
    reason: "dispatch_failed",
    detail: `${operation} was not accepted: ${String(cause)}`,
  });

const encodingFailed = (cause: unknown) =>
  new OrchestrationToolkitError({
    reason: "handoff_rejected",
    detail: `The handoff could not be encoded: ${String(cause)}`,
  });

/**
 * The opening brief a child receives.
 *
 * Deliberately short. A child on a small-context self-hosted route pays for this
 * text on every model call in its first turn, because those routes credit no
 * prompt caching. Everything the child could read for itself is left for it to
 * read.
 */
const openingBrief = (input: {
  readonly objective: string;
  readonly judgment: string;
  readonly nonGoals: ReadonlyArray<string> | undefined;
  readonly role: ResolvedRole;
  readonly delegationId: DelegationId;
}): string => {
  const lines = [
    `You are a delegated agent working under a parent thread. Your role is ${input.role.name}.`,
    "",
    `Objective: ${input.objective}`,
    `The judgment you own: ${input.judgment}`,
  ];
  if (input.nonGoals && input.nonGoals.length > 0) {
    lines.push(`Explicitly not yours: ${input.nonGoals.join("; ")}`);
  }
  if (input.role.instructions) {
    lines.push("", input.role.instructions);
  }
  lines.push(
    "",
    "Work only inside that objective. If a decision outside it is required, stop and report it rather than deciding.",
    "",
    `Your final action must be a call to \`agent_handoff\` (delegation ${input.delegationId}). Write a brief, not a transcript: cite durable paths, list the commands you actually ran, and name the single next step. A completed status with no validation is rejected — if you ran nothing, report blocked.`,
    "Ending your turn without calling `agent_handoff` leaves this delegation unfinished. Silence is never read as success.",
  );
  return lines.join("\n");
};

const appendActivity = Effect.fn("OrchestrationToolkit.appendActivity")(function* (input: {
  readonly threadId: ThreadId;
  readonly tone: "info" | "tool" | "error";
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
}) {
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const now = yield* isoNow;
  const activityId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  yield* engine
    .dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`delegation-activity:${commandId}`),
      threadId: input.threadId,
      activity: {
        id: EventId.make(activityId),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    })
    .pipe(Effect.mapError(dispatchFailed("thread.activity.append")));
});

/**
 * Finds delegations that have stopped making progress, and says so once.
 *
 * Runs on tool invocation rather than on a timer. A fork should not own a
 * scheduler, and more importantly a timer-driven sweep is what invites the
 * heartbeat mistake: something that runs on its own tends to acquire the habit
 * of writing the freshness it is supposed to be measuring. This reads evidence
 * from the child's projections, writes only terminal state and a one-shot alert,
 * and touches nothing that feeds back into its own verdict.
 *
 * The cost is honest and worth stating: if no thread ever calls a tool, nothing
 * sweeps. What that buys is that a stale delegation is never *hidden* — the
 * verdict is derived on every read, so it cannot be stale-but-looking-fresh.
 */
const sweepStaleDelegations = Effect.fn("OrchestrationToolkit.sweepStaleDelegations")(function* () {
  const store = yield* DelegationStore;
  const now = yield* isoNow;
  const live = yield* store.listLiveWithProgress();

  const verdicts: Array<{ readonly row: DelegationRow; readonly verdict: StaleVerdict }> = [];
  for (const row of live) {
    const verdict = classifyDelegation(
      {
        state: row.state,
        childThreadId: row.childThreadId,
        latestTurnState: row.latestTurnState,
        lastActivityAt: row.lastActivityAt,
        createdAt: row.createdAt,
        deadlineAt: row.deadlineAt,
        rejectedHandoffAttempts: row.rejectedHandoffAttempts,
      },
      now,
    );
    if (verdict) verdicts.push({ row, verdict });
  }

  for (const { row, verdict } of verdicts) {
    if (verdict.autoFail) {
      const abandoned = yield* encodeAbandoned({ abandoned: verdict.detail }).pipe(Effect.orDie);
      yield* store.markFailed(row.delegationId, abandoned);
    }
    const claimed = yield* store.markAlerted(row.delegationId);
    if (!claimed) continue;

    yield* store.enqueueMessage({
      messageId: `stale:${row.delegationId}`,
      fromThreadId: row.parentThreadId,
      fromDelegationId: row.delegationId,
      toThreadId: row.parentThreadId,
      body: `Delegation ${row.delegationId} (${row.role}) stopped making progress: ${verdict.reason}. ${verdict.detail}`,
    });
    // Surfaces in the parent thread's timeline, so a human sees it without
    // anyone calling agent_inbox.
    yield* appendActivity({
      threadId: row.parentThreadId,
      tone: "error",
      kind: "delegation.stalled",
      summary: `${row.role} stalled: ${verdict.reason}`,
      payload: {
        delegationId: row.delegationId,
        reason: verdict.reason,
        detail: verdict.detail,
        autoFailed: verdict.autoFail,
        objective: row.objective,
      },
    });
  }

  return new Map(verdicts.map(({ row, verdict }) => [row.delegationId as string, verdict]));
});

const toInboxDelegation = Effect.fn("OrchestrationToolkit.toInboxDelegation")(function* (
  row: DelegationRow,
  verdict?: StaleVerdict | undefined,
) {
  const handoff =
    row.handoffJson === null
      ? null
      : yield* decodeHandoff(row.handoffJson).pipe(
          // A row we wrote ourselves that no longer decodes is a bug, not a caller
          // error; surfacing null keeps the rest of the inbox readable.
          Effect.orElseSucceed(() => null),
        );
  return {
    delegationId: row.delegationId,
    state: row.state,
    role: row.role,
    objective: row.objective,
    providerInstanceId: row.providerInstanceId,
    model: row.model,
    childThreadId: row.childThreadId,
    resourceLease: row.resourceLease,
    handoff,
    staleReason: verdict?.reason ?? null,
    staleDetail: verdict?.detail ?? null,
    updatedAt: row.updatedAt,
  };
});

const agent_spawn = Effect.fn("OrchestrationToolkit.agent_spawn")(function* (input: {
  readonly role: string;
  readonly objective: string;
  readonly judgment: string;
  readonly nonGoals?: ReadonlyArray<string> | undefined;
  readonly resourceLease?: string | undefined;
  readonly workdir?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}) {
  const actor = yield* OrchestrationActor;
  const store = yield* DelegationStore;
  const roles = yield* OrchestrationRoles;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const parentThreadId = actor.threadId;

  // A thread that is itself a delegated child spawns only if its own role says
  // it may. An operator-started thread has no delegation row and is unrestricted.
  const ownDelegation = yield* store.findByChildThread(parentThreadId);
  const permitted = yield* roles.canSpawnFrom(ownDelegation?.role);
  if (!permitted) {
    return yield* new OrchestrationToolkitError({
      reason: "spawn_not_permitted",
      detail: `Role ${ownDelegation?.role ?? "(unknown)"} may not spawn. Report what you need to your parent instead of delegating onward.`,
    });
  }

  const maxDepth = yield* roles.maxDepth;
  const depth = yield* store.depthOf(parentThreadId);
  if (depth + 1 > maxDepth) {
    return yield* new OrchestrationToolkitError({
      reason: "depth_exceeded",
      detail: `Delegation depth ${depth + 1} exceeds the configured maximum of ${maxDepth}.`,
    });
  }

  if (input.idempotencyKey !== undefined) {
    const existing = yield* store.findByIdempotencyKey(parentThreadId, input.idempotencyKey);
    if (existing?.childThreadId) {
      return {
        delegationId: existing.delegationId,
        state: existing.state,
        role: existing.role,
        providerInstanceId: existing.providerInstanceId,
        model: existing.model,
        childThreadId: existing.childThreadId,
        replayed: true,
      };
    }
  }

  const role = yield* roles.resolve(input.role);

  // Before contending for a lease, retire anything that has plainly stopped.
  // A child that died holding a lease should not block its own replacement.
  yield* sweepStaleDelegations();
  yield* applyPendingSettles();

  if (input.resourceLease !== undefined) {
    const holder = yield* store.findLiveByLease(input.resourceLease);
    if (holder) {
      return yield* new OrchestrationToolkitError({
        reason: "lease_held",
        detail: `Delegation ${holder.delegationId} (${holder.role}, ${holder.state}) already holds ${input.resourceLease}. Wait for it or choose a different resource.`,
      });
    }
  }

  const projectId = yield* store.projectIdOfThread(parentThreadId);
  if (projectId === undefined) {
    return yield* new OrchestrationToolkitError({
      reason: "delegation_not_found",
      detail: "This thread has no project, so a sibling thread cannot be created for it.",
    });
  }

  const delegationUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  const childUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  const delegationId = DelegationIdSchema.make(`dlg_${delegationUuid}`);
  const childThreadId = ThreadId.make(childUuid);
  const spawnCommandId = `delegation:${delegationId}:thread-create`;

  // Durable before dispatch. A crash between these two leaves a `pending` row
  // whose command id can be replayed, not an untracked child.
  yield* store.insertPending({
    delegationId,
    parentThreadId,
    role: role.name,
    providerInstanceId: role.providerInstanceId,
    model: role.model,
    objective: input.objective,
    judgment: input.judgment,
    resourceLease: input.resourceLease,
    idempotencyKey: input.idempotencyKey,
    spawnCommandId,
    deadlineAt:
      role.deadlineMinutes === undefined
        ? undefined
        : DateTime.formatIso(
            DateTime.addDuration(yield* DateTime.now, `${role.deadlineMinutes} minutes`),
          ),
  });

  const modelSelection = {
    instanceId: role.providerInstanceId,
    model: role.model,
    ...(role.options === undefined ? {} : { options: role.options }),
  };
  const worktreePath = input.workdir ?? (yield* store.worktreePathOfThread(parentThreadId));
  const createdAt = yield* isoNow;

  yield* engine
    .dispatch({
      type: "thread.create",
      commandId: CommandId.make(spawnCommandId),
      threadId: childThreadId,
      projectId: ProjectId.make(projectId),
      title: `${role.name}: ${input.objective}`.slice(0, 120),
      modelSelection,
      runtimeMode: role.runtimeMode,
      interactionMode: role.interactionMode,
      branch: null,
      worktreePath: worktreePath ?? null,
      createdAt,
    })
    .pipe(Effect.mapError(dispatchFailed("thread.create")));

  const turn = yield* engine
    .dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`delegation:${delegationId}:turn-start`),
      threadId: childThreadId,
      message: {
        messageId: MessageId.make(`delegation:${delegationId}:brief`),
        role: "user",
        text: openingBrief({
          objective: input.objective,
          judgment: input.judgment,
          nonGoals: input.nonGoals,
          role,
          delegationId,
        }),
        attachments: [],
      },
      modelSelection,
      runtimeMode: role.runtimeMode,
      interactionMode: role.interactionMode,
      createdAt,
    })
    .pipe(Effect.mapError(dispatchFailed("thread.turn.start")));

  yield* store.markRunning(delegationId, childThreadId, turn.sequence);

  yield* appendActivity({
    threadId: parentThreadId,
    tone: "tool",
    kind: "delegation.spawned",
    summary: `Delegated to ${role.name} (${role.providerInstanceId}/${role.model})`,
    payload: { delegationId, childThreadId, role: role.name, objective: input.objective },
  });

  return {
    delegationId,
    state: "running" as const,
    role: role.name,
    providerInstanceId: role.providerInstanceId as string,
    model: role.model,
    childThreadId,
    replayed: false,
  };
});

const agent_handoff = Effect.fn("OrchestrationToolkit.agent_handoff")(function* (
  handoff: DelegationHandoff,
) {
  const actor = yield* OrchestrationActor;
  const store = yield* DelegationStore;

  const delegation = yield* store.findByChildThread(actor.threadId);
  if (!delegation) {
    return yield* new OrchestrationToolkitError({
      reason: "delegation_not_found",
      detail:
        "This thread was not started by agent_spawn, so it has no parent to report to. agent_handoff is only for delegated children.",
    });
  }
  if (delegation.state !== "running") {
    return yield* new OrchestrationToolkitError({
      reason: "delegation_not_live",
      detail: `Delegation ${delegation.delegationId} is ${delegation.state}; a terminal handoff was already recorded.`,
    });
  }

  const unevidenced = handoffRejection(handoff);
  if (unevidenced) return yield* unevidenced;

  const handoffJson = yield* encodeHandoff(handoff).pipe(Effect.mapError(encodingFailed));
  const oversized = briefRejection(handoffJson, "handoff");
  if (oversized) return yield* oversized;

  const state = handoff.status === "completed" ? ("completed" as const) : ("blocked" as const);
  yield* store.markTerminal(delegation.delegationId, state, handoffJson);

  // The parent is told, but not interrupted. It reads this when it next looks.
  yield* store.enqueueMessage({
    messageId: `handoff:${delegation.delegationId}`,
    fromThreadId: actor.threadId,
    fromDelegationId: delegation.delegationId,
    toThreadId: delegation.parentThreadId,
    body: `Delegation ${delegation.delegationId} (${delegation.role}) reported ${state}: ${handoff.summary}`,
  });

  yield* appendActivity({
    threadId: delegation.parentThreadId,
    tone: state === "completed" ? "info" : "error",
    kind: "delegation.handoff",
    summary: `${delegation.role} reported ${state}`,
    payload: { delegationId: delegation.delegationId, handoff },
  });

  return {
    delegationId: delegation.delegationId,
    state,
    parentThreadId: delegation.parentThreadId,
  };
});

const agent_message = Effect.fn("OrchestrationToolkit.agent_message")(function* (input: {
  readonly toDelegationId: DelegationId;
  readonly body: string;
  readonly idempotencyKey: string;
}) {
  const actor = yield* OrchestrationActor;
  const store = yield* DelegationStore;

  const oversized = briefRejection(input.body, "message");
  if (oversized) return yield* oversized;

  const delegation = yield* store.findById(input.toDelegationId);
  if (!delegation) {
    return yield* new OrchestrationToolkitError({
      reason: "delegation_not_found",
      detail: `Delegation ${input.toDelegationId} does not exist.`,
    });
  }

  // Authority comes from the delegation relationship, not from knowing an id.
  // A caller may address the child it started, or the parent that started it.
  const isParent = delegation.parentThreadId === actor.threadId;
  const isChild = delegation.childThreadId === actor.threadId;
  if (!isParent && !isChild) {
    return yield* new OrchestrationToolkitError({
      reason: "message_rejected",
      detail: `Delegation ${input.toDelegationId} is neither yours nor the one that spawned you. This tool only reaches along the delegation graph; an unrelated thread is not addressable.`,
    });
  }

  const target = isParent ? delegation.childThreadId : delegation.parentThreadId;
  if (target === null) {
    return yield* new OrchestrationToolkitError({
      reason: "delegation_not_found",
      detail: `Delegation ${input.toDelegationId} has no thread to receive a message yet.`,
    });
  }

  const senderDelegation = yield* store.findByChildThread(actor.threadId);
  const messageId = `msg:${actor.threadId}:${input.idempotencyKey}`;
  const enqueued = yield* store.enqueueMessage({
    messageId,
    fromThreadId: actor.threadId,
    fromDelegationId: senderDelegation?.delegationId,
    toThreadId: target,
    body: input.body,
  });

  return {
    messageId: OrchestrationMessageId.make(messageId),
    toThreadId: target,
    enqueued,
    // Structural, not incidental: nothing on this path starts a turn.
    wokeRecipient: false,
  };
});

/** Statuses the server refuses to settle. Mirrors the decider's own invariant. */
const LIVE_SESSION_STATUSES: ReadonlySet<string> = new Set(["starting", "running"]);

const dispatchSettle = Effect.fn("OrchestrationToolkit.dispatchSettle")(function* (
  threadId: ThreadId,
) {
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const commandUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  yield* engine.dispatch({
    type: "thread.settle",
    commandId: CommandId.make(`settle:${threadId}:${commandUuid}`),
    threadId,
  });
});

/**
 * Applies settle requests whose thread has since gone idle.
 *
 * Folded into the same opportunistic sweep as staleness, and for the same
 * reason: the natural trigger already exists. A parent reading `agent_inbox` to
 * collect a child's handoff is exactly the moment that child has finished its
 * turn, so the child gets tidied by the act of being read.
 */
const applyPendingSettles = Effect.fn("OrchestrationToolkit.applyPendingSettles")(function* () {
  const store = yield* DelegationStore;
  const pending = yield* store.pendingSettleRequests();
  for (const request of pending) {
    if (request.sessionStatus !== null && LIVE_SESSION_STATUSES.has(request.sessionStatus)) {
      continue;
    }
    // The decider may still refuse (a pending approval, a queued turn start).
    // Leaving the request unapplied is correct: it retries on the next sweep.
    // Confirmed by reading the projection rather than by the dispatch result,
    // for the same reason as `agent_settle_self`.
    yield* dispatchSettle(request.threadId).pipe(Effect.ignore);
    const applied = yield* store.settledOverrideOfThread(request.threadId);
    if (applied === "settled") yield* store.markSettleApplied(request.threadId);
  }
});

const agent_settle_self = Effect.fn("OrchestrationToolkit.agent_settle_self")(function* () {
  const actor = yield* OrchestrationActor;
  const store = yield* DelegationStore;

  // Try now in case this thread is somehow already idle, then fall back to
  // recording the intent. The server rejects a settle on a live session, and a
  // thread is live while its own agent is calling this tool, so the deferred
  // path is the normal one rather than the exception.
  //
  // The dispatch result is not the answer. An accepted receipt means the command
  // was taken, not that the thread is settled, so the projection is read back
  // before reporting success. Claiming `settled` while the override stayed unset
  // is exactly the shape of failure this toolkit exists to remove.
  yield* dispatchSettle(actor.threadId).pipe(Effect.ignore);
  const applied = yield* store.settledOverrideOfThread(actor.threadId);
  if (applied === "settled") {
    return { settled: true, deferredReason: null };
  }

  yield* store.requestSettle(actor.threadId);
  return {
    settled: false,
    deferredReason:
      "This thread is still live while you are calling tools, and the server will not settle a live session. The request is recorded and applied once the thread goes idle. Real activity afterwards un-settles it automatically.",
  };
});

const agent_inbox = Effect.fn("OrchestrationToolkit.agent_inbox")(function* (input: {
  readonly includeDelivered?: boolean | undefined;
}) {
  const actor = yield* OrchestrationActor;
  const store = yield* DelegationStore;

  const messages = yield* store.readInbox(actor.threadId, input.includeDelivered ?? false);
  const undelivered = messages.filter((message) => message.deliveredAt === null);
  yield* store.markDelivered(undelivered.map((message) => message.messageId));

  // Derive staleness before reading, so the answer is never "looks fine because
  // nobody has checked recently".
  const verdicts = yield* sweepStaleDelegations();
  yield* applyPendingSettles();
  const rows = yield* store.listByParent(actor.threadId);
  const delegations = yield* Effect.forEach(rows, (row) =>
    toInboxDelegation(row, verdicts.get(row.delegationId)),
  );

  return {
    messages: messages.map((message) => ({
      messageId: OrchestrationMessageId.make(message.messageId),
      fromThreadId: message.fromThreadId,
      fromDelegationId: message.fromDelegationId,
      body: message.body,
      createdAt: message.createdAt,
    })),
    delegations,
    newMessageCount: undelivered.length,
    staleCount: delegations.filter((delegation) => delegation.staleReason !== null).length,
  };
});

const agent_whoami = Effect.fn("OrchestrationToolkit.agent_whoami")(function* () {
  const actor = yield* OrchestrationActor;
  return { threadId: actor.threadId };
});

const handlers = {
  agent_spawn,
  agent_handoff,
  agent_message,
  agent_inbox,
  agent_settle_self,
  agent_whoami,
} satisfies Parameters<typeof OrchestrationToolkit.toLayer>[0];

export const OrchestrationToolkitHandlersLive = OrchestrationToolkit.toLayer(handlers);

export { agent_spawn, agent_handoff, agent_message, agent_inbox, agent_settle_self, agent_whoami };
