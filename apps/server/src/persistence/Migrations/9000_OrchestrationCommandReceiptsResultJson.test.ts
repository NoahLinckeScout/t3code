import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

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

layer("9000_OrchestrationCommandReceiptsResultJson", (it) => {
  it.effect("adds the result column to a fresh database in the fork range", () =>
    Effect.gen(function* () {
      yield* runMigrations();

      assert.include(yield* receiptColumns, "result_json");
      // The upstream tracking table stops at upstream's own migrations; the
      // fork's migration is recorded in its own table so a future upstream
      // 053 is never skipped by the "above the highest id" rule.
      const upstream = yield* upstreamRows;
      assert.equal(Math.max(...upstream.map((row) => row.migration_id)), 52);
      assert.deepEqual(
        (yield* forkRows).map((row) => [row.migration_id, row.name]),
        [[9000, "OrchestrationCommandReceiptsResultJson"]],
      );
    }),
  );

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

      // The stale record is gone, so upstream's real 053 will run after the
      // next upstream merge, and the fork's migration re-applied under 9000.
      const upstream = yield* upstreamRows;
      assert.deepEqual(
        upstream.filter((row) => row.migration_id === 53).map((row) => row.name),
        [],
      );
      assert.equal(Math.max(...upstream.map((row) => row.migration_id)), 52);
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
