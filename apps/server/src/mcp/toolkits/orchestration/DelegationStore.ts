/**
 * Durable state for delegations and the thread inbox.
 *
 * ## Why these tables are created here instead of in `persistence/Migrations`
 *
 * This is a fork-local toolkit and rebasing onto upstream must stay trivial. A
 * numbered migration file collides with the next number upstream adds, on every
 * rebase, forever. These two tables are self-contained, additive, and created
 * with `IF NOT EXISTS` when the layer builds, so they cost nothing to carry and
 * nothing to drop.
 *
 * They live in the same `state.sqlite` as everything else, which keeps one
 * database to back up, copy with `VACUUM INTO`, and reason about.
 *
 * ## What is authoritative here, and what is not
 *
 * These rows are the system of record for *delegation* state: who owns what,
 * which lease is held, what the terminal handoff said. They are not a second
 * copy of orchestration events. Thread and turn state stays in
 * `orchestration_events`, and this store only ever holds locators into it.
 *
 * The write path is ordered so a crash is recoverable rather than silent: the
 * row is inserted `pending` with its spawn command id *before* the command is
 * dispatched. Command ids are deduplicated by `orchestration_command_receipts`,
 * so re-dispatching a `pending` row's command returns the original sequence
 * instead of creating a second child.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { type DelegationId, type DelegationState, OrchestrationToolkitError } from "./schemas.ts";

export interface DelegationRow {
  readonly delegationId: DelegationId;
  readonly parentThreadId: ThreadId;
  readonly childThreadId: ThreadId | null;
  readonly role: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly state: DelegationState;
  readonly objective: string;
  readonly judgment: string;
  readonly resourceLease: string | null;
  readonly idempotencyKey: string | null;
  readonly spawnCommandId: string;
  readonly spawnSequence: number | null;
  readonly handoffJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InboxRow {
  readonly messageId: string;
  readonly fromThreadId: ThreadId;
  readonly fromDelegationId: DelegationId | null;
  readonly toThreadId: ThreadId;
  readonly body: string;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
}

export interface InsertPendingInput {
  readonly delegationId: DelegationId;
  readonly parentThreadId: ThreadId;
  readonly role: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly objective: string;
  readonly judgment: string;
  readonly resourceLease: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly spawnCommandId: string;
}

export interface DelegationStoreShape {
  readonly findById: (
    delegationId: DelegationId,
  ) => Effect.Effect<DelegationRow | undefined, OrchestrationToolkitError>;
  readonly findByChildThread: (
    childThreadId: ThreadId,
  ) => Effect.Effect<DelegationRow | undefined, OrchestrationToolkitError>;
  readonly findByIdempotencyKey: (
    parentThreadId: ThreadId,
    idempotencyKey: string,
  ) => Effect.Effect<DelegationRow | undefined, OrchestrationToolkitError>;
  readonly findLiveByLease: (
    resourceLease: string,
  ) => Effect.Effect<DelegationRow | undefined, OrchestrationToolkitError>;
  readonly listByParent: (
    parentThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<DelegationRow>, OrchestrationToolkitError>;
  readonly insertPending: (
    input: InsertPendingInput,
  ) => Effect.Effect<void, OrchestrationToolkitError>;
  readonly markRunning: (
    delegationId: DelegationId,
    childThreadId: ThreadId,
    spawnSequence: number,
  ) => Effect.Effect<void, OrchestrationToolkitError>;
  readonly markTerminal: (
    delegationId: DelegationId,
    state: DelegationState,
    handoffJson: string,
  ) => Effect.Effect<void, OrchestrationToolkitError>;
  /**
   * How many delegation hops separate this thread from an operator-started one.
   * An operator-started thread is depth 0.
   */
  readonly depthOf: (threadId: ThreadId) => Effect.Effect<number, OrchestrationToolkitError>;
  readonly enqueueMessage: (input: {
    readonly messageId: string;
    readonly fromThreadId: ThreadId;
    readonly fromDelegationId: DelegationId | undefined;
    readonly toThreadId: ThreadId;
    readonly body: string;
  }) => Effect.Effect<boolean, OrchestrationToolkitError>;
  readonly readInbox: (
    toThreadId: ThreadId,
    includeDelivered: boolean,
  ) => Effect.Effect<ReadonlyArray<InboxRow>, OrchestrationToolkitError>;
  readonly markDelivered: (
    messageIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, OrchestrationToolkitError>;
  /** Resolves the project a thread belongs to, needed to create a sibling. */
  readonly projectIdOfThread: (
    threadId: ThreadId,
  ) => Effect.Effect<string | undefined, OrchestrationToolkitError>;
  readonly worktreePathOfThread: (
    threadId: ThreadId,
  ) => Effect.Effect<string | undefined, OrchestrationToolkitError>;
}

