import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DelegationStore } from "./DelegationStore.ts";
import { OrchestrationRoles } from "./roles.ts";
import {
  HandoffInput,
  HandoffResult,
  InboxInput,
  InboxResult,
  MessageInput,
  MessageResult,
  OrchestrationToolkitError,
  SpawnInput,
  SpawnResult,
} from "./schemas.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  DelegationStore,
  OrchestrationRoles,
  OrchestrationEngineService,
  Crypto.Crypto,
];

export const AgentSpawnTool = Tool.make("agent_spawn", {
  description:
    "Delegate bounded work to a child agent on any configured provider. You name a role, not a vendor: this environment's roles config decides which provider instance and model serve it. Returns immediately with a delegationId; the child runs on its own and reports back through agent_handoff, which you read with agent_inbox. Requires a judgment field naming the decision the child must make — if the work has no judgment in it, write a script instead of spawning a model.",
  parameters: SpawnInput,
  success: SpawnResult,
  failure: OrchestrationToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Delegate to a child agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const AgentHandoffTool = Tool.make("agent_handoff", {
  description:
    "Report your terminal result to the parent that delegated to you. Call this exactly once, as your final action, and only if you were spawned by agent_spawn. Pass the six fields at the top level of the arguments object — status, summary, artifacts, validation, remainingRisks, nextStep — not wrapped in any outer key. A completed status must list the validation you actually ran; if you ran none, the honest status is blocked. Submit a brief that cites durable paths, never a transcript.",
  parameters: HandoffInput,
  success: HandoffResult,
  failure: OrchestrationToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Report delegated result")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AgentMessageTool = Tool.make("agent_message", {
  description:
    "Leave a durable message along the delegation graph: the parent that spawned you, or a child you spawned, named by delegationId. You cannot address an unrelated thread. This never interrupts the recipient: it does not start a turn, steer a running one, or wake anything. The message waits until the recipient reads its inbox. Requires an idempotencyKey so a retry does not enqueue a second copy.",
  parameters: MessageInput,
  success: MessageResult,
  failure: OrchestrationToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Message another thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AgentInboxTool = Tool.make("agent_inbox", {
  description:
    "Read messages addressed to this thread and the current state of every delegation you started, including any handoffs your children have submitted and any that have stopped making progress (staleReason). Reading marks messages delivered. This is how you learn a delegated result; nothing pushes it to you.",
  parameters: InboxInput,
  success: InboxResult,
  failure: OrchestrationToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Read inbox and delegations")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const OrchestrationToolkit = Toolkit.make(
  AgentSpawnTool,
  AgentHandoffTool,
  AgentMessageTool,
  AgentInboxTool,
);
