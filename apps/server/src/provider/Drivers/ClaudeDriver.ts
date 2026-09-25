/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import {
  ClaudeSettings,
  defaultInstanceIdForDriver,
  type CustomModelSetting,
  ProviderDriverKind,
  type ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import { makeClaudeScopedLimitNames } from "../Layers/claudeUsageLimits.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
} from "../Layers/ClaudeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { resolveClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import * as ModelManifest from "../ModelManifest.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeClaudeCapabilitiesCacheKey, makeClaudeContinuationGroupKey } from "./ClaudeHome.ts";
import { discoverClaudeSkills } from "./ClaudeSkills.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

/**
 * Resolve the instance's current `ClaudeSettings` from a `ServerSettings`
 * snapshot: the explicit `providerInstances` entry when one exists, else the
 * legacy `providers.claudeAgent` mirror — the same origin
 * `deriveProviderInstanceConfigMap` synthesizes the instance envelope from —
 * else the config the instance was built with. A malformed explicit config
 * falls back rather than failing: the registry surfaces decode errors through
 * its own unavailable bucket, and this read only feeds live model scoping and
 * snapshot probes.
 */
export const resolveLiveClaudeSettings = (input: {
  readonly settings: ServerSettings;
  readonly instanceId: ProviderInstanceId;
  readonly fallback: ClaudeSettings;
}): Effect.Effect<ClaudeSettings> =>
  Effect.gen(function* () {
    const explicit = input.settings.providerInstances[input.instanceId];
    if (explicit !== undefined) {
      const decoded = yield* Schema.decodeUnknownEffect(ClaudeSettings)(
        explicit.config ?? decodeClaudeSettings({}),
      ).pipe(Effect.option);
      if (Option.isNone(decoded)) {
        return input.fallback;
      }
      // For a normalized explicit instance `enabled` lives on the envelope and
      // is stripped from `config`, so the decoded settings alone report the
      // schema default (enabled) even when the instance is disabled — and this
      // read feeds the health probe and the managed snapshot, which would run
      // a disabled instance. Apply the same precedence the registry uses.
      return {
        ...decoded.value,
        enabled: resolveProviderInstanceEnabled({
          driver: DRIVER_KIND,
          enabled: explicit.enabled,
          config: explicit.config,
        }),
      };
    }
    if (input.instanceId === defaultInstanceIdForDriver(DRIVER_KIND)) {
      return input.settings.providers.claudeAgent;
    }
    return input.fallback;
  });

const stripCustomModels = (config: unknown): unknown => {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return config;
  }
  const { customModels: _customModels, ...rest } = config as Record<string, unknown>;
  return rest;
};

/**
 * A customModels add/remove only changes which models NEW sessions can
 * select; in-flight sessions keep their process and their model. Everything
 * else in the config shapes the session process and needs a rebuild — which
 * closes the instance scope and force-stops every session it is running.
 */
export const claudeConfigDeltaSparesSessions = (previous: unknown, next: unknown): boolean =>
  Equal.equals(stripCustomModels(previous), stripCustomModels(next));

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ModelManifest.ModelManifest
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  configChangeSparesSessions: claudeConfigDeltaSparesSessions,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd } = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const modelManifest = yield* ModelManifest.ModelManifest;
      const modelCatalog = modelManifest.current.pipe(Effect.map(resolveClaudeModelCatalog));
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
      } satisfies ClaudeSettings;
      // Live settings read: customModels changes must reach NEW sessions and
      // the model list without a rebuild. A rebuild closes the instance scope
      // and force-stops every in-flight session ("Session stopped."), which
      // is why the registry spares customModels-only deltas
      // (`configChangeSparesSessions` below) — that spare is only correct if
      // the delta is actually delivered, so everything that consumes
      // customModels re-resolves it from settings instead of the captured
      // config. binaryPath/homePath stay construction-time: they shape the
      // session process, and changing them rebuilds the instance.
      const liveSettings = serverSettings.getSettings.pipe(
        Effect.flatMap((settings) =>
          resolveLiveClaudeSettings({ settings, instanceId, fallback: effectiveConfig }),
        ),
        Effect.orElseSucceed(() => effectiveConfig),
      );
      const liveCustomModels: Effect.Effect<ReadonlyArray<CustomModelSetting>> = liveSettings.pipe(
        Effect.map((settings) => settings.customModels),
      );
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(effectiveConfig);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      // One per instance: the status probe writes the model-scoped bucket
      // names it saw, the adapter reads them to place turn-driven events.
      const scopedLimitNames = yield* makeClaudeScopedLimitNames;
      const adapterOptions = {
        instanceId,
        environment: processEnv,
        modelCatalog,
        customModels: liveCustomModels,
        scopedLimitNames,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      };
      const adapter = yield* makeClaudeAdapter(effectiveConfig, adapterOptions);
      const textGeneration = yield* makeClaudeTextGeneration(
        effectiveConfig,
        processEnv,
        modelCatalog,
        liveCustomModels,
      );

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          probeClaudeCapabilities(effectiveConfig, processEnv, cwd).pipe(
            Effect.provideService(Path.Path, path),
          ),
      });
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(effectiveConfig, cwd);

      // Start the TTL-gated refresh without delaying provider readiness. The
      // next check observes a remote manifest after the background fetch lands.
      const checkProvider = modelManifest.refreshInBackground.pipe(
        Effect.andThen(
          modelManifest.current.pipe(
            Effect.flatMap((manifest) =>
              liveSettings.pipe(
                Effect.flatMap((settings) =>
                  checkClaudeProviderStatus(
                    settings,
                    () => Cache.get(capabilitiesProbeCache, capabilitiesCacheKey),
                    processEnv,
                    cwd,
                    resolveClaudeModelCatalog(manifest),
                    scopedLimitNames,
                  ),
                ),
              ),
            ),
            Effect.map(stampIdentity),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      // The snapshot's model list must follow settings edits in place: a
      // customModels delta no longer rebuilds the instance (see
      // `configChangeSparesSessions`), so the managed provider detects the
      // change through this live source and re-probes with the fresh config.
      const snapshotSettings = {
        getSettings: serverSettings.getSettings.pipe(
          Effect.flatMap((settings) =>
            resolveLiveClaudeSettings({ settings, instanceId, fallback: effectiveConfig }).pipe(
              Effect.map((provider) => ({
                provider,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              })),
            ),
          ),
        ),
        streamSettings: serverSettings.streamChanges.pipe(
          Stream.mapEffect((settings) =>
            resolveLiveClaudeSettings({ settings, instanceId, fallback: effectiveConfig }).pipe(
              Effect.map((provider) => ({
                provider,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              })),
            ),
          ),
        ),
      };
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          modelManifest.current.pipe(
            Effect.flatMap((manifest) =>
              makePendingClaudeProvider(settings.provider, resolveClaudeModelCatalog(manifest)),
            ),
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const snapshotForCwd = (cwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverClaudeSkills(effectiveConfig, cwd, processEnv),
            ]).pipe(
              Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
