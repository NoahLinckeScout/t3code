import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as DelegationStoreLayer from "./DelegationStore.ts";
import { DelegationStore } from "./DelegationStore.ts";
import { OrchestrationToolkitHandlersLive } from "./handlers.ts";
import { OrchestrationRoles } from "./roles.ts";
import {
  type DelegationHandoff,
  DelegationId,
  HandoffResult,
  OrchestrationToolkitError,
} from "./schemas.ts";
import { OrchestrationToolkit } from "./tools.ts";

const isToolkitError = Schema.is(OrchestrationToolkitError);
const decodeHandoffResult = Schema.decodeUnknownSync(HandoffResult);

/** Narrows a tool failure, so a wrapper error fails the test instead of passing silently. */
const toolkitFailure = (failure: unknown): OrchestrationToolkitError => {
  assert.isTrue(isToolkitError(failure), `expected a toolkit error, got: ${String(failure)}`);
  return failure as OrchestrationToolkitError;
};

const parentThreadId = ThreadId.make("thread-handler-parent");
const orphanThreadId = ThreadId.make("thread-handler-orphan");

const invocationFor = (threadId: ThreadId) => ({
  environmentId: EnvironmentId.make("environment-handler-test"),
  threadId,
  providerSessionId: "provider-session-handler-test",
  providerInstanceId: ProviderInstanceId.make("opencode"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
});

const engineMock = Layer.mock(OrchestrationEngineService)({
  dispatch: () => Effect.succeed({ sequence: 1 }),
});

const rolesMock = Layer.mock(OrchestrationRoles)({
  configPath: "/tmp/orchestration-roles.json",
  maxDepth: Effect.succeed(2),
  canSpawnFrom: () => Effect.succeed(true),
});

const handoff = (overrides: Partial<DelegationHandoff> = {}): DelegationHandoff => ({
  status: "completed",
  summary: "Rebuilt the projection and confirmed the counts line up.",
  artifacts: ["apps/server/src/persistence/Layers/ProjectionThreads.ts"],
  validation: ["vp test run ProjectionThreads — 8 passed"],
  remainingRisks: [],
  nextStep: "Review and merge.",
  ...overrides,
});

/**
 * Builds the real handlers layer over a real store. Every service the handlers
 * declare has to resolve here, so this is what proves the registration wiring
 * works rather than merely typechecking.
 */
const layer = it.layer(
  OrchestrationToolkitHandlersLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DelegationStoreLayer.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
        engineMock,
        rolesMock,
        NodeServices.layer,
      ),
    ),
  ),
);

const callHandoff = (threadId: ThreadId, value: DelegationHandoff) =>
  Effect.gen(function* () {
    const built = yield* OrchestrationToolkit;
    return yield* built
      .handle("agent_handoff", { handoff: value })
      .pipe(
        Stream.unwrap,
        Stream.run(Sink.last()),
        Effect.flatMap(Effect.fromOption),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocationFor(threadId)),
      );
  });

const startDelegation = (scope: string, childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* DelegationStore;
    const delegationId = DelegationId.make(`dlg-${scope}`);
    yield* store.insertPending({
      delegationId,
      parentThreadId,
      role: "implementer",
      providerInstanceId: "opencode",
      model: "self-hosted-glm",
      objective: "Rebuild the projection",
      judgment: "Whether a rebuild or a targeted patch is correct",
      resourceLease: undefined,
      idempotencyKey: undefined,
      spawnCommandId: `delegation:${delegationId}:thread-create`,
    });
    yield* store.markRunning(delegationId, childThreadId, 1);
    return delegationId;
  });

layer("orchestration handlers", (it) => {
  it.effect("refuses a handoff from a thread that was never delegated to", () =>
    Effect.gen(function* () {
      const failure = yield* callHandoff(orphanThreadId, handoff()).pipe(Effect.flip);
      assert.strictEqual(toolkitFailure(failure).reason, "delegation_not_found");
    }),
  );

  it.effect("rejects a completed handoff that cites no validation", () =>
    Effect.gen(function* () {
      const store = yield* DelegationStore;
      const child = ThreadId.make("thread-handler-unevidenced");
      const delegationId = yield* startDelegation("unevidenced", child);

      const failure = yield* callHandoff(child, handoff({ validation: [] })).pipe(Effect.flip);
      assert.strictEqual(toolkitFailure(failure).reason, "handoff_rejected");

      // A rejected report never reads as finished; the delegation stays live.
      assert.strictEqual((yield* store.findById(delegationId))?.state, "running");
    }),
  );

  it.effect("records an evidenced handoff and leaves the parent a message", () =>
    Effect.gen(function* () {
      const store = yield* DelegationStore;
      const child = ThreadId.make("thread-handler-completed");
      const delegationId = yield* startDelegation("completed", child);

      const result = decodeHandoffResult((yield* callHandoff(child, handoff())).encodedResult);
      assert.strictEqual(result.state, "completed");
      assert.strictEqual((yield* store.findById(delegationId))?.state, "completed");

      // Delivered by inbox, not by waking: the parent is told, never interrupted.
      const inbox = yield* store.readInbox(parentThreadId, false);
      assert.strictEqual(inbox.length, 1);
      assert.match(inbox[0]?.body ?? "", /reported completed/);
    }),
  );

  it.effect("refuses a second terminal handoff for one delegation", () =>
    Effect.gen(function* () {
      const child = ThreadId.make("thread-handler-twice");
      yield* startDelegation("twice", child);

      yield* callHandoff(child, handoff());
      const failure = yield* callHandoff(child, handoff({ status: "blocked" })).pipe(Effect.flip);
      assert.strictEqual(toolkitFailure(failure).reason, "delegation_not_live");
    }),
  );

  it.effect("accepts a blocked handoff with no validation", () =>
    Effect.gen(function* () {
      const store = yield* DelegationStore;
      const child = ThreadId.make("thread-handler-blocked");
      const delegationId = yield* startDelegation("blocked", child);

      const result = decodeHandoffResult(
        (yield* callHandoff(
          child,
          handoff({ status: "blocked", validation: [], nextStep: "Decide whether to rebuild." }),
        )).encodedResult,
      );
      assert.strictEqual(result.state, "blocked");
      assert.strictEqual((yield* store.findById(delegationId))?.state, "blocked");
    }),
  );
});
