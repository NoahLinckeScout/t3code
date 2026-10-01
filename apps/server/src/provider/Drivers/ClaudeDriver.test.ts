import {
  ClaudeSettings,
  type ClaudeSettings as ClaudeSettingsType,
  ProviderDriverKind,
  ServerSettings,
  type ServerSettings as ServerSettingsType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { claudeConfigDeltaSparesSessions, resolveLiveClaudeSettings } from "./ClaudeDriver.ts";

const claudeSettings = (overrides: Partial<ClaudeSettingsType>): ClaudeSettingsType =>
  ({
    enabled: false,
    binaryPath: "claude",
    homePath: "",
    customModels: [],
    launchArgs: "",
    autoCompactWindow: "",
    autoCompactWindowByModel: {},
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
    resolveLiveClaudeSettings({ settings, instanceId, fallback });

  it.effect("decodes the explicit providerInstances entry", () =>
    Effect.gen(function* () {
      const settings = {
        ...emptySettings,
        providerInstances: {
          [claudeAgentId]: claudeInstanceEntry(claudeSettings({ customModels: ["c8"] })),
        },
      } as ServerSettings;
      const resolved = yield* run(settings);
      expect(resolved.customModels).toEqual(["c8"]);
    }),
  );

  it.effect("falls back when the explicit entry fails to decode", () =>
    Effect.gen(function* () {
      const settings = {
        ...emptySettings,
        providerInstances: {
          [claudeAgentId]: claudeInstanceEntry({ ...claudeSettings({}), customModels: "oops" }),
        },
      } as ServerSettings;
      const resolved = yield* run(settings);
      expect(resolved).toEqual(fallback);
    }),
  );

  it.effect("applies the envelope enabled flag to the decoded settings", () =>
    Effect.gen(function* () {
      // A normalized explicit instance carries `enabled` on the envelope with
      // the flag stripped from `config`; the decoded settings alone would
      // report the schema default and probe a disabled instance.
      const settings = {
        ...emptySettings,
        providerInstances: {
          [claudeAgentId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: false,
            config: claudeSettings({ enabled: true, customModels: ["c8"] }),
          },
        },
      } as ServerSettings;
      const resolved = yield* run(settings);
      expect(resolved.enabled).toBe(false);
      expect(resolved.customModels).toEqual(["c8"]);
    }),
  );

  it.effect("keeps a config-level disable winning over an envelope enable", () =>
    Effect.gen(function* () {
      const settings = {
        ...emptySettings,
        providerInstances: {
          [claudeAgentId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: claudeSettings({ enabled: false }),
          },
        },
      } as ServerSettings;
      const resolved = yield* run(settings);
      expect(resolved.enabled).toBe(false);
    }),
  );

  it.effect("reads the legacy providers mirror for the default instance id", () =>
    Effect.gen(function* () {
      const settings = {
        ...emptySettings,
        providers: {
          ...emptySettings.providers,
          claudeAgent: claudeSettings({ customModels: ["legacy-model"] }),
        },
      } as ServerSettings;
      const resolved = yield* run(settings);
      expect(resolved.customModels).toEqual(["legacy-model"]);
    }),
  );

  it.effect("falls back for a non-default instance id with no explicit entry", () =>
    Effect.gen(function* () {
      const settings = {
        ...emptySettings,
        providers: {
          ...emptySettings.providers,
          claudeAgent: claudeSettings({ customModels: ["legacy-model"] }),
        },
      } as ServerSettings;
      const resolved = yield* run(settings, "claude_secondary" as typeof claudeAgentId);
      expect(resolved).toEqual(fallback);
    }),
  );
});
