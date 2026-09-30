import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ClientOrchestrationCommand,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findUnknownModelSelection } from "./modelAvailability.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const cursor = ProviderInstanceId.make("cursor");

function provider(
  instanceId: ProviderInstanceId,
  driver: string,
  slugs: ReadonlyArray<string>,
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-30T00:00:00.000Z",
    models: slugs.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
      ...(slug === "claude-fable-5-1" ? { aliases: ["fable"] } : {}),
    })),
    slashCommands: [],
    skills: [],
  };
}

const providers = [
  provider(claude, "claudeAgent", ["claude-fable-5-1", "glm-5.3-flash"]),
  provider(cursor, "cursor", []),
];

const turnStart = (
  modelSelection: { instanceId: ProviderInstanceId; model: string } | undefined,
  bootstrapModel?: string,
): ClientOrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make("cmd"),
  threadId: ThreadId.make("thread"),
  message: { messageId: MessageId.make("msg"), role: "user", text: "hi", attachments: [] },
  ...(modelSelection ? { modelSelection } : {}),
  ...(bootstrapModel
    ? {
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project"),
            title: "t",
            modelSelection: { instanceId: claude, model: bootstrapModel },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-09-30T00:00:00.000Z",
          },
        },
      }
    : {}),
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-09-30T00:00:00.000Z",
});

describe("findUnknownModelSelection", () => {
  it("names a Claude model the instance does not list", () => {
    expect(
      findUnknownModelSelection(
        turnStart({ instanceId: claude, model: "glm-5.3-flash-or" }),
        providers,
      ),
    ).toContain("no model 'glm-5.3-flash-or'");
  });

  it("accepts listed slugs and their aliases", () => {
    expect(
      findUnknownModelSelection(
        turnStart({ instanceId: claude, model: "glm-5.3-flash" }),
        providers,
      ),
    ).toBeNull();
    expect(
      findUnknownModelSelection(turnStart({ instanceId: claude, model: "fable" }), providers),
    ).toBeNull();
  });

  it("checks the bootstrap thread's model too", () => {
    expect(
      findUnknownModelSelection(turnStart(undefined, "glm-5.3-flash-or"), providers),
    ).toContain("glm-5.3-flash-or");
  });

  it("checks a model change carried by thread.meta.update", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.meta.update",
      commandId: CommandId.make("cmd"),
      threadId: ThreadId.make("thread"),
      modelSelection: { instanceId: claude, model: "claude-opus-9" },
    };
    expect(findUnknownModelSelection(command, providers)).toContain("claude-opus-9");
  });

  it("leaves probed catalogs and unknown instances to the provider", () => {
    expect(
      findUnknownModelSelection(turnStart({ instanceId: cursor, model: "anything" }), providers),
    ).toBeNull();
    expect(
      findUnknownModelSelection(
        turnStart({ instanceId: ProviderInstanceId.make("gone"), model: "anything" }),
        providers,
      ),
    ).toBeNull();
  });
});
