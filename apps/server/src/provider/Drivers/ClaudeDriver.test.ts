import {
  ClaudeSettings,
  type ClaudeSettings as ClaudeSettingsType,
  ProviderDriverKind,
  ServerSettings,
  type ServerSettings as ServerSettingsType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { claudeConfigDeltaSparesSessions, resolveLiveClaudeSettings } from "./ClaudeDriver.ts";

const claudeSettings = (overrides: Partial<ClaudeSettingsType>): ClaudeSettingsType =>
  ({
    enabled: false,
    binaryPath: "claude",
    homePath: "",
    customModels: [],
    launchArgs: "",
    autoCompactWindow: "",
    ...overrides,
  }) as ClaudeSettingsType;

const claudeInstanceEntry = (config: unknown) => ({
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: false,
  config,
});

// Decoding `{}` through the real schema fills every `withDecodingDefault`
// (providers.claudeAgent → {}, providerInstances → {}), so the fixture
// matches what the server reads.
const emptySettings = Schema.decodeSync(ServerSettings)({}) as ServerSettingsType;

describe("claudeConfigDeltaSparesSessions", () => {
  it("spares a customModels add", () => {
    expect(
      claudeConfigDeltaSparesSessions(
        claudeSettings({ customModels: [] }),
        claudeSettings({ customModels: ["c8"] }),
      ),
    ).toBe(true);
  });

  it("spares a customModels removal", () => {
    expect(
      claudeConfigDeltaSparesSessions(
        claudeSettings({ customModels: [{ slug: "c8" }] }),
        claudeSettings({ customModels: [] }),
      ),
    ).toBe(true);
  });

  it("does not spare a binaryPath change", () => {
    expect(
      claudeConfigDeltaSparesSessions(
        claudeSettings({ binaryPath: "claude" }),
        claudeSettings({ binaryPath: "/opt/claude/bin/claude" }),
      ),
    ).toBe(false);
  });

  it("does not spare an enabled flip", () => {
    expect(
      claudeConfigDeltaSparesSessions(
        claudeSettings({ enabled: true }),
        claudeSettings({ enabled: false }),
      ),
    ).toBe(false);
  });

  it("tolerates non-object configs", () => {
    expect(claudeConfigDeltaSparesSessions(undefined, undefined)).toBe(true);
    expect(claudeConfigDeltaSparesSessions(undefined, claudeSettings({}))).toBe(false);
  });
});

describe("resolveLiveClaudeSettings", () => {
  const claudeAgentId = "claudeAgent" as Parameters<
    typeof resolveLiveClaudeSettings
  >[0]["instanceId"];
  const fallback = claudeSettings({ customModels: ["fallback-model"] });

  const run = (settings: ServerSettings, instanceId = claudeAgentId) =>
    Effect.runPromise(resolveLiveClaudeSettings({ settings, instanceId, fallback }));

  it("decodes the explicit providerInstances entry", async () => {
    const settings = {
      ...emptySettings,
      providerInstances: {
        [claudeAgentId]: claudeInstanceEntry(claudeSettings({ customModels: ["c8"] })),
      },
    } as ServerSettings;
    const resolved = await run(settings);
    expect(resolved.customModels).toEqual(["c8"]);
  });

  it("falls back when the explicit entry fails to decode", async () => {
    const settings = {
      ...emptySettings,
      providerInstances: {
        [claudeAgentId]: claudeInstanceEntry({ ...claudeSettings({}), customModels: "oops" }),
      },
    } as ServerSettings;
    const resolved = await run(settings);
    expect(resolved).toEqual(fallback);
  });

  it("reads the legacy providers mirror for the default instance id", async () => {
    const settings = {
      ...emptySettings,
      providers: {
        ...emptySettings.providers,
        claudeAgent: claudeSettings({ customModels: ["legacy-model"] }),
      },
    } as ServerSettings;
    const resolved = await run(settings);
    expect(resolved.customModels).toEqual(["legacy-model"]);
  });

  it("falls back for a non-default instance id with no explicit entry", async () => {
    const settings = {
      ...emptySettings,
      providers: {
        ...emptySettings.providers,
        claudeAgent: claudeSettings({ customModels: ["legacy-model"] }),
      },
    } as ServerSettings;
    const resolved = await run(settings, "claude_secondary" as typeof claudeAgentId);
    expect(resolved).toEqual(fallback);
  });
});
