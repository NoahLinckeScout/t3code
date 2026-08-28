/**
 * ClientOrchestrationCommandDispatch - the one dispatch entry for client-sent
 * orchestration commands.
 *
 * Both `POST /api/orchestration/dispatch` and the WebSocket
 * `orchestration.dispatchCommand` method route through here. Regular commands
 * (thread.*, project.*) go to the engine queue exactly as before. `agent.*`
 * commands are intercepted and answered by the AgentCommandRunner, which calls
 * the same handler functions the MCP tools use — they must never reach the
 * decider, which would fail them as unknown command types.
 */
import {
  isAgentCommandType,
  type AgentOrchestrationCommand,
  type DispatchResult,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { OrchestrationDispatchError } from "../Errors.ts";
import { AgentCommandRunner, AgentCommandRunnerLive } from "./AgentCommandRunner.ts";
import { OrchestrationEngineService } from "./OrchestrationEngine.ts";
import type {
  OrchestrationSelfIdentityShape,
  SelfNotBoundError,
} from "./OrchestrationSelfIdentity.ts";
import type { OrchestrationToolkitError } from "../../mcp/toolkits/orchestration/schemas.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { DelegationStore } from "../../mcp/toolkits/orchestration/DelegationStore.ts";
import { OrchestrationRoles } from "../../mcp/toolkits/orchestration/roles.ts";

/**
 * The handler services the agent runner's requirements channel carries. Every
 * composition site that builds this layer already builds these.
 */
export type AgentCommandDispatchRequirements =
  | Crypto.Crypto
  | DelegationStore
  | OrchestrationRoles
  | OrchestrationEngineService
  | OrchestrationCommandReceiptRepository;

export interface ClientOrchestrationCommandDispatchShape {
  /**
   * Takes a command already normalized by `normalizeDispatchCommand`.
   *
   * `origin` is stamped onto engine events for analytics and only exists on
   * transports that know the calling client (WebSocket). `selfIdentity` is the
   * authenticated session's thread binding, supplied per request by the HTTP
   * handler; transports without one fall back to the runner's fails-closed
   * identity, so `agent.whoami` never guesses a thread.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
    options?: {
      readonly origin?: OrchestrationClientOrigin;
      readonly selfIdentity?: OrchestrationSelfIdentityShape;
    },
  ) => Effect.Effect<
    DispatchResult,
    OrchestrationDispatchError | OrchestrationToolkitError | SelfNotBoundError,
    never
  >;
}

export class ClientOrchestrationCommandDispatch extends Context.Service<
  ClientOrchestrationCommandDispatch,
  ClientOrchestrationCommandDispatchShape
>()("t3/orchestration/Services/ClientOrchestrationCommandDispatch") {}

export const isAgentOrchestrationCommand = (
  command: OrchestrationCommand,
): command is OrchestrationCommand & AgentOrchestrationCommand => isAgentCommandType(command.type);

const makeClientOrchestrationCommandDispatch = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const agentRunner = yield* AgentCommandRunner;

  const dispatch = Effect.fn("ClientOrchestrationCommandDispatch.dispatch")(function* (
    command: OrchestrationCommand,
    options?: {
      readonly origin?: OrchestrationClientOrigin;
      readonly selfIdentity?: OrchestrationSelfIdentityShape;
    },
  ) {
    if (isAgentOrchestrationCommand(command)) {
      // Agent commands produce no engine events, so there is no origin to
      // stamp; the session binding is all they carry.
      return yield* agentRunner.dispatch(
        command,
        options?.selfIdentity !== undefined ? { selfIdentity: options.selfIdentity } : undefined,
      );
    }
    return yield* engine.dispatch(
      command,
      options?.origin !== undefined ? { origin: options.origin } : undefined,
    );
  });

  return ClientOrchestrationCommandDispatch.of({ dispatch });
});

/**
 * Requirement-open on purpose: the handlers' own services (roles, delegation
 * store, crypto) and the engine are satisfied by every composition site that
 * already builds those layers. Self-identity is passed per request by the
 * HTTP handler; see {@link ClientOrchestrationCommandDispatchShape.dispatch}.
 */
export const ClientOrchestrationCommandDispatchLive = Layer.effect(
  ClientOrchestrationCommandDispatch,
  makeClientOrchestrationCommandDispatch,
).pipe(Layer.provide(AgentCommandRunnerLive));
