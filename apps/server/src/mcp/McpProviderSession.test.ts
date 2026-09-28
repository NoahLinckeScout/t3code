import { describe, expect, it } from "vite-plus/test";
import { withAgentDeviceEnvironment } from "./McpProviderSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });

  it("stamps the session's own thread id for attribution and watcher arming", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/usr/bin", PROVIDER_KEY: "fixture" },
      undefined,
      { threadId: "0c45aa1a-6d29-4a30-a4d0-6a9aa6ab8b30" },
    );
    expect(environment).toEqual({
      PATH: "/usr/bin",
      PROVIDER_KEY: "fixture",
      T3_THREAD_ID: "0c45aa1a-6d29-4a30-a4d0-6a9aa6ab8b30",
      CODEX_THREAD_ID: "0c45aa1a-6d29-4a30-a4d0-6a9aa6ab8b30",
    });
  });

  it("keeps the device PATH shim in front of the thread identity variables", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
        },
      },
      { threadId: "0c45aa1a-6d29-4a30-a4d0-6a9aa6ab8b30" },
    );
    expect(environment.PATH).toBe("/t3/device/bin:/provider/bin");
    expect(environment.T3_THREAD_ID).toBe("0c45aa1a-6d29-4a30-a4d0-6a9aa6ab8b30");
  });

  it("leaves the base env untouched when no identity was supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined, {})).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
  });
});
