/**
 * AgentCommandRunner - dispatch-side execution of `agent.*` commands.
 *
 * `POST /api/orchestration/dispatch` and the WebSocket `dispatchCommand` method
 * both reach the orchestration toolkit through this service. It exists so
 * Cursor Grok — whose adapter writes no MCP config — and any caller that
 * outlived the in-memory MCP session registry can spawn, hand off, message,
 * read its inbox, and settle exactly as an MCP-capable coordinator does.
 *
 * No second spawn implementation lives here: every command is answered by the
 * same handler functions the MCP tools call, with the actor supplied by the
 * command (`actorThreadId`) instead of an MCP invocation scope.
 *
 * Results are receipted like any other orchestration command: the first
 * dispatch of a commandId runs the handler and records a receipt — handler
 * payload included — and a re-dispatch of the same commandId replays that
 * receipt instead of spawning a second child. Concurrent first dispatches of
 * one commandId are single-flight: the loser joins the winner's execution
 * rather than racing it.
 */
import type { AgentOrchestrationCommand, DispatchResult, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationActor } from "../../mcp/toolkits/orchestration/actor.ts";
import * as Handlers from "../../mcp/toolkits/orchestration/handlers.ts";
import { DelegationStore } from "../../mcp/toolkits/orchestration/DelegationStore.ts";
import { OrchestrationRoles } from "../../mcp/toolkits/orchestration/roles.ts";
import {
  DelegationId,
  HandoffResult,
  InboxResult,
  MessageResult,
  OrchestrationToolkitError,
  SettleSelfResult,
  SpawnResult,
  WhoamiResult,
} from "../../mcp/toolkits/orchestration/schemas.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationEngineService } from "./OrchestrationEngine.ts";
import {
  type OrchestrationSelfIdentityShape,
  SelfNotBoundError,
  unboundSelfIdentity,
} from "./OrchestrationSelfIdentity.ts";

export interface AgentCommandRunnerShape {
  readonly dispatch: (
    command: AgentOrchestrationCommand,
    options?: {
      /**
       * The authenticated session's thread binding, for commands whose actor
       * is the caller rather than something the wire names (`agent.whoami`).
       * Absent — a transport with no session, a test — the runner falls back
       * to an identity that fails closed, so a caller is never told a thread
       * id it did not bring.
       */
      readonly selfIdentity?: OrchestrationSelfIdentityShape;
    },
  ) => Effect.Effect<
    DispatchResult,
    OrchestrationDispatchError | OrchestrationToolkitError | SelfNotBoundError
  >;
}

export class AgentCommandRunner extends Context.Service<
  AgentCommandRunner,
  AgentCommandRunnerShape
>()("t3/orchestration/Services/AgentCommandRunner") {}

const isToolkitError = Schema.is(OrchestrationToolkitError);

// Handler payloads ride on receipts as JSON strings; the codec validates both
// directions instead of trusting raw JSON calls.
const StoredResultJson = Schema.fromJsonString(Schema.Unknown);

type HandlerResult =
  | SpawnResult
  | HandoffResult
  | MessageResult
  | InboxResult
  | SettleSelfResult
  | WhoamiResult;

type DispatchError = OrchestrationDispatchError | OrchestrationToolkitError | SelfNotBoundError;

