/**
 * Named roles stay an operator-authored capability map. Catalog keys must
 * resolve against settings.json without a per-model role edit.
 */
import { ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../../config.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { catalogInstancesFromSettings, OrchestrationRoles, parseCatalogRoleKey } from "./roles.ts";
import * as OrchestrationRolesModule from "./roles.ts";
import { OrchestrationToolkitError } from "./schemas.ts";

const isToolkitError = Schema.is(OrchestrationToolkitError);

const NAMED_ROLES_JSON = `{
  "maxDepth": 2,
  "roles": {
    "research": {
      "providerInstanceId": "opencode",
      "model": "self-hosted-glm/glm-5.3-flash",
      "options": [{ "id": "agent", "value": "build" }],
      "canSpawn": false,
      "instructions": "Stay read-only."
    }
  }
}`;

const SETTINGS_JSON = `{
  "providerInstances": {
    "claudeAgent": {
      "driver": "claudeAgent",
      "enabled": true,
      "config": {
        "customModels": [
          {
            "slug": "glm-5.3-flash",
            "capabilities": {
              "optionDescriptors": [
                {
                  "id": "effort",
                  "label": "Reasoning",
                  "type": "select",
                  "options": [
                    { "id": "low", "label": "Low" },
                    { "id": "high", "label": "High", "isDefault": true }
                  ],
                  "currentValue": "high"
                }
              ]
            }
          },
          "glm-5.3-flash-c8"
        ]
      }
    },
    "codex": {
      "driver": "codex",
      "enabled": false,
      "config": { "customModels": ["glm-5.2"] }
    }
  }
}`;

const rolesLayer = OrchestrationRolesModule.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-roles-catalog-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const writeFixtures = Effect.fn("rolesTest.writeFixtures")(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(`${config.stateDir}/orchestration-roles.json`, NAMED_ROLES_JSON);
  yield* fs.writeFileString(config.settingsPath, SETTINGS_JSON);
});

const writeRolesFile = Effect.fn("rolesTest.writeRolesFile")(function* (rolesJson: string) {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(`${config.stateDir}/orchestration-roles.json`, rolesJson);
});

/**
 * Seed one projection thread with a latest turn in the given state, so the
 * placement query has real rows to count. `model` is what
 * `model_selection_json` records — the concrete slug chosen at spawn.
 */
