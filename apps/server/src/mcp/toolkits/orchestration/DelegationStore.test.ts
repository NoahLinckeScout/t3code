import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as DelegationStoreLayer from "./DelegationStore.ts";
import { DelegationStore } from "./DelegationStore.ts";
import { DelegationId } from "./schemas.ts";

// One database is shared across the block, so every case names its own rows.
const layer = it.layer(
  DelegationStoreLayer.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const ids = (scope: string) => ({
  first: DelegationId.make(`dlg-${scope}-1`),
  second: DelegationId.make(`dlg-${scope}-2`),
  parent: ThreadId.make(`thread-${scope}-parent`),
  child: ThreadId.make(`thread-${scope}-child`),
  grandchild: ThreadId.make(`thread-${scope}-grandchild`),
  lease: `git:owner/repo#${scope}`,
});

const pending = (
  overrides: Partial<DelegationStoreLayer.InsertPendingInput> &
    Pick<DelegationStoreLayer.InsertPendingInput, "delegationId" | "parentThreadId">,
): DelegationStoreLayer.InsertPendingInput => ({
  role: "implementer",
  providerInstanceId: "opencode",
  model: "self-hosted-glm",
  objective: "Fix the failing migration test",
  judgment: "Whether the fix belongs in the migration or the projection",
  resourceLease: undefined,
  idempotencyKey: undefined,
  spawnCommandId: `delegation:${overrides.delegationId}:thread-create`,
  deadlineAt: undefined,
  ...overrides,
});

layer("DelegationStore", (it) => {
  it.effect("round-trips a delegation from pending through running to terminal", () =>
    Effect.gen(function* () {
      const store = yield* DelegationStore;
      const id = ids("roundtrip");

      yield* store.insertPending(pending({ delegationId: id.first, parentThreadId: id.parent }));
      const created = yield* store.findById(id.first);
      assert.strictEqual(created?.state, "pending");
      assert.strictEqual(created?.childThreadId, null);

      yield* store.markRunning(id.first, id.child, 42);
      const running = yield* store.findByChildThread(id.child);
      assert.strictEqual(running?.state, "running");
      assert.strictEqual(running?.spawnSequence, 42);

      yield* store.markTerminal(id.first, "completed", '{"status":"completed"}');
      const done = yield* store.findById(id.first);
      assert.strictEqual(done?.state, "completed");
      assert.strictEqual(done?.handoffJson, '{"status":"completed"}');
    }),
  );

  it.effect("refuses a second live delegation on a held lease", () =>
    Effect.gen(function* () {
      const store = yield* DelegationStore;
      const id = ids("lease-held");

      yield* store.insertPending(
        pending({ delegationId: id.first, parentThreadId: id.parent, resourceLease: id.lease }),
      );
      const holder = yield* store.findLiveByLease(id.lease);
      assert.strictEqual(holder?.delegationId, id.first);

      const conflict = yield* store
        .insertPending(
          pending({ delegationId: id.second, parentThreadId: id.parent, resourceLease: id.lease }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(conflict.reason, "lease_held");
    }),
  );

  it.effect("frees a lease once its delegation reaches a terminal state", () =>
    Effect.gen(function* () {
      const store = yield* DelegationStore;
      const id = ids("lease-freed");

      yield* store.insertPending(
        pending({ delegationId: id.first, parentThreadId: id.parent, resourceLease: id.lease }),
      );
      yield* store.markRunning(id.first, id.child, 1);
      yield* store.markTerminal(id.first, "blocked", "{}");

      assert.strictEqual(yield* store.findLiveByLease(id.lease), undefined);
      // The successor takes the lease only because the index is partial on live rows.
      yield* store.insertPending(
        pending({ delegationId: id.second, parentThreadId: id.parent, resourceLease: id.lease }),
      );
      assert.strictEqual((yield* store.findLiveByLease(id.lease))?.delegationId, id.second);
    }),
  );

  it.effect("refuses to move a terminal delegation again", () =>
    Effect.gen(function* () {
      const store = yield* DelegationStore;
      const id = ids("terminal-once");

      yield* store.insertPending(pending({ delegationId: id.first, parentThreadId: id.parent }));
      yield* store.markRunning(id.first, id.child, 1);
      yield* store.markTerminal(id.first, "completed", '{"first":true}');
      yield* store.markTerminal(id.first, "blocked", '{"second":true}');

      const row = yield* store.findById(id.first);
      assert.strictEqual(row?.state, "completed");
      assert.strictEqual(row?.handoffJson, '{"first":true}');
    }),
  );

  it.effect("counts delegation depth by walking the parent chain", () =>
    Effect.gen(function* () {
      const store = yield* DelegationStore;
      const id = ids("depth");

      assert.strictEqual(yield* store.depthOf(id.parent), 0);

      yield* store.insertPending(pending({ delegationId: id.first, parentThreadId: id.parent }));
      yield* store.markRunning(id.first, id.child, 1);
      assert.strictEqual(yield* store.depthOf(id.child), 1);

      yield* store.insertPending(pending({ delegationId: id.second, parentThreadId: id.child }));
      yield* store.markRunning(id.second, id.grandchild, 2);
      assert.strictEqual(yield* store.depthOf(id.grandchild), 2);
    }),
  );

  it.effect("enqueues a message once per idempotency key", () =>
    Effect.gen(function* () {
      const store = yield* DelegationStore;
      const id = ids("message-once");
      const message = {
        messageId: `msg:${id.child}:note`,
        fromThreadId: id.child,
        fromDelegationId: undefined,
        toThreadId: id.parent,
        body: "Blocked on a contract decision.",
      };

      assert.strictEqual(yield* store.enqueueMessage(message), true);
      assert.strictEqual(yield* store.enqueueMessage(message), false);

      const inbox = yield* store.readInbox(id.parent, false);
      assert.strictEqual(inbox.length, 1);
      assert.strictEqual(inbox[0]?.body, "Blocked on a contract decision.");
    }),
  );

  it.effect("stops returning a message once it has been delivered", () =>
    Effect.gen(function* () {
      const store = yield* DelegationStore;
      const id = ids("message-delivered");
      const messageId = `msg:${id.child}:note`;

      yield* store.enqueueMessage({
        messageId,
        fromThreadId: id.child,
        fromDelegationId: undefined,
        toThreadId: id.parent,
        body: "Done.",
      });

      yield* store.markDelivered([messageId]);
      assert.strictEqual((yield* store.readInbox(id.parent, false)).length, 0);
      assert.strictEqual((yield* store.readInbox(id.parent, true)).length, 1);
    }),
  );

  it.effect("resolves the project and worktree a child should inherit", () =>
    Effect.gen(function* () {
      const store = yield* DelegationStore;
      const sql = yield* SqlClient.SqlClient;
      const id = ids("project");

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, worktree_path, created_at, updated_at,
          runtime_mode, interaction_mode, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan
        ) VALUES (
          ${id.parent}, 'project-1', 'Parent', '/tmp/worktree',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          'full-access', 'default', 0, 0, 0
        )
      `;

      assert.strictEqual(yield* store.projectIdOfThread(id.parent), "project-1");
      assert.strictEqual(yield* store.worktreePathOfThread(id.parent), "/tmp/worktree");
      assert.strictEqual(yield* store.projectIdOfThread(id.child), undefined);
    }),
  );
});
