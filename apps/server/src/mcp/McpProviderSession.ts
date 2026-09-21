import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the session's thread identity and the device variables applied over `base`. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
  threadIdentity?: { readonly threadId?: string },
): NodeJS.ProcessEnv {
  // The session's own thread id, so tool subprocesses the model spawns can
  // attribute GitHub writes and arm durable watchers (e.g. `codex-agentd
  // run-local` defaults --thread-id from CODEX_THREAD_ID) without a manual
  // export step. Both names are set because consumers read different vars.
  const identity = threadIdentity?.threadId
    ? {
        T3_THREAD_ID: threadIdentity.threadId,
        CODEX_THREAD_ID: threadIdentity.threadId,
      }
    : {};
  const extra = config?.agentDeviceEnvironment;
  if (!extra) {
    return Object.keys(identity).length > 0 ? { ...base, ...identity } : base;
  }
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...identity,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
