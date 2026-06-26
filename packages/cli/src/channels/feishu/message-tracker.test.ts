import { describe, expect, test } from "bun:test";
import { FeishuMessageProgressTracker } from "./message-tracker.js";

describe("FeishuMessageProgressTracker", () => {
  test("stores structured progress events on the active message and session", () => {
    let now = 1000;
    const tracker = new FeishuMessageProgressTracker({
      accountId: "wudonghao",
      now: () => now,
    });

    tracker.start({
      messageId: "om_1",
      conversationKey: "dm:ou_1",
      chatKind: "direct",
      senderName: "东吴",
      preview: "查一下文件",
      imageCount: 0,
      fileCount: 1,
    });
    now = 1200;
    tracker.appendProgressEvent("dm:ou_1", {
      type: "tool_start",
      name: "Read",
      input: { file_path: "src/a.ts" },
    });
    now = 1300;
    tracker.appendProgressEvent("dm:ou_1", {
      type: "assistant_text",
      text: "我看完了。",
    });

    const [message] = tracker.list();
    expect(message.progressEvents).toEqual([
      {
        at: 1200,
        type: "tool_start",
        name: "Read",
        input: { file_path: "src/a.ts" },
      },
      {
        at: 1300,
        type: "assistant_text",
        text: "我看完了。",
      },
    ]);

    const [session] = tracker.listSessions();
    expect(session.progressEvents).toEqual(message.progressEvents);
    expect(session.messages[0].progressEvents).toEqual(message.progressEvents);
  });
});
