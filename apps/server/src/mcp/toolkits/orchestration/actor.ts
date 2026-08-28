/**
 * The thread acting on the orchestration toolkit.
 *
 * Handlers used to read the caller from `McpInvocationContext`, which tied the
 * whole toolkit to the per-thread MCP endpoint. Lifting the actor into its own
 * service lets the same handler functions run for dispatch callers: the MCP
 * middleware provides the actor from its session scope, and the dispatch layer
 * provides it from the command's `actorThreadId`.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

export class OrchestrationActor extends Context.Service<
  OrchestrationActor,
  { readonly threadId: ThreadId }
>()("t3/mcp/toolkits/orchestration/actor/OrchestrationActor") {}