const makeAgentCommandRunner = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const store = yield* DelegationStore;
  const roles = yield* OrchestrationRoles;
  const crypto = yield* Crypto.Crypto;

  // Handler service requirements flow through the return type here and are
  // satisfied per-call from the services captured at layer construction; only
  // the per-command actor is freshly provided.
  const runHandler = (
    command: AgentOrchestrationCommand,
  ): Effect.Effect<
    HandlerResult,
    OrchestrationToolkitError,
    | OrchestrationActor
    | Crypto.Crypto
    | DelegationStore
    | OrchestrationRoles
    | OrchestrationEngineService
  > => {
    switch (command.type) {
      case "agent.spawn":
        return Handlers.agent_spawn({
          role: command.role,
          objective: command.objective,
          judgment: command.judgment,
          ...(command.nonGoals !== undefined ? { nonGoals: command.nonGoals } : {}),
          ...(command.resourceLease !== undefined ? { resourceLease: command.resourceLease } : {}),
          ...(command.workdir !== undefined ? { workdir: command.workdir } : {}),
          ...(command.idempotencyKey !== undefined
            ? { idempotencyKey: command.idempotencyKey }
            : {}),
        });
      case "agent.handoff":
        return Handlers.agent_handoff(command.handoff);
      case "agent.message":
        return Handlers.agent_message({
          toDelegationId: DelegationId.make(command.toDelegationId),
          body: command.body,
          idempotencyKey: command.idempotencyKey,
        });
      case "agent.inbox":
        return Handlers.agent_inbox(
          command.includeDelivered !== undefined
            ? { includeDelivered: command.includeDelivered }
            : {},
        );
      case "agent.settle-self":
        return Handlers.agent_settle_self();
      case "agent.whoami":
        return Handlers.agent_whoami();
    }
  };

  const dispatchOnce = (
    command: AgentOrchestrationCommand,
    options?: { readonly selfIdentity?: OrchestrationSelfIdentityShape },
  ): Effect.Effect<DispatchResult, DispatchError> =>
    Effect.gen(function* () {
      const existingReceipt = yield* receipts.getByCommandId({ commandId: command.commandId });
      if (existingReceipt._tag === "Some") {
        const receipt = existingReceipt.value;
        if (receipt.status === "accepted") {
          // The receipt carries the handler payload the first execution
          // produced, so a retried dispatch answers with the same body the
          // original response had. Rows written before payloads were recorded
          // replay as sequence-only, which stays a complete answer for every
          // command whose effect is readable from the store.
          // An unparseable stored payload degrades to sequence-only rather
          // than failing a dispatch that was already accepted once.
          const result =
            receipt.resultJson != null
              ? yield* Schema.decodeEffect(StoredResultJson)(receipt.resultJson).pipe(
                  Effect.catch(() => Effect.succeed(undefined)),
                )
              : undefined;
          // agent.whoami's answer is the caller's own session binding, so its
          // `self` is recomputed per request rather than trusted from the
          // receipt — including failing closed for a replay from a caller the
          // server cannot bind.
          if (command.type === "agent.whoami") {
            const self = yield* (options?.selfIdentity ?? unboundSelfIdentity).selfThreadId;
            return { sequence: receipt.resultSequence, self };
          }
          return result !== undefined
            ? { sequence: receipt.resultSequence, result }
            : { sequence: receipt.resultSequence };
        }
        return yield* new OrchestrationToolkitError({
          reason: "dispatch_failed",
          detail: receipt.error ?? "Previously rejected.",
        });
      }

      // `agent.whoami` carries no actor on the wire on purpose: its answer
      // comes from the authenticated session's thread binding, supplied per
      // request by the HTTP handler. Without one the identity fails closed.
      const actor =
        "actorThreadId" in command
          ? { threadId: command.actorThreadId }
          : yield* Effect.map(
              (options?.selfIdentity ?? unboundSelfIdentity).selfThreadId,
              (threadId) => ({ threadId }),
            );

      const result = yield* runHandler(command).pipe(
        Effect.provideService(OrchestrationActor, actor),
        Effect.provideService(DelegationStore, store),
        Effect.provideService(OrchestrationRoles, roles),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(OrchestrationEngineService, engine),
        Effect.catch((cause) =>
          isToolkitError(cause)
            ? Effect.fail(cause)
            : Effect.fail(
                new OrchestrationToolkitError({
                  reason: "dispatch_failed",
                  detail: `${command.type} failed: ${String(cause)}`,
                }),
              ),
        ),
      );

      // Only whoami returns a thread on the result; its handler's whole answer
      // is that thread.
      const resultThreadId =
        "threadId" in result ? (result.threadId as ThreadId | undefined) : undefined;

      const sequence = yield* engine.latestSequence;
      // A non-serializable handler result stores no payload; the receipt's
      // dedup job does not depend on it.
      const resultJson = yield* Schema.encodeEffect(StoredResultJson)(result).pipe(
        Effect.catch(() => Effect.succeed(null as string | null)),
      );
      yield* receipts
        .upsert({
          commandId: command.commandId,
          aggregateKind: "thread",
          aggregateId:
            "actorThreadId" in command
              ? command.actorThreadId
              : (resultThreadId ?? ("agent-whoami" as ThreadId)),
          acceptedAt: DateTime.formatIso(yield* DateTime.now),
          resultSequence: sequence,
          status: "accepted",
          error: null,
          resultJson,
        })
        .pipe(Effect.catch(() => Effect.void));

      if (command.type === "agent.whoami") {
        return { sequence, self: resultThreadId };
      }
      return { sequence, result };
    });

  // The engine serializes commands through its single-worker queue; agent.*
  // commands bypass that queue, so the runner keeps its own per-commandId
  // single-flight: the first dispatch runs check-execute-record in a forked
  // fiber and any concurrent duplicate joins that fiber, sharing its outcome
  // (including its failure) instead of re-running the handler. Together with
  // the per-state-dir server lock this makes the commandId the deduplication
  // boundary the dispatch contract documents.
  const inFlight = new Map<string, Fiber.Fiber<DispatchResult, DispatchError>>();

  const dispatch: AgentCommandRunnerShape["dispatch"] = (command, options) =>
    Effect.suspend(() => {
      const running = inFlight.get(command.commandId);
      if (running !== undefined) {
        return Fiber.join(running);
      }
      return dispatchOnce(command, options).pipe(
        Effect.forkChild,
        Effect.flatMap((fiber) => {
          inFlight.set(command.commandId, fiber);
          return Fiber.join(fiber).pipe(
            Effect.ensuring(Effect.sync(() => inFlight.delete(command.commandId))),
          );
        }),
      );
    });

  return AgentCommandRunner.of({ dispatch });
});

/**
 * The handlers' own service requirements (roles config, delegation store,
 * engine, crypto) stay in the requirement channel and are satisfied by every
 * composition site that already builds those layers.
 */
export const AgentCommandRunnerLive = Layer.effect(AgentCommandRunner, makeAgentCommandRunner);