export class DelegationStore extends Context.Service<DelegationStore, DelegationStoreShape>()(
  "t3/mcp/toolkits/orchestration/DelegationStore",
) {}

const storageFailed = (operation: string) => (cause: unknown) =>
  new OrchestrationToolkitError({
    reason: "storage_failed",
    detail: `${operation} failed: ${String(cause)}`,
  });

const makeDelegationStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const isoNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  yield* Effect.all([
    sql`
      CREATE TABLE IF NOT EXISTS orchestration_delegations (
        delegation_id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT,
        role TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        model TEXT NOT NULL,
        state TEXT NOT NULL,
        objective TEXT NOT NULL,
        judgment TEXT NOT NULL,
        resource_lease TEXT,
        idempotency_key TEXT,
        spawn_command_id TEXT NOT NULL UNIQUE,
        spawn_sequence INTEGER,
        handoff_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
    sql`
      CREATE INDEX IF NOT EXISTS orchestration_delegations_parent
        ON orchestration_delegations (parent_thread_id)
    `,
    sql`
      CREATE UNIQUE INDEX IF NOT EXISTS orchestration_delegations_child
        ON orchestration_delegations (child_thread_id)
        WHERE child_thread_id IS NOT NULL
    `,
    // Two live delegations may never hold one resource. Enforced by the database
    // rather than a read-then-write check, which races under concurrent spawns.
    sql`
      CREATE UNIQUE INDEX IF NOT EXISTS orchestration_delegations_live_lease
        ON orchestration_delegations (resource_lease)
        WHERE resource_lease IS NOT NULL AND state IN ('pending', 'running')
    `,
    sql`
      CREATE UNIQUE INDEX IF NOT EXISTS orchestration_delegations_idempotency
        ON orchestration_delegations (parent_thread_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `,
    sql`
      CREATE TABLE IF NOT EXISTS orchestration_messages (
        message_id TEXT PRIMARY KEY,
        from_thread_id TEXT NOT NULL,
        from_delegation_id TEXT,
        to_thread_id TEXT NOT NULL,
        body TEXT NOT NULL,
        delivered_at TEXT,
        created_at TEXT NOT NULL
      )
    `,
    sql`
      CREATE INDEX IF NOT EXISTS orchestration_messages_recipient
        ON orchestration_messages (to_thread_id, delivered_at)
    `,
  ]).pipe(Effect.mapError(storageFailed("DelegationStore.ensureSchema")));

  const delegationColumns = sql`
    delegation_id AS "delegationId",
    parent_thread_id AS "parentThreadId",
    child_thread_id AS "childThreadId",
    role,
    provider_instance_id AS "providerInstanceId",
    model,
    state,
    objective,
    judgment,
    resource_lease AS "resourceLease",
    idempotency_key AS "idempotencyKey",
    spawn_command_id AS "spawnCommandId",
    spawn_sequence AS "spawnSequence",
    handoff_json AS "handoffJson",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const messageColumns = sql`
    message_id AS "messageId",
    from_thread_id AS "fromThreadId",
    from_delegation_id AS "fromDelegationId",
    to_thread_id AS "toThreadId",
    body,
    delivered_at AS "deliveredAt",
    created_at AS "createdAt"
  `;

  const findById: DelegationStoreShape["findById"] = Effect.fn("DelegationStore.findById")(
    function* (delegationId) {
      const rows = yield* sql<DelegationRow>`
        SELECT ${delegationColumns} FROM orchestration_delegations
        WHERE delegation_id = ${delegationId}
      `;
      return rows[0];
    },
    Effect.mapError(storageFailed("DelegationStore.findById")),
  );

  const findByChildThread: DelegationStoreShape["findByChildThread"] = Effect.fn(
    "DelegationStore.findByChildThread",
  )(
    function* (childThreadId) {
      const rows = yield* sql<DelegationRow>`
        SELECT ${delegationColumns} FROM orchestration_delegations
        WHERE child_thread_id = ${childThreadId}
      `;
      return rows[0];
    },
    Effect.mapError(storageFailed("DelegationStore.findByChildThread")),
  );

  const findByIdempotencyKey: DelegationStoreShape["findByIdempotencyKey"] = Effect.fn(
    "DelegationStore.findByIdempotencyKey",
  )(
    function* (parentThreadId, idempotencyKey) {
      const rows = yield* sql<DelegationRow>`
        SELECT ${delegationColumns} FROM orchestration_delegations
        WHERE parent_thread_id = ${parentThreadId} AND idempotency_key = ${idempotencyKey}
      `;
      return rows[0];
    },
    Effect.mapError(storageFailed("DelegationStore.findByIdempotencyKey")),
  );

  const findLiveByLease: DelegationStoreShape["findLiveByLease"] = Effect.fn(
    "DelegationStore.findLiveByLease",
  )(
    function* (resourceLease) {
      const rows = yield* sql<DelegationRow>`
        SELECT ${delegationColumns} FROM orchestration_delegations
        WHERE resource_lease = ${resourceLease} AND state IN ('pending', 'running')
      `;
      return rows[0];
    },
    Effect.mapError(storageFailed("DelegationStore.findLiveByLease")),
  );

  const listByParent: DelegationStoreShape["listByParent"] = Effect.fn(
    "DelegationStore.listByParent",
  )(
    function* (parentThreadId) {
      return yield* sql<DelegationRow>`
        SELECT ${delegationColumns} FROM orchestration_delegations
        WHERE parent_thread_id = ${parentThreadId}
        ORDER BY created_at ASC
      `;
    },
    Effect.mapError(storageFailed("DelegationStore.listByParent")),
  );

  const insertPending: DelegationStoreShape["insertPending"] = Effect.fn(
    "DelegationStore.insertPending",
  )(function* (input) {
    const now = yield* isoNow;
    yield* sql`
      INSERT INTO orchestration_delegations (
        delegation_id, parent_thread_id, child_thread_id, role, provider_instance_id,
        model, state, objective, judgment, resource_lease, idempotency_key,
        spawn_command_id, spawn_sequence, handoff_json, created_at, updated_at
      ) VALUES (
        ${input.delegationId}, ${input.parentThreadId}, NULL, ${input.role},
        ${input.providerInstanceId}, ${input.model}, 'pending', ${input.objective},
        ${input.judgment}, ${input.resourceLease ?? null}, ${input.idempotencyKey ?? null},
        ${input.spawnCommandId}, NULL, NULL, ${now}, ${now}
      )
    `.pipe(
      // The lease index is the concurrent-spawn guard, so a rejected insert is
      // usually a lease conflict. Which one it was is decided by re-reading the
      // holder rather than by matching driver error text, which is not a
      // contract and differs between SQLite builds.
      Effect.catch((cause) =>
        Effect.gen(function* () {
          if (input.resourceLease === undefined) {
            return yield* storageFailed("DelegationStore.insertPending")(cause);
          }
          const holder = yield* findLiveByLease(input.resourceLease);
          return yield* holder
            ? new OrchestrationToolkitError({
                reason: "lease_held",
                detail: `Delegation ${holder.delegationId} (${holder.role}, ${holder.state}) already holds the lease ${input.resourceLease}.`,
              })
            : storageFailed("DelegationStore.insertPending")(cause);
        }),
      ),
    );
  });

  const markRunning: DelegationStoreShape["markRunning"] = Effect.fn("DelegationStore.markRunning")(
    function* (delegationId, childThreadId, spawnSequence) {
      const now = yield* isoNow;
      yield* sql`
        UPDATE orchestration_delegations
        SET state = 'running',
            child_thread_id = ${childThreadId},
            spawn_sequence = ${spawnSequence},
            updated_at = ${now}
        WHERE delegation_id = ${delegationId} AND state = 'pending'
      `;
    },
    Effect.mapError(storageFailed("DelegationStore.markRunning")),
  );

  const markTerminal: DelegationStoreShape["markTerminal"] = Effect.fn(
    "DelegationStore.markTerminal",
  )(
    function* (delegationId, state, handoffJson) {
      const now = yield* isoNow;
      // Terminal only from `running`: a delegation cannot be completed twice,
      // and one that never started cannot be reported on.
      yield* sql`
        UPDATE orchestration_delegations
        SET state = ${state},
            handoff_json = ${handoffJson},
            updated_at = ${now}
        WHERE delegation_id = ${delegationId} AND state = 'running'
      `;
    },
    Effect.mapError(storageFailed("DelegationStore.markTerminal")),
  );

  const depthOf: DelegationStoreShape["depthOf"] = Effect.fn("DelegationStore.depthOf")(
    function* (threadId) {
      let depth = 0;
      let cursor: ThreadId | null = threadId;
      const seen = new Set<string>();
      while (cursor !== null && !seen.has(cursor)) {
        seen.add(cursor);
        const parent: DelegationRow | undefined = yield* findByChildThread(cursor);
        if (!parent) break;
        depth += 1;
        cursor = parent.parentThreadId;
      }
      return depth;
    },
  );

  const enqueueMessage: DelegationStoreShape["enqueueMessage"] = Effect.fn(
    "DelegationStore.enqueueMessage",
  )(
    function* (input) {
      const now = yield* isoNow;
      const inserted = yield* sql`
        INSERT INTO orchestration_messages (
          message_id, from_thread_id, from_delegation_id, to_thread_id, body, delivered_at, created_at
        ) VALUES (
          ${input.messageId}, ${input.fromThreadId}, ${input.fromDelegationId ?? null},
          ${input.toThreadId}, ${input.body}, NULL, ${now}
        )
        ON CONFLICT (message_id) DO NOTHING
        RETURNING message_id AS "messageId"
      `;
      return inserted.length > 0;
    },
    Effect.mapError(storageFailed("DelegationStore.enqueueMessage")),
  );

  const readInbox: DelegationStoreShape["readInbox"] = Effect.fn("DelegationStore.readInbox")(
    function* (toThreadId, includeDelivered) {
      return yield* sql<InboxRow>`
        SELECT ${messageColumns} FROM orchestration_messages
        WHERE to_thread_id = ${toThreadId}
          AND (${includeDelivered ? 1 : 0} = 1 OR delivered_at IS NULL)
        ORDER BY created_at ASC
      `;
    },
    Effect.mapError(storageFailed("DelegationStore.readInbox")),
  );

  const markDelivered: DelegationStoreShape["markDelivered"] = Effect.fn(
    "DelegationStore.markDelivered",
  )(
    function* (messageIds) {
      if (messageIds.length === 0) return;
      const now = yield* isoNow;
      yield* sql`
        UPDATE orchestration_messages
        SET delivered_at = ${now}
        WHERE message_id IN ${sql.in(messageIds)}
      `;
    },
    Effect.mapError(storageFailed("DelegationStore.markDelivered")),
  );

  const projectIdOfThread: DelegationStoreShape["projectIdOfThread"] = Effect.fn(
    "DelegationStore.projectIdOfThread",
  )(
    function* (threadId) {
      const rows = yield* sql<{ readonly projectId: string }>`
        SELECT project_id AS "projectId" FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      return rows[0]?.projectId;
    },
    Effect.mapError(storageFailed("DelegationStore.projectIdOfThread")),
  );

  const worktreePathOfThread: DelegationStoreShape["worktreePathOfThread"] = Effect.fn(
    "DelegationStore.worktreePathOfThread",
  )(
    function* (threadId) {
      const rows = yield* sql<{ readonly worktreePath: string | null }>`
        SELECT worktree_path AS "worktreePath" FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      return rows[0]?.worktreePath ?? undefined;
    },
    Effect.mapError(storageFailed("DelegationStore.worktreePathOfThread")),
  );

  return DelegationStore.of({
    findById,
    findByChildThread,
    findByIdempotencyKey,
    findLiveByLease,
    listByParent,
    insertPending,
    markRunning,
    markTerminal,
    depthOf,
    enqueueMessage,
    readInbox,
    markDelivered,
    projectIdOfThread,
    worktreePathOfThread,
  });
});

export const layer = Layer.effect(DelegationStore, makeDelegationStore);
