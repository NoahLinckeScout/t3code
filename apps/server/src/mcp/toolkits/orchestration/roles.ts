/**
 * Role resolution for delegated work.
 *
 * A spawning agent names a *role* — what the child is for. Named roles in
 * `orchestration-roles.json` stay the capability abstraction: instructions,
 * canSpawn, deadlines, and a bound provider+model. That split is the point
 * for standing lanes — if every prompt named a vendor, swapping the backend
 * would mean editing prose across every thread.
 *
 * Models that already work in t3code (settings.json `providerInstances` plus
 * each instance's `customModels`) are also reachable as catalog keys
 * `instanceId/model`, so adding a model in one place makes it spawnable
 * without a new named role. The wire still has no `modelSelection` field;
 * the catalog is the same registry `t3-orchestrate --model-selection` uses.
 *
 * There are no default named roles. Absent roles config fails closed for
 * capability names. Catalog keys fail closed when the instance is missing,
 * disabled, or does not list the model.
 */
import {
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderOptionSelections,
  RuntimeMode,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { readCustomModelEntries } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../../config.ts";
import { OrchestrationToolkitError } from "./schemas.ts";

export const ROLES_CONFIG_FILENAME = "orchestration-roles.json";

export const RoleDefinition = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  /**
   * Per-provider model options, in the same shape a thread's `modelSelection`
   * carries. Some providers need one to route at all: an `opencode` thread
   * selects its agent here (`{"id": "agent", "value": "build"}`), and a spawn
   * that omits it does not get the provider's default so much as no choice.
   */
  options: Schema.optional(ProviderOptionSelections),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  enabled: Schema.optional(Schema.Boolean),
  /**
   * Whether a thread running in this role may itself spawn.
   *
   * Defaults to false. This is the capability that replaces policing prompt text
   * for routing violations: a role that cannot spawn cannot route work anywhere,
   * so there is nothing to detect after the fact.
   */
  canSpawn: Schema.optional(Schema.Boolean),
  /**
   * Wall-clock budget for a delegation in this role. Advisory: passing it
   * raises an alert rather than killing the child, because a slow model and a
   * hung one look identical from here and only one of them should be cut off.
   */
  deadlineMinutes: Schema.optional(Schema.Int),
  /** Extra contract text appended to the child's opening brief. */
  instructions: Schema.optional(Schema.String),
});
export type RoleDefinition = typeof RoleDefinition.Type;

export const RolesConfig = Schema.Struct({
  /** How deep a delegation chain may go before spawning is refused. */
  maxDepth: Schema.optional(Schema.Int),
  roles: Schema.Record(Schema.String, RoleDefinition),
});
export type RolesConfig = typeof RolesConfig.Type;

export const DEFAULT_MAX_DEPTH = 2;

/**
 * Split `instanceId/model` on the first `/` so model slugs that themselves
 * contain slashes (`opencode/self-hosted-glm53/glm-5.3-flash`) stay intact.
 * Named roles do not use `/`; a file role always wins on collision.
 */
export const parseCatalogRoleKey = (
  roleName: string,
): { readonly instanceId: string; readonly model: string } | undefined => {
  const separator = roleName.indexOf("/");
  if (separator <= 0 || separator === roleName.length - 1) {
    return undefined;
  }
  return {
    instanceId: roleName.slice(0, separator),
    model: roleName.slice(separator + 1),
  };
};

interface CatalogModel {
  readonly slug: string;
  readonly options: ProviderOptionSelections | undefined;
}

interface CatalogInstance {
  readonly instanceId: string;
  readonly enabled: boolean;
  readonly models: ReadonlyArray<CatalogModel>;
}

const optionsFromCustomModel = (
  capabilities: ReturnType<typeof readCustomModelEntries>[number]["capabilities"],
): ProviderOptionSelections | undefined => {
  if (capabilities === null) return undefined;
  const selections: Array<{ id: string; value: string | boolean }> = [];
  for (const descriptor of capabilities.optionDescriptors ?? []) {
    if (descriptor.currentValue !== undefined) {
      selections.push({ id: descriptor.id, value: descriptor.currentValue });
      continue;
    }
    if (descriptor.type === "select") {
      const fallback = descriptor.options.find((option) => option.isDefault)?.id;
      if (fallback !== undefined) {
        selections.push({ id: descriptor.id, value: fallback });
      }
    }
  }
  return selections.length > 0 ? selections : undefined;
};

