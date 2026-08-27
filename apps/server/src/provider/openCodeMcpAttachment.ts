/**
 * Reading whether OpenCode actually accepted the MCP server t3 asked it to add.
 *
 * `POST /mcp` answers HTTP 200 whether or not OpenCode could reach the server,
 * and puts the real outcome in the body:
 *
 *     {"t3-code":{"status":"connected"}}
 *     {"t3-code":{"status":"failed","error":"SSE error: Non-200 status code (401)"}}
 *     {"t3-code":{"status":"failed","error":"SSE error: Unable to connect. Is the computer able to access the url?"}}
 *
 * The adapter called this through `Effect.tryPromise`, which only catches a
 * rejected promise, so a refusal arrived as a success. The consequence is not
 * subtle: every toolkit t3 injects — preview and orchestration alike — is
 * invisible to that session's model, and the only symptom is the agent replying
 * that it has no such tool. Nothing was logged on the server side.
 */

/** The name t3 registers its own MCP server under, inside OpenCode. */
export const MCP_SERVER_NAME = "t3-code";

export interface McpAttachmentOutcome {
  readonly connected: boolean;
  /** OpenCode's own status word, or `absent` when it said nothing about us. */
  readonly status: string;
  /** OpenCode's own error text, verbatim, for the operator to act on. */
  readonly detail: string;
}

export const mcpAttachmentOutcome = (result: unknown): McpAttachmentOutcome => {
  const entry =
    typeof result === "object" && result !== null
      ? (result as Record<string, unknown>)[MCP_SERVER_NAME]
      : undefined;
  if (typeof entry !== "object" || entry === null) {
    return {
      connected: false,
      status: "absent",
      detail: "OpenCode did not report on the server t3 asked it to add.",
    };
  }
  const { status, error } = entry as { readonly status?: unknown; readonly error?: unknown };
  return {
    connected: status === "connected",
    status: status === undefined ? "absent" : String(status),
    detail: error === undefined ? "(none reported)" : String(error),
  };
};
