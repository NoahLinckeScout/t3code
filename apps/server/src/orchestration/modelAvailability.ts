import {
  type ClientOrchestrationCommand,
  defaultInstanceIdForDriver,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  readCustomModelEntries,
  resolveSelectableModel,
  type CustomModelDefinition,
} from "@t3tools/shared/model";

// Claude's model list is complete before any probe runs: the manifest's
// built-ins plus the user's customModels. The other drivers list catalogs that
// an account probe fills in, and those are empty while the probe is pending,
// so checking them would reject real models at startup.
const CHECKED_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set([
  ProviderDriverKind.make("claudeAgent"),
]);

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

function commandModelSelections(
  command: ClientOrchestrationCommand,
): ReadonlyArray<ModelSelection> {
  switch (command.type) {
    case "thread.create":
      return [command.modelSelection];
    case "thread.meta.update":
      return command.modelSelection ? [command.modelSelection] : [];
    case "thread.turn.start":
      return [command.modelSelection, command.bootstrap?.createThread?.modelSelection].filter(
        (selection): selection is ModelSelection => selection !== undefined,
      );
    default:
      return [];
  }
}

const readConfigCustomModels = (config: unknown): unknown =>
  config !== null && typeof config === "object" && !Array.isArray(config)
    ? (config as { customModels?: unknown }).customModels
    : undefined;

/**
 * The custom model rows a settings snapshot currently grants each Claude
 * instance, keyed by instance id. Resolves the same instance set
 * `deriveProviderInstanceConfigMap` does — explicit `providerInstances`
 * entries over the legacy `providers.claudeAgent` mirror for the default
 * instance — because that is the input the registry aggregates from.
 */
export function claudeCustomModelsByInstance(
  settings: ServerSettings | null | undefined,
): ReadonlyMap<ProviderInstanceId, ReadonlyArray<CustomModelDefinition>> {
  const byInstance = new Map<ProviderInstanceId, ReadonlyArray<CustomModelDefinition>>();
  if (!settings) {
    return byInstance;
  }
  const legacyEntries = readCustomModelEntries(settings.providers.claudeAgent.customModels);
  if (legacyEntries.length > 0) {
    byInstance.set(defaultInstanceIdForDriver(CLAUDE_DRIVER), legacyEntries);
  }
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    if (instance.driver !== CLAUDE_DRIVER) {
      continue;
    }
    byInstance.set(
      ProviderInstanceId.make(instanceId),
      readCustomModelEntries(readConfigCustomModels(instance.config)),
    );
  }
  return byInstance;
}

/**
 * Name the first model in `command` that its provider instance does not list,
 * or return null. A caller that asks for a model the instance cannot run gets
 * an error instead of a thread that silently runs something else.
 *
 * `settingsModels` carries the custom models the current settings grant each
 * instance. The aggregated provider snapshot can trail a just-saved settings
 * edit (customModels-only changes deliberately spare the instance a rebuild),
 * so a model granted by settings is accepted even before the snapshot has
 * synced. The same resolver decides both ways, so a selection is accepted
 * identically in either state.
 */
export function findUnknownModelSelection(
  command: ClientOrchestrationCommand,
  providers: ReadonlyArray<ServerProvider>,
  settingsModels: ReadonlyMap<ProviderInstanceId, ReadonlyArray<CustomModelDefinition>> = new Map(),
): string | null {
  for (const selection of commandModelSelections(command)) {
    const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
    if (!provider || !CHECKED_DRIVERS.has(provider.driver)) continue;
    if (resolveSelectableModel(provider.driver, selection.model, provider.models) !== null) {
      continue;
    }
    const settingsOptions = settingsModels.get(selection.instanceId) ?? [];
    if (resolveSelectableModel(provider.driver, selection.model, settingsOptions) !== null) {
      continue;
    }
    return `Provider instance '${selection.instanceId}' has no model '${selection.model}'. Add it to that instance's customModels or pick a listed model.`;
  }
  return null;
}
