/**
 * End-to-end tests for `agent.*` commands over the dispatch path.
 *
 * These exist because the toolkit previously had no test covering `agent_spawn`
 * at all, and because the MCP path is not the surface that needed to work:
 * Cursor Grok has no MCP config, so the toolkit must be reachable through
 * `POST /api/orchestration/dispatch`. The tests therefore drive
 * `ClientOrchestrationCommandDispatch.dispatch` — the same function the HTTP
 * handler calls (apps/server/src/orchestration/http.ts, "dispatch" endpoint) —
 * over a real OrchestrationEngine with sqlite persistence, never a mocked
 * engine.dispatch.
 */
// @effect-diagnostics nodeBuiltinImport:off
import {
  AgentDelegationHandoff,
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  DelegationWakeReactor,
  DelegationWakeReactorLive,
} from "./Layers/DelegationWakeReactor.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { AgentCommandRunner, AgentCommandRunnerLive } from "./Services/AgentCommandRunner.ts";
import {
  ClientOrchestrationCommandDispatch,
  ClientOrchestrationCommandDispatchLive,
} from "./Services/ClientOrchestrationCommandDispatch.ts";
import {
  SelfNotBoundError,
  selfIdentityFromSessionSubject,
} from "./Services/OrchestrationSelfIdentity.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";
import { DelegationStore } from "../mcp/toolkits/orchestration/DelegationStore.ts";
import * as DelegationStoreLayer from "../mcp/toolkits/orchestration/DelegationStore.ts";
import * as OrchestrationRolesModule from "../mcp/toolkits/orchestration/roles.ts";
import { DelegationId, OrchestrationToolkitError } from "../mcp/toolkits/orchestration/schemas.ts";

const isToolkitError = Schema.is(OrchestrationToolkitError);
const isSelfNotBound = Schema.is(SelfNotBoundError);
const decodeOrchestrationCommand = Schema.decodeUnknownSync(OrchestrationCommand);
const ModelSelectionFromJson = Schema.fromJsonString(
  Schema.Struct({ instanceId: Schema.String, model: Schema.String }),
);
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelectionFromJson);

const asProjectId = (value: string): ProjectId => ProjectId.make(value);

const PARENT_THREAD = ThreadId.make("thread-dispatch-parent");
const UNRELATED_THREAD = ThreadId.make("thread-dispatch-unrelated");
const PROJECT = asProjectId("project-dispatch");

// Fixture roles: `research` routes to the self-hosted opencode instance, and a
// caller can never override that with a modelSelection on the wire. The roles
// service re-reads this file on every dispatch, so tests may write it after the
// layer has built.
const ROLES_CONFIG_JSON = `{
  "maxDepth": 2,
  "roles": {
    "research": {
      "providerInstanceId": "opencode",
      "model": "self-hosted-glm/glm-5.3-flash",
      "options": [{ "id": "agent", "value": "build" }],
      "runtimeMode": "full-access",
      "canSpawn": false
    }
  }
}`;

const writeRolesFixture = Effect.fn("dispatchTest.writeRolesFixture")(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(`${config.stateDir}/orchestration-roles.json`, ROLES_CONFIG_JSON);
});

