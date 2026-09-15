import { describe, expect, it } from "vite-plus/test";

import { MCP_SERVER_NAME, mcpAttachmentOutcome } from "./openCodeMcpAttachment.ts";

/**
 * Every payload here was captured from a real `opencode serve` 1.18.21 by
 * POSTing the same body the adapter sends. All of them came back HTTP 200.
 */
describe("mcpAttachmentOutcome", () => {
  it("accepts a connected server", () => {
    const outcome = mcpAttachmentOutcome({ [MCP_SERVER_NAME]: { status: "connected" } });
    expect(outcome.connected).toBe(true);
    expect(outcome.status).toBe("connected");
  });

  it("reports the auth rejection that a bad credential produces", () => {
    // Verbatim from OpenCode when pointed at a live t3 /mcp with a bogus token.
    const outcome = mcpAttachmentOutcome({
      [MCP_SERVER_NAME]: { status: "failed", error: "SSE error: Non-200 status code (401)" },
    });
    expect(outcome.connected).toBe(false);
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("401");
  });

  it("reports an unreachable endpoint", () => {
    const outcome = mcpAttachmentOutcome({
      [MCP_SERVER_NAME]: {
        status: "failed",
        error: "SSE error: Unable to connect. Is the computer able to access the url?",
      },
    });
    expect(outcome.connected).toBe(false);
    expect(outcome.detail).toContain("Unable to connect");
  });

  it("treats a payload that never mentions our server as a failure", () => {
    // Silence is the dangerous case: it is what "success" looked like before.
    const outcome = mcpAttachmentOutcome({ "some-other-server": { status: "connected" } });
    expect(outcome.connected).toBe(false);
    expect(outcome.status).toBe("absent");
  });

  it("does not mistake a missing or malformed body for success", () => {
    for (const payload of [undefined, null, "", 0, [], { [MCP_SERVER_NAME]: null }]) {
      expect(mcpAttachmentOutcome(payload).connected).toBe(false);
    }
  });

  it("surfaces an unknown status rather than assuming it is fine", () => {
    const outcome = mcpAttachmentOutcome({ [MCP_SERVER_NAME]: { status: "pending" } });
    expect(outcome.connected).toBe(false);
    expect(outcome.status).toBe("pending");
    expect(outcome.detail).toBe("(none reported)");
  });
});
