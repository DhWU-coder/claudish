import { describe, expect, test } from "bun:test";
import {
  buildClaudeCodeInputForFeishu,
  extractImageKeys,
  parseFeishuMessageEvent,
  resolveConversationKey,
  shouldHandleMessage,
  stripBotMention,
} from "./events.js";

const botOpenId = "ou_bot";

function messageEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: {
      sender: {
        sender_id: { open_id: "ou_sender" },
        sender_type: "user",
      },
      message: {
        message_id: "om_1",
        chat_id: "oc_group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: `<at user_id="${botOpenId}">bot</at> hello` }),
        mentions: [{ id: { open_id: botOpenId }, name: "bot" }],
      },
      ...overrides,
    },
  };
}

describe("Feishu events", () => {
  test("extracts text message content", () => {
    const event = parseFeishuMessageEvent(messageEvent());

    expect(event?.messageType).toBe("text");
    expect(event?.text).toContain("hello");
  });

  test("extracts image keys", () => {
    const event = parseFeishuMessageEvent(
      messageEvent({
        message: {
          message_id: "om_2",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "image",
          content: JSON.stringify({ image_key: "img_v2_abc" }),
          mentions: [{ id: { open_id: botOpenId }, name: "bot" }],
        },
      })
    );

    expect(extractImageKeys(event)).toEqual(["img_v2_abc"]);
  });

  test("extracts post text, mentions, and embedded image keys", () => {
    const event = parseFeishuMessageEvent(
      messageEvent({
        message: {
          message_id: "om_post",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "post",
          content: JSON.stringify({
            content: [
              [
                { tag: "at", user_id: botOpenId, user_name: "bot" },
                { tag: "text", text: " 你看到了什么" },
                { tag: "img", image_key: "img_post_1" },
              ],
            ],
          }),
          mentions: [],
        },
      })
    );

    expect(event?.text).toContain(`<at user_id="${botOpenId}">bot</at>`);
    expect(stripBotMention(event?.text ?? "", event?.mentions ?? [], botOpenId)).toBe(
      "你看到了什么"
    );
    expect(extractImageKeys(event)).toEqual(["img_post_1"]);
    expect(shouldHandleMessage(event!, botOpenId)).toBe(true);
  });

  test("maps private chat to sender scoped conversation", () => {
    const event = parseFeishuMessageEvent(
      messageEvent({
        message: {
          message_id: "om_3",
          chat_id: "oc_dm",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
      })
    );

    expect(resolveConversationKey(event!)).toBe("dm:ou_sender");
  });

  test("maps group chat to shared group conversation", () => {
    const event = parseFeishuMessageEvent(messageEvent());

    expect(resolveConversationKey(event!)).toBe("group:oc_group");
  });

  test("group messages require bot mention", () => {
    const mentioned = parseFeishuMessageEvent(messageEvent());
    const silent = parseFeishuMessageEvent(
      messageEvent({
        message: {
          message_id: "om_4",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
          mentions: [],
        },
      })
    );

    expect(shouldHandleMessage(mentioned!, botOpenId)).toBe(true);
    expect(shouldHandleMessage(silent!, botOpenId)).toBe(false);
  });

  test("stripBotMention removes Feishu at markup", () => {
    expect(
      stripBotMention(
        `<at user_id="${botOpenId}">bot</at> hello`,
        [{ openId: botOpenId }],
        botOpenId
      )
    ).toBe("hello");
  });

  test("buildClaudeCodeInputForFeishu includes group sender label", () => {
    expect(
      buildClaudeCodeInputForFeishu({
        chatKind: "group",
        chatId: "oc_1",
        senderName: "Alice",
        text: "hello",
        imagePaths: [],
      })
    ).toBe("[Alice] hello\n");
  });

  test("buildClaudeCodeInputForFeishu uses default image prompt", () => {
    expect(
      buildClaudeCodeInputForFeishu({
        chatKind: "direct",
        chatId: "oc_1",
        senderName: "Alice",
        text: "",
        imagePaths: ["/tmp/a.png"],
      })
    ).toBe("请分析这张图片。\n/tmp/a.png\n");
  });

  test("buildClaudeCodeInputForFeishu includes text and image paths", () => {
    expect(
      buildClaudeCodeInputForFeishu({
        chatKind: "direct",
        chatId: "oc_1",
        senderName: "Alice",
        text: "describe",
        imagePaths: ["/tmp/a.png", "/tmp/b.jpg"],
      })
    ).toBe("describe\n/tmp/a.png\n/tmp/b.jpg\n");
  });
});