const seedParentThread = (scope: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "project.create",
      commandId: dispatchCommandId(`project-create:${scope}`),
      projectId: PROJECT,
      title: "Dispatch Project",
      workspaceRoot: `/tmp/agent-dispatch-${scope}`,
      defaultModelSelection: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: dispatchCommandId(`parent-thread-create:${scope}`),
      threadId: PARENT_THREAD,
      projectId: PROJECT,
      title: "Parent",
      modelSelection: {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "self-hosted-glm/glm-5.3-flash",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

// Same composition shape as runtimeLayer.ts: requirement-open inner layers,
// resolved once by the outermost provides. The MemoMap dedupes the shared
// engineLayer reference, so one engine and one sqlite client are built, and
// `Effect.provide` per test gives every test a fresh store.
const engineLayer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
);

const dispatchSystemLayer = Layer.mergeAll(
  engineLayer,
  OrchestrationProjectionSnapshotQueryLive,
  DelegationStoreLayer.layer,
  OrchestrationRolesModule.layer,
  // The runner's handler services are the same file-backed layers the merge
  // above exposes; providing them here keeps one MemoMap-built store shared
  // with the `DelegationStore` handle the assertions read.
  AgentCommandRunnerLive.pipe(
    Layer.provide(engineLayer),
    Layer.provide(DelegationStoreLayer.layer),
    Layer.provide(OrchestrationRolesModule.layer),
  ),
  ClientOrchestrationCommandDispatchLive.pipe(
    Layer.provide(engineLayer),
    Layer.provide(DelegationStoreLayer.layer),
    Layer.provide(OrchestrationRolesModule.layer),
  ),
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-dispatch-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const wakeSystemLayer = Layer.mergeAll(
  engineLayer,
  OrchestrationProjectionSnapshotQueryLive,
  DelegationStoreLayer.layer,
  DelegationWakeReactorLive.pipe(
    Layer.provide(engineLayer),
    Layer.provide(DelegationStoreLayer.layer),
  ),
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-delegation-wake-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

let uniqueCounter = 0;

const dispatchCommandId = (tag: string) => CommandId.make(`test-agent-dispatch:${tag}`);

const spawnCommand = (overrides?: {
  readonly role?: string;
  readonly resourceLease?: string;
  readonly objective?: string;
}) => ({
  type: "agent.spawn" as const,
  commandId: dispatchCommandId(
    `spawn:${overrides?.objective ?? "objective"}:${(uniqueCounter += 1)}`,
  ),
  actorThreadId: PARENT_THREAD,
  role: overrides?.role ?? "research",
  objective: overrides?.objective ?? "Rebuild the projection indexes",
  judgment: "Whether a rebuild or a targeted patch is correct",
  ...(overrides?.resourceLease !== undefined ? { resourceLease: overrides.resourceLease } : {}),
});

const handoffCommand = (
  childThreadId: ThreadId,
  status: "completed" | "blocked" = "completed",
) => ({
  type: "agent.handoff" as const,
  commandId: dispatchCommandId(`handoff:${childThreadId}`),
  actorThreadId: childThreadId,
  handoff: {
    status,
    summary: "Rebuilt the projection and confirmed the counts line up.",
    artifacts: ["apps/server/src/persistence/Layers/ProjectionThreads.ts"],
    validation: status === "completed" ? ["vp test run ProjectionThreads — 8 passed"] : [],
    remainingRisks: [],
    nextStep: "Review and merge.",
  } satisfies AgentDelegationHandoff,
});

const whoamiCommand = () => ({
  type: "agent.whoami" as const,
  commandId: dispatchCommandId(`whoami:${(uniqueCounter += 1)}`),
});

interface DispatchRow {
  readonly threadId: string;
  readonly title: string;
  readonly modelSelectionJson: string;
}

describe("agent.* dispatch commands (real engine + sqlite)", () => {
  it("ignores a caller-supplied modelSelection on agent.spawn in favour of the role", () => {
    // The wire struct is closed: whatever else a caller posts, the decoded
    // command carries no model field, so the role is the only routing input.
    const decoded = decodeOrchestrationCommand({
      type: "agent.spawn",
      commandId: "cmd-x",
      actorThreadId: "thread-x",
      role: "research",
      objective: "o",
      judgment: "j",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    });
    assert.strictEqual("modelSelection" in decoded, false);
  });

  it.effect(
    "dispatches agent.spawn through the real engine: projection row, delegation row, role-resolved model",
    () =>
      Effect.gen(function* () {
        yield* writeRolesFixture();
        yield* seedParentThread("spawn");

        const dispatchService = yield* ClientOrchestrationCommandDispatch;
        const result = yield* dispatchService.dispatch(spawnCommand());

        // The dispatch was accepted and sequenced.
        assert.isAtLeast(result.sequence, 1);

        const sql = yield* SqlClient.SqlClient;

        // A delegation row exists for the parent, pointing at a live child.
        const delegationRows = yield* sql<{
          readonly delegationId: string;
          readonly childThreadId: string | null;
          readonly role: string;
          readonly model: string;
          readonly providerInstanceId: string;
          readonly state: string;
        }>`
          SELECT delegation_id AS "delegationId", child_thread_id AS "childThreadId", role, model, provider_instance_id AS "providerInstanceId", state
          FROM orchestration_delegations
          WHERE parent_thread_id = ${PARENT_THREAD}
        `;
        assert.strictEqual(delegationRows.length, 1);
        const delegation = delegationRows[0]!;
        assert.strictEqual(delegation.role, "research");
        assert.strictEqual(delegation.state, "running");
        assert.isNotNull(delegation.childThreadId);

        const childRows = yield* sql<DispatchRow>`
          SELECT thread_id AS "threadId", title, model_selection_json AS "modelSelectionJson"
          FROM projection_threads
          WHERE thread_id = ${delegation.childThreadId!}
        `;
        assert.strictEqual(childRows.length, 1);
        const child = childRows[0]!;

        // The child's modelSelection comes from the role, not from any
        // caller-supplied blob.
        const childModelSelection = yield* decodeModelSelection(child.modelSelectionJson);
        assert.strictEqual(childModelSelection.instanceId, "opencode");
        assert.strictEqual(childModelSelection.model, "self-hosted-glm/glm-5.3-flash");
      }).pipe(Effect.provide(dispatchSystemLayer)),
  );

  it.effect(
    "refuses a second agent.spawn on a held resourceLease, including two concurrent dispatches",
    () =>
      Effect.gen(function* () {
        yield* writeRolesFixture();
        yield* seedParentThread("lease");

        const dispatchService = yield* ClientOrchestrationCommandDispatch;

        const lease = "git:owner/repo#dispatch-lease";
        yield* dispatchService.dispatch(spawnCommand({ resourceLease: lease, objective: "first" }));

        const refused = yield* dispatchService
          .dispatch(spawnCommand({ resourceLease: lease, objective: "second" }))
          .pipe(Effect.flip);
        if (!isToolkitError(refused)) {
          return assert.fail(`expected a toolkit error, got ${String(refused)}`);
        }
        assert.strictEqual(refused.reason, "lease_held");

        // Two concurrent dispatches race for the same lease: exactly one wins,
        // the loser fails closed with lease_held (the partial unique index is
        // the guard, not a read-then-write check).
        const outcomes = yield* Effect.forEach(
          [1, 2],
          (index) =>
            dispatchService
              .dispatch(
                spawnCommand({
                  resourceLease: "git:owner/repo#dispatch-lease-2",
                  objective: `race-${index}`,
                }),
              )
              .pipe(Effect.result),
          { concurrency: 2 },
        );
        const outcomesByTag = outcomes.map((outcome) =>
          outcome._tag === "Success" ? "accepted" : "refused",
        );
        assert.deepStrictEqual(outcomesByTag.sort(), ["accepted", "refused"]);
        for (const outcome of outcomes) {
          if (outcome._tag !== "Failure") {
            continue;
          }
          if (!isToolkitError(outcome.failure)) {
            return assert.fail(`expected a toolkit error, got ${String(outcome.failure)}`);
          }
          assert.strictEqual(outcome.failure.reason, "lease_held");
        }
      }).pipe(Effect.provide(dispatchSystemLayer)),
  );

  it.effect("reads the child delegation back through agent.inbox on the parent", () =>
    Effect.gen(function* () {
      yield* writeRolesFixture();
      yield* seedParentThread("inbox");

      const dispatchService = yield* ClientOrchestrationCommandDispatch;
      yield* dispatchService.dispatch(spawnCommand({ objective: "inbox-visible" }));

      const inboxResult = yield* dispatchService.dispatch({
        type: "agent.inbox" as const,
        commandId: dispatchCommandId("inbox"),
        actorThreadId: PARENT_THREAD,
      });
      assert.isAtLeast(inboxResult.sequence, 1);

      // The dispatch result carries only a sequence; the state is read from
      // the store the handler wrote.
      const store = yield* DelegationStore;
      const delegations = yield* store.listByParent(PARENT_THREAD);
      assert.strictEqual(delegations.length, 1);
      assert.strictEqual(delegations[0]!.role, "research");
      assert.match(delegations[0]!.objective, /inbox-visible/);

      // agent.handoff from the child terminalizes the delegation the parent
      // then sees in its inbox.
      const childThreadId = delegations[0]!.childThreadId!;
      yield* dispatchService.dispatch(handoffCommand(childThreadId));
      const afterHandoff = yield* store.findById(delegations[0]!.delegationId);
      assert.strictEqual(afterHandoff?.state, "completed");
    }).pipe(Effect.provide(dispatchSystemLayer)),
  );

  it.effect("answers agent.whoami with the bound thread and fails closed when unbound", () =>
    Effect.gen(function* () {
      const runner = yield* AgentCommandRunner;

      // Bound: subject thread:<id> → that id back, on the result's `self`.
      const boundResult = yield* runner.dispatch(whoamiCommand(), {
        selfIdentity: selfIdentityFromSessionSubject(`thread:${PARENT_THREAD}`),
      });
      assert.strictEqual(boundResult.self, PARENT_THREAD);

      // Unbound: a session with a non-thread subject must not be told a thread.
      const failure = yield* runner
        .dispatch(whoamiCommand(), {
          selfIdentity: selfIdentityFromSessionSubject("scout-rsi"),
        })
        .pipe(Effect.flip);
      assert.isTrue(isSelfNotBound(failure));
    }).pipe(Effect.provide(dispatchSystemLayer)),
  );

  it.effect("fails closed with an invariant error if a dispatch path skips the runner", () =>
    Effect.gen(function* () {
      yield* seedParentThread("bypass");
      const engine = yield* OrchestrationEngineService;
      const failure = yield* engine
        .dispatch({
          type: "agent.spawn",
          commandId: dispatchCommandId("bypass-runner"),
          actorThreadId: PARENT_THREAD,
          role: "research",
          objective: "bypass",
          judgment: "n/a",
        })
        .pipe(Effect.flip);
      assert.match(String((failure as Error).message), /agent command runner/);
    }).pipe(Effect.provide(dispatchSystemLayer)),
  );
});

describe("delegation waker (real engine + sqlite)", () => {
  it.effect(
    "wakes the parent once when a child turn goes terminal; unrelated threads wake nobody",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const store = yield* DelegationStore;
        const wakeReactor = yield* DelegationWakeReactor;
        yield* wakeReactor.start();

        yield* engine.dispatch({
          type: "project.create",
          commandId: dispatchCommandId("wake-project"),
          projectId: PROJECT,
          title: "Wake Project",
          workspaceRoot: "/tmp/agent-wake-test",
          defaultModelSelection: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        for (const threadId of [PARENT_THREAD, UNRELATED_THREAD]) {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: dispatchCommandId(`wake-thread:${threadId}`),
            threadId,
            projectId: PROJECT,
            title: threadId,
            modelSelection: {
              instanceId: ProviderInstanceId.make("opencode"),
              model: "self-hosted-glm/glm-5.3-flash",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          });
        }

        // A live delegation child under PARENT_THREAD.
        const delegationId = "dlg-wake-child";
        yield* store.insertPending({
          delegationId: DelegationId.make(delegationId),
          parentThreadId: PARENT_THREAD,
          role: "research",
          providerInstanceId: ProviderInstanceId.make("opencode"),
          model: "self-hosted-glm/glm-5.3-flash",
          objective: "Wake me",
          judgment: "Whether the wake lands",
          resourceLease: undefined,
          idempotencyKey: undefined,
          spawnCommandId: `delegation:${delegationId}:thread-create`,
          deadlineAt: undefined,
        });
        yield* store.markRunning(DelegationId.make(delegationId), UNRELATED_THREAD, 1);

        // Drive the child turn: running, then terminal via the authoritative
        // session-set transition.
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: dispatchCommandId("wake-session-running"),
          threadId: UNRELATED_THREAD,
          session: {
            threadId: UNRELATED_THREAD,
            status: "running",
            providerName: "opencode",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-child-1"),
            lastError: null,
            updatedAt: "2026-01-01T00:01:00.000Z",
          },
          createdAt: "2026-01-01T00:01:00.000Z",
        });
        yield* engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: dispatchCommandId("wake-turn-record"),
          threadId: UNRELATED_THREAD,
          turnId: TurnId.make("turn-child-1"),
          completedAt: "2026-01-01T00:02:00.000Z",
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/wake/turn/1"),
          status: "ready",
          files: [],
          checkpointTurnCount: 1,
          createdAt: "2026-01-01T00:02:00.000Z",
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: dispatchCommandId("wake-session-ready"),
          threadId: UNRELATED_THREAD,
          session: {
            threadId: UNRELATED_THREAD,
            status: "ready",
            providerName: "opencode",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:02:30.000Z",
          },
          createdAt: "2026-01-01T00:02:30.000Z",
        });
        yield* wakeReactor.drain;

        // The parent now has a queued turn start whose text cites the delegation.
        const sql = yield* SqlClient.SqlClient;
        const parentMessages = yield* sql<{ readonly text: string; readonly role: string }>`
          SELECT text, role FROM projection_thread_messages
          WHERE thread_id = ${PARENT_THREAD} AND role = 'user'
          ORDER BY created_at ASC
        `;
        assert.strictEqual(parentMessages.length, 1);
        assert.match(parentMessages[0]!.text, /child reached completed/);
        assert.match(parentMessages[0]!.text, new RegExp(delegationId));

        // Idempotent: re-driving the same terminal transition wakes nobody again.
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: dispatchCommandId("wake-session-ready-2"),
          threadId: UNRELATED_THREAD,
          session: {
            threadId: UNRELATED_THREAD,
            status: "ready",
            providerName: "opencode",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:03:00.000Z",
          },
          createdAt: "2026-01-01T00:03:00.000Z",
        });
        yield* wakeReactor.drain;
        const parentMessagesAfterReplay = yield* sql<{ readonly text: string }>`
          SELECT text FROM projection_thread_messages
          WHERE thread_id = ${PARENT_THREAD} AND role = 'user'
        `;
        assert.strictEqual(parentMessagesAfterReplay.length, 1);
      }).pipe(Effect.provide(wakeSystemLayer)),
  );

  it.effect("does not wake anyone when an unrelated (non-delegation) thread goes terminal", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const wakeReactor = yield* DelegationWakeReactor;
      yield* wakeReactor.start();

      yield* engine.dispatch({
        type: "project.create",
        commandId: dispatchCommandId("wake-negative-project"),
        projectId: PROJECT,
        title: "Wake Negative Project",
        workspaceRoot: "/tmp/agent-wake-negative-test",
        defaultModelSelection: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: dispatchCommandId("wake-negative-thread"),
        threadId: UNRELATED_THREAD,
        projectId: PROJECT,
        title: "Unrelated",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "self-hosted-glm/glm-5.3-flash",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: dispatchCommandId("wake-negative-running"),
        threadId: UNRELATED_THREAD,
        session: {
          threadId: UNRELATED_THREAD,
          status: "running",
          providerName: "opencode",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-unrelated"),
          lastError: null,
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
        createdAt: "2026-01-01T00:01:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: dispatchCommandId("wake-negative-ready"),
        threadId: UNRELATED_THREAD,
        session: {
          threadId: UNRELATED_THREAD,
          status: "ready",
          providerName: "opencode",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:01:30.000Z",
        },
        createdAt: "2026-01-01T00:01:30.000Z",
      });
      yield* wakeReactor.drain;

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages
        WHERE thread_id = ${PARENT_THREAD}
      `;
      assert.strictEqual(rows[0]!.count, 0);
    }).pipe(Effect.provide(wakeSystemLayer)),
  );
});