const readEnvelopeEnabled = (value: unknown): boolean | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const enabled = (value as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

export const catalogInstancesFromSettings = (raw: unknown): ReadonlyArray<CatalogInstance> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  const instances = (raw as { readonly providerInstances?: unknown }).providerInstances;
  if (instances === null || typeof instances !== "object" || Array.isArray(instances)) {
    return [];
  }
  const catalog: CatalogInstance[] = [];
  for (const [instanceId, envelope] of Object.entries(instances)) {
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
      continue;
    }
    const config = (envelope as { readonly config?: unknown }).config;
    const configEnabled = readEnvelopeEnabled(config);
    const envelopeEnabled = readEnvelopeEnabled(envelope);
    const enabled = envelopeEnabled !== false && configEnabled !== false;
    const customModels =
      config !== null && typeof config === "object" && !Array.isArray(config)
        ? (config as { readonly customModels?: unknown }).customModels
        : undefined;
    catalog.push({
      instanceId,
      enabled,
      models: readCustomModelEntries(customModels).map((entry) => ({
        slug: entry.slug,
        options: optionsFromCustomModel(entry.capabilities),
      })),
    });
  }
  return catalog;
};

const catalogKeyList = (catalog: ReadonlyArray<CatalogInstance>): ReadonlyArray<string> =>
  catalog
    .filter((instance) => instance.enabled)
    .flatMap((instance) => instance.models.map((model) => `${instance.instanceId}/${model.slug}`))
    .sort();

export interface ResolvedRole {
  readonly name: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model: string;
  readonly options: ProviderOptionSelections | undefined;
  readonly deadlineMinutes: number | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly canSpawn: boolean;
  readonly instructions: string | undefined;
}

export interface OrchestrationRolesShape {
  readonly configPath: string;
  readonly maxDepth: Effect.Effect<number, OrchestrationToolkitError>;
  readonly resolve: (roleName: string) => Effect.Effect<ResolvedRole, OrchestrationToolkitError>;
  /** Whether a thread already running in `roleName` may spawn. Unknown roles cannot. */
  readonly canSpawnFrom: (
    roleName: string | undefined,
  ) => Effect.Effect<boolean, OrchestrationToolkitError>;
}

export class OrchestrationRoles extends Context.Service<
  OrchestrationRoles,
  OrchestrationRolesShape
>()("t3/mcp/toolkits/orchestration/roles/OrchestrationRoles") {}

const decodeConfig = Schema.decodeUnknownEffect(fromLenientJson(RolesConfig));

