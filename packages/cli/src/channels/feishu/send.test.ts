import { describe, expect, test } from "bun:test";
import { sendFeishuText, splitFeishuText, type FeishuMessageClient } from "./send.js";
import { createSdkFeishuMessageClient } from "./send.js";

describe("Feishu send", () => {
  test("splitFeishuText chunks long text", () => {
    expect(splitFeishuText("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
  });

  test("sendFeishuText replies when message id is available", async () => {
    const calls: string[] = [];
    const client: FeishuMessageClient = {
      async replyText(input) {
        calls.push(`reply:${input.messageId}:${input.text}`);
      },
      async sendText(input) {
        calls.push(`send:${input.receiveId}:${input.text}`);
      },
    };

    await sendFeishuText(client, { replyToMessageId: "om_1", text: "hello" });

    expect(calls).toEqual(["reply:om_1:hello"]);
  });

  test("sendFeishuText sends by receive id when no reply id is available", async () => {
    const calls: string[] = [];
    const client: FeishuMessageClient = {
      async replyText(input) {
        calls.push(`reply:${input.messageId}:${input.text}`);
      },
      async sendText(input) {
        calls.push(`send:${input.receiveIdType}:${input.receiveId}:${input.text}`);
      },
    };

    await sendFeishuText(client, {
      receiveId: "oc_1",
      receiveIdType: "chat_id",
      text: "hello",
    });

    expect(calls).toEqual(["send:chat_id:oc_1:hello"]);
  });

  test("createSdkFeishuMessageClient uses Feishu v1 message APIs", async () => {
    const calls: unknown[] = [];
    const client = createSdkFeishuMessageClient({
      im: {
        v1: {
          message: {
            async reply(payload: unknown) {
              calls.push(["reply", payload]);
            },
            async create(payload: unknown) {
              calls.push(["create", payload]);
            },
          },
        },
      },
    });

    await client.replyText({ messageId: "om_1", text: "hello" });
    await client.sendText({ receiveId: "oc_1", receiveIdType: "chat_id", text: "hi" });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "reply",
      {
        path: { message_id: "om_1" },
        data: { msg_type: "text", content: JSON.stringify({ text: "hello" }) },
      },
    ]);
    expect(calls[1]).toEqual([
      "create",
      {
        params: { receive_id_type: "chat_id" },
        data: { receive_id: "oc_1", msg_type: "text", content: JSON.stringify({ text: "hi" }) },
      },
    ]);
  });
});
