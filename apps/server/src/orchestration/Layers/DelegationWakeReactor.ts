/**
 * DelegationWakeReactor - the deterministic waker for delegated children.
 *
 * A parent that spawns a child over `agent.spawn` gets nothing pushed to it:
 * historically it had to poll `agent_inbox`, and an MCP-less coordinator
 * polling on its own clock is exactly the latency this reactor removes. When a
 * child thread's turn reaches a terminal state (completed/error), the waker
 * dispatches one `thread.turn.start` on the parent with a short pointer to the
 * inbox and the delegation id.
 *
 * Same shape as a stream watchdog, and bounded by the same discipline:
 *
 * - No model runs inside it. The wake decision is a ledger/projection check —
 *   is this thread a live delegation child, and has this terminal turn already
 *   been woken over?
 * - One wake per child terminal turn. The wake command id is derived from the
 *   delegation and the terminal turn id, so the engine's command receipts make
 *   a duplicate wake a replay rather than a second turn.
 * - Never interrupts. `thread.turn.start` queues behind an in-flight turn.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { DelegationStore } from "../../mcp/toolkits/orchestration/DelegationStore.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

export interface DelegationWakeReactorShape {
  readonly start: () => Effect.Effect<void, never, import("effect/Scope").Scope>;
  /** Resolves when the internal queue is empty and idle; replaces sleeps in tests. */
  readonly drain: Effect.Effect<void>;
}

export class DelegationWakeReactor extends Context.Service<
  DelegationWakeReactor,
  DelegationWakeReactorShape
>()("t3/orchestration/Layers/DelegationWakeReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const store = yield* DelegationStore;

  const wakeParent = Effect.fn("DelegationWakeReactor.wakeParent")(function* (input: {
    readonly delegationId: string;
    readonly parentThreadId: ThreadId;
    readonly childThreadId: ThreadId;
    readonly role: string;
    readonly state: string;
    readonly turnId: string | null;
  }) {
    const turnKey = input.turnId ?? "unknown-turn";
    const now = DateTime.formatIso(yield* DateTime.now);
    // The derived command id IS the idempotency: one wake per child terminal
    // turn, enforced by the engine's command receipts rather than by this
    // reactor's memory.
    const wakeCommand: OrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make(
        `delegation-wake:${input.delegationId}:${input.childThreadId}:${turnKey}`,
      ),
      threadId: input.parentThreadId,
      message: {
        messageId: MessageId.make(`delegation-wake:${input.delegationId}:${turnKey}`),
        role: "user",
        text: `child reached ${input.state}; read inbox / delegationId=${input.delegationId} (role ${input.role}, turn ${turnKey}).`,
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: now,
    };
    yield* engine.dispatch(wakeCommand);
  });

  const processDomainEvent = Effect.fn("DelegationWakeReactor.processDomainEvent")(function* (
    event: OrchestrationEvent,
  ) {
    if (event.type !== "thread.session-set") {
      return;
    }
    // Leaving the "running" session status is the authoritative turn-end
    // signal (the same one ProjectionPipeline settles turns on). ready/idle
    // project to a completed turn; error projects to an errored one; starting/
    // running/interrupted/stopped are not the settled completion this waker
    // exists for.
    const settledTurnState = settledTurnStateForSessionStatus(event.payload.session.status);
    if (settledTurnState !== "completed" && settledTurnState !== "error") {
      return;
    }

    const childThreadId = event.payload.threadId;
    const delegation = yield* store.findLiveByChildThread(childThreadId);
    if (!delegation || delegation.parentThreadId === null) {
      // An unrelated thread going terminal wakes nobody.
      return;
    }

    const turnId = yield* store.latestTerminalTurnIdOfThread(childThreadId);
    yield* wakeParent({
      delegationId: delegation.delegationId,
      parentThreadId: delegation.parentThreadId,
      childThreadId,
      role: delegation.role,
      state: settledTurnState,
      turnId,
    });
  });

  const processDomainEventSafely = (event: OrchestrationEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("delegation wake reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: DelegationWakeReactorShape["start"] = Effect.fn("DelegationWakeReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          if (event.type !== "thread.session-set") {
            return Effect.void;
          }
          return worker.enqueue(event);
        }),
      );
    },
  );

  return DelegationWakeReactor.of({ start, drain: worker.drain });
});

/**
 * Mirrors ProjectionPipeline's turn-settling rule: which session statuses end a
 * turn, and what the settled turn state becomes.
 */
function settledTurnStateForSessionStatus(
  status: string,
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
    default:
      return null;
  }
}

export const DelegationWakeReactorLive = Layer.effect(DelegationWakeReactor, make);
