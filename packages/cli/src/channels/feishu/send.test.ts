import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FeishuMessageClient,
  sendFeishuFile,
  sendFeishuText,
  splitFeishuText,
} from "./send.js";
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

  test("sendFeishuFile replies with a local file when message id is available", async () => {
    const calls: string[] = [];
    const client: FeishuMessageClient = {
      async replyText() {},
      async sendText() {},
      async replyFile(input) {
        calls.push(`reply-file:${input.messageId}:${input.filePath}`);
      },
      async sendFile(input) {
        calls.push(`send-file:${input.receiveId}:${input.filePath}`);
      },
    };

    await sendFeishuFile(client, { replyToMessageId: "om_1", filePath: "/tmp/report.pdf" });

    expect(calls).toEqual(["reply-file:om_1:/tmp/report.pdf"]);
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

  test("createSdkFeishuMessageClient uploads and replies with Feishu file messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-feishu-send-"));
    const filePath = join(dir, "report.pdf");
    writeFileSync(filePath, "pdf-data");
    const calls: unknown[] = [];
    const client = createSdkFeishuMessageClient({
      im: {
        v1: {
          file: {
            async create(payload: unknown) {
              calls.push(["file.create", payload]);
              return { file_key: "file_uploaded" };
            },
          },
          message: {
            async reply(payload: unknown) {
              calls.push(["message.reply", payload]);
            },
            async create(payload: unknown) {
              calls.push(["message.create", payload]);
            },
          },
        },
      },
    });

    await client.replyFile({ messageId: "om_1", filePath });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject([
      "file.create",
      {
        data: {
          file_type: "pdf",
          file_name: "report.pdf",
        },
      },
    ]);
    expect(calls[1]).toEqual([
      "message.reply",
      {
        path: { message_id: "om_1" },
        data: { msg_type: "file", content: JSON.stringify({ file_key: "file_uploaded" }) },
      },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
});
