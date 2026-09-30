import {
  type ClientOrchestrationCommand,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";

// Claude's model list is complete before any probe runs: the manifest's
// built-ins plus the user's customModels. The other drivers list catalogs that
// an account probe fills in, and those are empty while the probe is pending,
// so checking them would reject real models at startup.
const CHECKED_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set([
  ProviderDriverKind.make("claudeAgent"),
]);

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

/**
 * Name the first model in `command` that its provider instance does not list,
 * or return null. A caller that asks for a model the instance cannot run gets
 * an error instead of a thread that silently runs something else.
 */
export function findUnknownModelSelection(
  command: ClientOrchestrationCommand,
  providers: ReadonlyArray<ServerProvider>,
): string | null {
  for (const selection of commandModelSelections(command)) {
    const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
    if (!provider || !CHECKED_DRIVERS.has(provider.driver)) continue;
    if (resolveSelectableModel(provider.driver, selection.model, provider.models) !== null) {
      continue;
    }
    return `Provider instance '${selection.instanceId}' has no model '${selection.model}'. Add it to that instance's customModels or pick a listed model.`;
  }
  return null;
}
