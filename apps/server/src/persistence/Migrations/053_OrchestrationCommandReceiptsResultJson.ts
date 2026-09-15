import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(orchestration_command_receipts)
  `;

  if (!columns.some((column) => column.name === "result_json")) {
    yield* sql`
      ALTER TABLE orchestration_command_receipts
      ADD COLUMN result_json TEXT
    `;
  }
});