const seedRunningTurn = Effect.fn("rolesTest.seedRunningTurn")(function* (
  threadId: string,
  model: string,
  state: string,
  instanceId: string = "claudeAgent",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, created_at, updated_at,
      runtime_mode, interaction_mode, pending_approval_count,
      pending_user_input_count, has_actionable_proposed_plan, model_selection_json
    ) VALUES (
      ${threadId}, 'project-roles-test', ${"Seed " + threadId}, '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z',
      'full-access', 'default', 0, 0, 0, ${JSON.stringify({ instanceId, model })}
    )
  `;
  yield* sql`
    INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
    VALUES (${threadId}, ${threadId + "-turn"}, ${state}, '2026-09-21T00:00:00.000Z', '[]')
  `;
  yield* sql`
    UPDATE projection_threads SET latest_turn_id = ${threadId + "-turn"} WHERE thread_id = ${threadId}
  `;
});

const CANDIDATE_ROLES_JSON = `{
  "maxDepth": 2,
  "roles": {
    "implement": {
      "providerInstanceId": "claudeAgent",
      "model": "glm-5.3-flash",
      "candidates": ["glm-5.3-flash", "glm-5.3-flash-c2"],
      "modelHosts": { "glm-5.3-flash": "crusoe-7", "glm-5.3-flash-c2": "crusoe-2" }
    },
    "pinned": {
      "providerInstanceId": "claudeAgent",
      "model": "glm-5.3-flash-c2"
    }
  }
}`;

describe("parseCatalogRoleKey", () => {
  it("splits on the first slash so model slugs may contain slashes", () => {
    assert.deepStrictEqual(parseCatalogRoleKey("opencode/self-hosted-glm53/glm-5.3-flash"), {
      instanceId: "opencode",
      model: "self-hosted-glm53/glm-5.3-flash",
    });
  });

  it("rejects names that are not catalog keys", () => {
    assert.strictEqual(parseCatalogRoleKey("research"), undefined);
    assert.strictEqual(parseCatalogRoleKey("/glm-5.3-flash"), undefined);
    assert.strictEqual(parseCatalogRoleKey("claudeAgent/"), undefined);
  });
});

describe("catalogInstancesFromSettings", () => {
  it("reads enabled custom models from providerInstances", () => {
    const catalog = catalogInstancesFromSettings(JSON.parse(SETTINGS_JSON));
    const claude = catalog.find((instance) => instance.instanceId === "claudeAgent");
    assert.isTrue(claude?.enabled);
    assert.deepStrictEqual(
      claude?.models.map((model) => model.slug),
      ["glm-5.3-flash", "glm-5.3-flash-c8"],
    );
    assert.deepStrictEqual(claude?.models[0]?.options, [{ id: "effort", value: "high" }]);
    const codex = catalog.find((instance) => instance.instanceId === "codex");
    assert.strictEqual(codex?.enabled, false);
  });

  it("falls back to legacy providers.<driver>.customModels for a default instance", () => {
    const catalog = catalogInstancesFromSettings({
      providers: { claudeAgent: { customModels: ["legacy-flash"] } },
    });
    const claude = catalog.find((instance) => instance.instanceId === "claudeAgent");
    assert.isTrue(claude?.enabled);
    assert.deepStrictEqual(
      claude?.models.map((model) => model.slug),
      ["legacy-flash"],
    );
  });

  it("applies the driver's default enabled flag when both flags are omitted", () => {
    const catalog = catalogInstancesFromSettings({
      providerInstances: {
        grok: { driver: "grok", config: { customModels: ["grok-build"] } },
        claudeAgent: { driver: "claudeAgent", config: { customModels: ["glm-5.3-flash"] } },
      },
    });
    assert.strictEqual(catalog.find((instance) => instance.instanceId === "grok")?.enabled, false);
    assert.strictEqual(
      catalog.find((instance) => instance.instanceId === "claudeAgent")?.enabled,
      true,
    );
  });

  it("fills OpenCode routing options for a bare custom-model slug", () => {
    const catalog = catalogInstancesFromSettings({
      providerInstances: {
        opencode: {
          driver: "opencode",
          enabled: true,
          config: { customModels: ["self-hosted-glm53/glm-5.3-flash"] },
        },
      },
    });
    const opencode = catalog.find((instance) => instance.instanceId === "opencode");
    assert.deepStrictEqual(opencode?.models[0]?.options, [
      { id: "variant", value: "medium" },
      { id: "agent", value: "build" },
    ]);
  });
});

describe("OrchestrationRoles catalog fallback", () => {
  it.effect("keeps a named role bound to its file definition", () =>
    Effect.gen(function* () {
      yield* writeFixtures();
      const roles = yield* OrchestrationRoles;
      const resolved = yield* roles.resolve("research");
      assert.strictEqual(resolved.name, "research");
      assert.strictEqual(resolved.providerInstanceId, ProviderInstanceId.make("opencode"));
      assert.strictEqual(resolved.model, "self-hosted-glm/glm-5.3-flash");
      assert.strictEqual(resolved.instructions, "Stay read-only.");
      assert.strictEqual(resolved.canSpawn, false);
    }).pipe(Effect.provide(rolesLayer)),
  );

  it.effect("resolves a catalog model that is not a named role", () =>
    Effect.gen(function* () {
      yield* writeFixtures();
      const roles = yield* OrchestrationRoles;
      const resolved = yield* roles.resolve("claudeAgent/glm-5.3-flash-c8");
      assert.strictEqual(resolved.name, "claudeAgent/glm-5.3-flash-c8");
      assert.strictEqual(resolved.providerInstanceId, ProviderInstanceId.make("claudeAgent"));
      assert.strictEqual(resolved.model, "glm-5.3-flash-c8");
      assert.strictEqual(resolved.canSpawn, false);
      assert.strictEqual(resolved.instructions, undefined);
    }).pipe(Effect.provide(rolesLayer)),
  );

  it.effect("resolves claudeAgent/glm-5.3-flash with catalog default options", () =>
    Effect.gen(function* () {
      yield* writeFixtures();
      const roles = yield* OrchestrationRoles;
      const resolved = yield* roles.resolve("claudeAgent/glm-5.3-flash");
      assert.strictEqual(resolved.model, "glm-5.3-flash");
      assert.deepStrictEqual(resolved.options, [{ id: "effort", value: "high" }]);
    }).pipe(Effect.provide(rolesLayer)),
  );

  it.effect("refuses a disabled instance even when the slug exists", () =>
    Effect.gen(function* () {
      yield* writeFixtures();
      const roles = yield* OrchestrationRoles;
      const failed = yield* roles.resolve("codex/glm-5.2").pipe(Effect.flip);
      if (!isToolkitError(failed)) {
        return assert.fail(`expected a toolkit error, got ${String(failed)}`);
      }
      assert.strictEqual(failed.reason, "role_disabled");
    }).pipe(Effect.provide(rolesLayer)),
  );

  it.effect("refuses a slug that is not in the instance catalog", () =>
    Effect.gen(function* () {
      yield* writeFixtures();
      const roles = yield* OrchestrationRoles;
      const failed = yield* roles.resolve("claudeAgent/not-a-real-model").pipe(Effect.flip);
      if (!isToolkitError(failed)) {
        return assert.fail(`expected a toolkit error, got ${String(failed)}`);
      }
      assert.strictEqual(failed.reason, "role_not_found");
    }).pipe(Effect.provide(rolesLayer)),
  );

  it.effect("catalog-synthesized roles cannot spawn onward", () =>
    Effect.gen(function* () {
      yield* writeFixtures();
      const roles = yield* OrchestrationRoles;
      assert.strictEqual(yield* roles.canSpawnFrom("claudeAgent/glm-5.3-flash"), false);
      assert.strictEqual(yield* roles.canSpawnFrom("research"), false);
    }).pipe(Effect.provide(rolesLayer)),
  );
});

describe("OrchestrationRoles load-aware placement", () => {
  it.effect("binds to the least-loaded host's first candidate", () =>
    Effect.gen(function* () {
      yield* writeRolesFile(CANDIDATE_ROLES_JSON);
      // crusoe-7 carries three live turns, crusoe-2 carries one.
      yield* seedRunningTurn("t-c7-a", "glm-5.3-flash", "running");
      yield* seedRunningTurn("t-c7-b", "glm-5.3-flash", "running");
      yield* seedRunningTurn("t-c7-c", "glm-5.3-flash", "pending");
      yield* seedRunningTurn("t-c2-a", "glm-5.3-flash-c2", "running");
      const roles = yield* OrchestrationRoles;
      const resolved = yield* roles.resolve("implement");
      assert.strictEqual(resolved.model, "glm-5.3-flash-c2");
    }).pipe(Effect.provide(rolesLayer)),
  );

  it.effect("counts alias slugs toward the host they rewrite to", () =>
    Effect.gen(function* () {
      // glm-5.3-flash-deep is not a candidate but its host (crusoe-7) already
      // carries its turn; placement must see that load or the head wins on a
      // machine that is actually twice as busy.
      yield* writeRolesFile(
        CANDIDATE_ROLES_JSON.replace(
          '"modelHosts": { "glm-5.3-flash": "crusoe-7", "glm-5.3-flash-c2": "crusoe-2" }',
          '"modelHosts": { "glm-5.3-flash": "crusoe-7", "glm-5.3-flash-deep": "crusoe-7", "glm-5.3-flash-c2": "crusoe-2" }',
        ),
      );
      yield* seedRunningTurn("t-c7-a", "glm-5.3-flash", "running");
      yield* seedRunningTurn("t-c7-alias", "glm-5.3-flash-deep", "running");
      const roles = yield* OrchestrationRoles;
      // crusoe-7 reads 2 (flash + deep alias), crusoe-2 reads 0.
      const resolved = yield* roles.resolve("implement");
      assert.strictEqual(resolved.model, "glm-5.3-flash-c2");
    }).pipe(Effect.provide(rolesLayer)),
  );

  it.effect("scopes load to the role's provider instance", () =>
    Effect.gen(function* () {
      // Another instance serves the same slugs and is saturated on the head
      // candidate. A slug-only load query would see that load and move this
      // role off its head; the routing instanceId is part of the key, so the
      // role's own instance reads flash=0 and c2=1 and the head wins.
      yield* writeRolesFile(CANDIDATE_ROLES_JSON);
      yield* seedRunningTurn("t-open-a", "glm-5.3-flash", "running", "opencode");
      yield* seedRunningTurn("t-open-b", "glm-5.3-flash", "running", "opencode");
      yield* seedRunningTurn("t-open-c", "glm-5.3-flash", "running", "opencode");
      yield* seedRunningTurn("t-open-d", "glm-5.3-flash", "running", "opencode");
      yield* seedRunningTurn("t-open-e", "glm-5.3-flash", "running", "opencode");
      yield* seedRunningTurn("t-c2-a", "glm-5.3-flash-c2", "running");
      const roles = yield* OrchestrationRoles;
      const resolved = yield* roles.resolve("implement");
      assert.strictEqual(resolved.model, "glm-5.3-flash");
    }).pipe(Effect.provide(rolesLayer)),
  );

  it.effect("breaks a tie toward the earlier candidate", () =>
    Effect.gen(function* () {
      yield* writeRolesFile(CANDIDATE_ROLES_JSON);
      yield* seedRunningTurn("t-c2-a", "glm-5.3-flash-c2", "running");
      yield* seedRunningTurn("t-c7-a", "glm-5.3-flash", "running");
      const roles = yield* OrchestrationRoles;
      const resolved = yield* roles.resolve("implement");
      assert.strictEqual(resolved.model, "glm-5.3-flash");
    }).pipe(Effect.provide(rolesLayer)),
  );

  it.effect("falls back to the head when the projection is unreadable", () =>
    Effect.gen(function* () {
      yield* writeRolesFile(CANDIDATE_ROLES_JSON);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE projection_turns`;
      const roles = yield* OrchestrationRoles;
      const resolved = yield* roles.resolve("implement");
      assert.strictEqual(resolved.model, "glm-5.3-flash");
    }).pipe(Effect.provide(rolesLayer)),
  );

  it.effect("leaves a role without candidates exactly as authored", () =>
    Effect.gen(function* () {
      yield* writeRolesFile(CANDIDATE_ROLES_JSON);
      yield* seedRunningTurn("t-c2-a", "glm-5.3-flash-c2", "running");
      const roles = yield* OrchestrationRoles;
      const resolved = yield* roles.resolve("pinned");
      assert.strictEqual(resolved.model, "glm-5.3-flash-c2");
    }).pipe(Effect.provide(rolesLayer)),
  );

  it.effect("refuses candidates whose head disagrees with the role's model", () =>
    Effect.gen(function* () {
      yield* writeRolesFile(
        CANDIDATE_ROLES_JSON.replace(
          '"candidates": ["glm-5.3-flash", "glm-5.3-flash-c2"]',
          '"candidates": ["glm-5.3-flash-c2", "glm-5.3-flash"]',
        ),
      );
      const roles = yield* OrchestrationRoles;
      const failed = yield* roles.resolve("implement").pipe(Effect.flip);
      if (!isToolkitError(failed)) {
        return assert.fail(`expected a toolkit error, got ${String(failed)}`);
      }
      assert.strictEqual(failed.reason, "roles_config_missing");
    }).pipe(Effect.provide(rolesLayer)),
  );

  it.effect("refuses a candidate with no declared host", () =>
    Effect.gen(function* () {
      yield* writeRolesFile(
        CANDIDATE_ROLES_JSON.replace(
          '"modelHosts": { "glm-5.3-flash": "crusoe-7", "glm-5.3-flash-c2": "crusoe-2" }',
          '"modelHosts": { "glm-5.3-flash": "crusoe-7" }',
        ),
      );
      const roles = yield* OrchestrationRoles;
      const failed = yield* roles.resolve("implement").pipe(Effect.flip);
      if (!isToolkitError(failed)) {
        return assert.fail(`expected a toolkit error, got ${String(failed)}`);
      }
      assert.strictEqual(failed.reason, "roles_config_missing");
    }).pipe(Effect.provide(rolesLayer)),
  );
});