const makeOrchestrationRoles = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(config.stateDir, ROLES_CONFIG_FILENAME);

  const configMissing = (detail: string) =>
    new OrchestrationToolkitError({ reason: "roles_config_missing", detail });

  /**
   * Re-read per call rather than cache. Spawns are rare, and an operator who
   * fixes a role should not have to restart the server to see it take effect.
   */
  const load = Effect.fn("OrchestrationRoles.load")(function* () {
    const raw = yield* fs
      .readFileString(configPath)
      .pipe(
        Effect.mapError(() =>
          configMissing(
            `No delegation roles are configured at ${configPath}. Create it with {"roles": {"<name>": {"providerInstanceId": "<an instance from settings.json>", "model": "<model>"}}}. Roles are never guessed: provider instance ids are per-install, so defaulting one would silently choose a vendor.`,
          ),
        ),
      );
    return yield* decodeConfig(raw).pipe(
      Effect.mapError((cause) =>
        configMissing(`${configPath} does not match the roles schema: ${String(cause)}`),
      ),
    );
  });

  const loadCatalog = Effect.fn("OrchestrationRoles.loadCatalog")(function* () {
    const raw = yield* fs.readFileString(config.settingsPath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim() === "") {
      return [];
    }
    try {
      return catalogInstancesFromSettings(JSON.parse(raw) as unknown);
    } catch {
      return [];
    }
  });

  const resolveFromCatalog = Effect.fn("OrchestrationRoles.resolveFromCatalog")(function* (
    roleName: string,
    namedRoles: ReadonlyArray<string>,
  ) {
    const catalog = yield* loadCatalog();
    const reachable = catalogKeyList(catalog);
    const named = namedRoles.length > 0 ? namedRoles.join(", ") : "(none)";
    const catalogHint =
      reachable.length > 0
        ? ` Catalog models (instanceId/model): ${reachable.join(", ")}.`
        : " No catalog models are configured in settings.json providerInstances.*.config.customModels.";
    const key = parseCatalogRoleKey(roleName);
    if (key === undefined) {
      return yield* new OrchestrationToolkitError({
        reason: "role_not_found",
        detail: `Role ${roleName} is not configured. Configured roles: ${named}.${catalogHint}`,
      });
    }
    const instance = catalog.find((entry) => entry.instanceId === key.instanceId);
    if (instance === undefined) {
      return yield* new OrchestrationToolkitError({
        reason: "role_not_found",
        detail: `Role ${roleName} is not a named role or a configured catalog model. Configured roles: ${named}.${catalogHint}`,
      });
    }
    if (!instance.enabled) {
      return yield* new OrchestrationToolkitError({
        reason: "role_disabled",
        detail: `Provider instance ${key.instanceId} is disabled in ${config.settingsPath}.`,
      });
    }
    const model = instance.models.find((entry) => entry.slug === key.model);
    if (model === undefined) {
      return yield* new OrchestrationToolkitError({
        reason: "role_not_found",
        detail: `Model ${key.model} is not in the ${key.instanceId} catalog. Configured roles: ${named}.${catalogHint}`,
      });
    }
    return {
      name: roleName,
      providerInstanceId: ProviderInstanceId.make(key.instanceId),
      model: model.slug,
      options: model.options,
      deadlineMinutes: undefined,
      runtimeMode: "full-access",
      interactionMode: "default",
      canSpawn: false,
      instructions: undefined,
    } satisfies ResolvedRole;
  });

  const resolve: OrchestrationRolesShape["resolve"] = Effect.fn("OrchestrationRoles.resolve")(
    function* (roleName) {
      const loaded = yield* load();
      const definition = loaded.roles[roleName];
      if (!definition) {
        return yield* resolveFromCatalog(roleName, Object.keys(loaded.roles).sort());
      }
      if (definition.enabled === false) {
        return yield* new OrchestrationToolkitError({
          reason: "role_disabled",
          detail: `Role ${roleName} is disabled in ${configPath}.`,
        });
      }
      return {
        name: roleName,
        providerInstanceId: definition.providerInstanceId,
        model: definition.model,
        options: definition.options,
        deadlineMinutes: definition.deadlineMinutes,
        runtimeMode: definition.runtimeMode ?? "full-access",
        interactionMode: definition.interactionMode ?? "default",
        canSpawn: definition.canSpawn ?? false,
        instructions: definition.instructions,
      } satisfies ResolvedRole;
    },
  );

  const canSpawnFrom: OrchestrationRolesShape["canSpawnFrom"] = Effect.fn(
    "OrchestrationRoles.canSpawnFrom",
  )(function* (roleName) {
    // A thread with no delegation record is operator-started, so it spawns.
    // Only a thread that is itself a child is restricted by its role.
    if (roleName === undefined) return true;
    const loaded = yield* load();
    return loaded.roles[roleName]?.canSpawn ?? false;
  });

  const maxDepth = load().pipe(Effect.map((loaded) => loaded.maxDepth ?? DEFAULT_MAX_DEPTH));

  return OrchestrationRoles.of({ configPath, maxDepth, resolve, canSpawnFrom });
});

export const layer = Layer.effect(OrchestrationRoles, makeOrchestrationRoles);
