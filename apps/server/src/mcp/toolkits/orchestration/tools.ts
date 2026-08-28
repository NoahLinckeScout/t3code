import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationActor } from "./actor.ts";
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
  SettleSelfInput,
  SettleSelfResult,
  SpawnInput,
  SpawnResult,
  WhoamiInput,
  WhoamiResult,
} from "./schemas.ts";

const dependencies = [
  OrchestrationActor,
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

export const AgentSettleSelfTool = Tool.make("agent_settle_self", {
  description:
    "Put THIS thread away when your work here is finished — it stops demanding attention in the thread list. Call it as your last action. Takes no arguments and always targets your own thread; you cannot settle another one. Settling normally takes effect once your turn ends, because a thread is still live while you are calling tools, so a false `settled` with a `deferredReason` is the ordinary success case and not a failure. Anything real happening on the thread afterwards un-settles it automatically.",
  parameters: SettleSelfInput,
  success: SettleSelfResult,
  failure: OrchestrationToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Settle this thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AgentWhoamiTool = Tool.make("agent_whoami", {
  description:
    "Return this thread's id. Call it before addressing anything by threadId: the id is issued by the server, never guessed. Takes no arguments.",
  parameters: WhoamiInput,
  success: WhoamiResult,
  failure: OrchestrationToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Identify this thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const OrchestrationToolkit = Toolkit.make(
  AgentSpawnTool,
  AgentHandoffTool,
  AgentMessageTool,
  AgentInboxTool,
  AgentSettleSelfTool,
  AgentWhoamiTool,
);
