import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  isQueuedMessageDue,
  joinRestoredQueuedPrompts,
  latestCompletedToolActivityId,
  useQueuedMessageStore,
  type QueuedComposerMessage,
} from "./queuedMessageStore";

function makeMessage(prompt: string): Omit<QueuedComposerMessage, "id"> {
  return {
    prompt,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    submissionIntent: "foreground",
    queuedAfterToolActivityId: null,
    createdAt: "2026-09-11T00:00:00.000Z",
  };
}

describe("queuedMessageStore", () => {
  beforeEach(() => {
    useQueuedMessageStore.setState({ queuesByThreadKey: {}, drainGenerationsByThreadKey: {} });
  });

  it("keeps messages in submission order per thread", () => {
    const { enqueue } = useQueuedMessageStore.getState();
    enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    enqueue("thread-b", makeMessage("other"));

    const queues = useQueuedMessageStore.getState().queuesByThreadKey;
    expect(queues["thread-a"]?.map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(queues["thread-b"]?.map((message) => message.prompt)).toEqual(["other"]);
  });

  it("take hands the message to exactly one caller", () => {
    const { enqueue, take } = useQueuedMessageStore.getState();
    const entry = enqueue("thread-a", makeMessage("first"));

    expect(take("thread-a", entry.id, null)?.prompt).toBe("first");
    expect(take("thread-a", entry.id, null)).toBeNull();
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-a"]).toBeUndefined();
  });

  it("take re-anchors the remaining messages to the current tool boundary", () => {
    const { enqueue, take } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));

    take("thread-a", first.id, "tool-2");

    const [second] = useQueuedMessageStore.getState().queuesByThreadKey["thread-a"] ?? [];
    expect(second?.queuedAfterToolActivityId).toBe("tool-2");
    expect(
      isQueuedMessageDue({ message: second!, phase: "running", latestToolActivityId: "tool-2" }),
    ).toBe(false);
  });

  it("remove keeps the other messages' anchors", () => {
    const { enqueue, remove } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", { ...makeMessage("first"), queuedAfterToolActivityId: "t1" });
    const second = enqueue("thread-a", makeMessage("second"));

    expect(remove("thread-a", second.id)?.prompt).toBe("second");
    expect(remove("thread-a", second.id)).toBeNull();
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-a"]).toEqual([first]);
  });

  it("holdAtFront returns a failed message to the head, held", () => {
    const { enqueue, take, holdAtFront } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    const taken = take("thread-a", first.id, "t1")!;

    holdAtFront("thread-a", taken);

    const queue = useQueuedMessageStore.getState().queuesByThreadKey["thread-a"] ?? [];
    expect(queue.map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(queue[0]?.holdUntilUserAction).toBe(true);
    expect(
      isQueuedMessageDue({ message: queue[0]!, phase: "ready", latestToolActivityId: null }),
    ).toBe(false);
  });

  it("drain empties one thread's queue in order", () => {
    const { enqueue, drain } = useQueuedMessageStore.getState();
    enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    enqueue("thread-b", makeMessage("other"));

    expect(drain("thread-a").map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(useQueuedMessageStore.getState().drainGenerationsByThreadKey["thread-a"]).toBe(1);
    expect(drain("thread-a")).toEqual([]);
    expect(useQueuedMessageStore.getState().drainGenerationsByThreadKey["thread-a"]).toBe(1);
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-b"]).toHaveLength(1);
  });

  it("a drain on one thread does not cancel another thread's in-flight send", () => {
    const { enqueue, drain } = useQueuedMessageStore.getState();
    enqueue("thread-a", makeMessage("a"));
    enqueue("thread-b", makeMessage("b"));

    // Thread A's send captured its generation at take time.
    const atTake = useQueuedMessageStore.getState().drainGenerationsByThreadKey["thread-a"] ?? 0;

    // Stop on thread B bumps only B's generation.
    drain("thread-b");
    expect(useQueuedMessageStore.getState().drainGenerationsByThreadKey["thread-a"] ?? 0).toBe(
      atTake,
    );

    // Stop on A's own thread must still cancel its in-flight send.
    drain("thread-a");
    expect(useQueuedMessageStore.getState().drainGenerationsByThreadKey["thread-a"]).not.toBe(
      atTake,
    );
  });
});

describe("joinRestoredQueuedPrompts", () => {
  it("appends restored prompts after the current draft by default", () => {
    expect(
      joinRestoredQueuedPrompts("current draft", [
        { prompt: " first " },
        { prompt: "" },
        { prompt: "second" },
      ]),
    ).toBe("current draft\n\nfirst\n\nsecond");
  });

  it("appends when no drain boundary was recorded (cannot tell draft from restored text)", () => {
    // Without the boundary recorded at Stop time the helper cannot tell the
    // user's own prose from Stop-restored text, so it appends rather than
    // displacing either.
    expect(
      joinRestoredQueuedPrompts("younger queued", [{ prompt: "older taken" }], "prepend"),
    ).toBe("younger queued\n\nolder taken");
  });

  it("returns only the restored text when the draft is empty", () => {
    expect(joinRestoredQueuedPrompts("   ", [{ prompt: "solo" }], "prepend")).toBe("solo");
  });

  it("inserts a late restore after the user's draft via the drain boundary", () => {
    // Draft C was typed while A's send was uploading; Stop restored B after C;
    // A arrives late and must land between C and B.
    expect(joinRestoredQueuedPrompts("C\n\nB", [{ prompt: "A" }], "prepend", "C")).toBe(
      "C\n\nA\n\nB",
    );
  });

  it("keeps the drain boundary when Stop restored nothing yet", () => {
    expect(joinRestoredQueuedPrompts("C", [{ prompt: "A" }], "prepend", "C")).toBe("C\n\nA");
  });

  it("appends instead of displacing prose edited after the drain", () => {
    // The user rewrote the draft after Stop; the boundary no longer matches,
    // so the late message goes last rather than splitting their text.
    expect(joinRestoredQueuedPrompts("wholly new draft", [{ prompt: "A" }], "prepend", "C")).toBe(
      "wholly new draft\n\nA",
    );
  });
});

describe("queued message dispatch timing", () => {
  const activities = [
    { id: "a1", kind: "tool.started", sequence: 1, createdAt: "2026-01-01T00:00:01Z" },
    { id: "a2", kind: "tool.completed", sequence: 2, createdAt: "2026-01-01T00:00:02Z" },
    { id: "a3", kind: "tool.updated", sequence: 3, createdAt: "2026-01-01T00:00:03Z" },
  ];

  it("finds the newest completed tool call by sequence, not position", () => {
    expect(latestCompletedToolActivityId(activities)).toBe("a2");
    expect(latestCompletedToolActivityId([])).toBeNull();
    expect(
      latestCompletedToolActivityId([
        { id: "late", kind: "tool.completed", sequence: 9, createdAt: "2026-01-01T00:00:09Z" },
        { id: "early", kind: "tool.completed", sequence: 4, createdAt: "2026-01-01T00:00:04Z" },
      ]),
    ).toBe("late");
  });

  it("waits mid-turn until a tool call finishes after the message was queued", () => {
    const message = { queuedAfterToolActivityId: "a2" };
    expect(isQueuedMessageDue({ message, phase: "running", latestToolActivityId: "a2" })).toBe(
      false,
    );
    expect(isQueuedMessageDue({ message, phase: "running", latestToolActivityId: "a4" })).toBe(
      true,
    );
  });

  it("never auto-sends a message held for user action", () => {
    const message = { queuedAfterToolActivityId: null, holdUntilUserAction: true };
    expect(isQueuedMessageDue({ message, phase: "ready", latestToolActivityId: "a4" })).toBe(false);
  });

  it("is due as soon as the turn is over, but not while a send is connecting", () => {
    const message = { queuedAfterToolActivityId: "a2" };
    expect(isQueuedMessageDue({ message, phase: "ready", latestToolActivityId: "a2" })).toBe(true);
    expect(isQueuedMessageDue({ message, phase: "connecting", latestToolActivityId: "a4" })).toBe(
      false,
    );
  });
});
