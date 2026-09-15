/**
 * Role resolution for delegated work.
 *
 * A spawning agent names a *role* — what the child is for. This file is the only
 * place that turns a role into a provider instance and model. That split is the
 * point: if the tool call named a provider, every prompt in the system would
 * start encoding one vendor's name, and swapping the backend would mean editing
 * prose across every thread. Roles keep provider choice an operator decision.
 *
 * There are no defaults. `providerInstanceId` is a per-install, user-configured
 * value — the same string means different things on two machines — so guessing
 * one would be guessing which vendor gets the work. Absent config fails closed.
 */
import {
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderOptionSelections,
  RuntimeMode,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
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

  const resolve: OrchestrationRolesShape["resolve"] = Effect.fn("OrchestrationRoles.resolve")(
    function* (roleName) {
      const loaded = yield* load();
      const definition = loaded.roles[roleName];
      if (!definition) {
        const known = Object.keys(loaded.roles).sort();
        return yield* new OrchestrationToolkitError({
          reason: "role_not_found",
          detail: `Role ${roleName} is not configured. Configured roles: ${known.length > 0 ? known.join(", ") : "(none)"}.`,
        });
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
