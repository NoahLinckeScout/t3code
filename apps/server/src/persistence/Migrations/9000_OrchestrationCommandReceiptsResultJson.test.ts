import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const receiptColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(orchestration_command_receipts)
  `;
  return columns.map((column) => column.name);
});

const upstreamRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations
  `;
});

const forkRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations_fork
  `;
});

// One layer suite per database so each starts from a fresh in-memory state.

layer("9000 fresh database", (it) => {
  it.effect("adds the result column and records the fork migration in its range", () =>
    Effect.gen(function* () {
      yield* runMigrations();

      assert.include(yield* receiptColumns, "result_json");
      // The upstream tracking table records only upstream's migrations
      // (through this checkout's latest upstream base); the fork's migration
      // is recorded in its own table so it never raises the upstream
      // migrator's "latest applied id".
      const upstream = yield* upstreamRows;
      assert.deepEqual(
        upstream.filter((row) => row.migration_id >= 53).map((row) => [row.migration_id, row.name]),
        [
          [53, "PullRequestFilesViewed"],
          [54, "ProjectionThreadsAutoSettleDisabledAt"],
        ],
      );
      assert.deepEqual(
        (yield* forkRows).map((row) => [row.migration_id, row.name]),
        [[9000, "OrchestrationCommandReceiptsResultJson"]],
      );
    }),
  );
});

layer("9000 pre-renumbering database", (it) => {
  it.effect("repairs a database that recorded the fork migration as id 53", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Shape of a database migrated by fork versions before the renumbering:
      // upstream's 053 slot occupied by the fork's migration record.
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`ALTER TABLE orchestration_command_receipts ADD COLUMN result_json TEXT`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (53, 'OrchestrationCommandReceiptsResultJson')
      `;

      yield* runMigrations();

      // The stale record is gone, so upstream's real 053 (and 054) run in
      // this checkout, and the fork's migration re-applied under 9000.
      const upstream = yield* upstreamRows;
      assert.deepEqual(
        upstream.filter((row) => row.migration_id >= 53).map((row) => [row.migration_id, row.name]),
        [
          [53, "PullRequestFilesViewed"],
          [54, "ProjectionThreadsAutoSettleDisabledAt"],
        ],
      );
      assert.deepEqual(
        (yield* forkRows).map((row) => [row.migration_id, row.name]),
        [[9000, "OrchestrationCommandReceiptsResultJson"]],
      );
      assert.include(yield* receiptColumns, "result_json");

      // Re-running settles on the same state.
      yield* runMigrations();
      assert.equal((yield* upstreamRows).length, upstream.length);
      assert.equal((yield* forkRows).length, 1);
    }),
  );
});

layer("9000 naive upstream merge pollution", (it) => {
  it.effect("repairs a database a naive merge binary recorded upstream 054 into", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Shape of a database touched by an intermediate fork build that kept
      // the stale 053 slot and appended upstream's 054 above it: 054's change
      // applied and recorded, upstream's 053 never run, the fork's record
      // still occupying the 53 slot, no fork tracking table.
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`ALTER TABLE orchestration_command_receipts ADD COLUMN result_json TEXT`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (53, 'OrchestrationCommandReceiptsResultJson')
      `;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN auto_settle_disabled_at TEXT`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (54, 'ProjectionThreadsAutoSettleDisabledAt')
      `;

      yield* runMigrations();

      // Both stale records are gone and upstream's real migrations ran in
      // order — 053's table now exists, 054 re-applies as a no-op — and the
      // fork's migration is recorded in its own table.
      const upstream = yield* upstreamRows;
      assert.deepEqual(
        upstream
          .filter((row) => row.migration_id === 53 || row.migration_id === 54)
          .map((row) => [row.migration_id, row.name]),
        [
          [53, "PullRequestFilesViewed"],
          [54, "ProjectionThreadsAutoSettleDisabledAt"],
        ],
      );
      assert.deepEqual(
        (yield* forkRows).map((row) => [row.migration_id, row.name]),
        [[9000, "OrchestrationCommandReceiptsResultJson"]],
      );
      const tables = yield* SqlClient.SqlClient.pipe(
        Effect.flatMap(
          (sql) =>
            sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master WHERE name = 'pull_request_files_viewed'
          `,
        ),
      );
      assert.equal(tables.length, 1);
      assert.include(yield* receiptColumns, "result_json");

      // Re-running settles on the same state.
      yield* runMigrations();
      assert.equal((yield* upstreamRows).length, upstream.length);
      assert.equal((yield* forkRows).length, 1);
    }),
  );
});
