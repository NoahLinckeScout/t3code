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

import { ServerConfig } from "../../../config.ts";
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
);

const writeFixtures = Effect.fn("rolesTest.writeFixtures")(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(`${config.stateDir}/orchestration-roles.json`, NAMED_ROLES_JSON);
  yield* fs.writeFileString(config.settingsPath, SETTINGS_JSON);
});

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
