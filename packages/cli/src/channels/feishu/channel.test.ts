import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuChannel, type FeishuEventClient } from "./channel.js";
import type { FeishuConfig } from "./config.js";
import type { FeishuHeadlessRunInput } from "./headless-runner.js";

let cwd: string;
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR42mP8z8AABQMBgAUn0nUAAAAASUVORK5CYII=",
  "base64"
);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "claudish-feishu-channel-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function configuredConfig(overrides: Partial<FeishuConfig> = {}): FeishuConfig {
  return {
    enabled: true,
    status: "configured",
    appId: "cli_a",
    appSecret: "secret",
    domain: "feishu",
    model: "cx@gpt-5.5",
    cwd,
    botOpenId: "ou_bot",
    ...overrides,
  } as FeishuConfig;
}

function textPayload(
  text: string,
  mentions = [{ id: { open_id: "ou_bot" }, name: "bot" }],
  messageId = "om_1"
) {
  return {
    event: {
      sender: { sender_id: { open_id: "ou_sender" }, sender_name: "Alice" },
      message: {
        message_id: messageId,
        chat_id: "oc_group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text }),
        mentions,
      },
    },
  };
}

describe("FeishuChannel", () => {
  test("missing config starts as not_configured without throwing", async () => {
    const channel = new FeishuChannel({
      config: configuredConfig({ enabled: false, status: "not_configured" }),
    });

    await channel.start();

    expect(channel.getStatus()).toMatchObject({ id: "feishu", status: "not_configured" });
  });

  test("start creates the configured working directory", async () => {
    const accountCwd = join(cwd, "accounts", "wudonghao");
    const channel = new FeishuChannel({
      config: configuredConfig({ cwd: accountCwd }),
      eventClient: {
        async start() {},
        async stop() {},
      },
    });

    expect(existsSync(accountCwd)).toBe(false);

    await channel.start();

    expect(existsSync(accountCwd)).toBe(true);
  });

  test("text event routes composed text to session router", async () => {
    const routed: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      sessionRouter: {
        async send(_conversationKey, text) {
          routed.push(text);
        },
        listSessions: () => [],
        stopAll() {},
      },
    });

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> hello'));
    await delay(5);

    expect(routed).toEqual(["[Alice] hello\n"]);
  });

  test("message handling returns before the model route finishes", async () => {
    const routed: string[] = [];
    let releaseSend!: () => void;
    const sendFinished = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const channel = new FeishuChannel({
      config: configuredConfig(),
      sessionRouter: {
        async send(_conversationKey, text) {
          routed.push(text);
          await sendFinished;
        },
        listSessions: () => [],
        stopAll() {},
      },
    });

    const result = await Promise.race([
      channel
        .handleEvent(textPayload('<at user_id="ou_bot">bot</at> hello'))
        .then(() => "returned"),
      delay(20).then(() => "blocked"),
    ]);

    expect(result).toBe("returned");
    await delay(5);
    expect(routed).toEqual(["[Alice] hello\n"]);
    releaseSend();
  });

  test("repeated message id is routed only once", async () => {
    const routed: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      sessionRouter: {
        async send(_conversationKey, text) {
          routed.push(text);
        },
        listSessions: () => [],
        stopAll() {},
      },
    });
    const payload = textPayload('<at user_id="ou_bot">bot</at> hello');

    await channel.handleEvent(payload);
    await channel.handleEvent(payload);
    await delay(5);

    expect(routed).toEqual(["[Alice] hello\n"]);
  });

  test("status exposes recent handled message progress", async () => {
    let releaseSend!: () => void;
    const sendFinished = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const channel = new FeishuChannel({
      config: configuredConfig({ id: "donghao" }),
      sessionRouter: {
        async send() {
          await sendFinished;
        },
        listSessions: () => [],
        stopAll() {},
      },
    });

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> hello'));
    await delay(5);

    expect(channel.getStatus().recentMessages).toEqual([
      expect.objectContaining({
        accountId: "donghao",
        messageId: "om_1",
        conversationKey: "group:oc_group",
        chatKind: "group",
        senderName: "Alice",
        preview: "hello",
        imageCount: 0,
        fileCount: 0,
        stage: "model_processing",
      }),
    ]);

    releaseSend();
    await delay(5);
    expect(channel.getStatus().recentMessages?.[0]).toMatchObject({
      messageId: "om_1",
      stage: "completed",
    });
    expect(channel.getStatus().recentSessions?.[0]).toMatchObject({
      accountId: "donghao",
      conversationKey: "group:oc_group",
      messageCount: 1,
      currentMessage: expect.objectContaining({
        messageId: "om_1",
        stage: "completed",
      }),
    });
  });

  test("headless mode replies with non-TUI output by default", async () => {
    const calls: FeishuHeadlessRunInput[] = [];
    const replies: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig({
        sessionMode: "headless",
        history: {
          persist: true,
          maxMessages: 50,
          nativeResume: true,
        },
      }),
      outputQuietMs: 1,
      headlessRunner: async (input) => {
        calls.push(input);
        return { text: "纯文本回答" };
      },
      historyBaseDir: join(cwd, "history"),
      messageClient: {
        async replyText(input) {
          replies.push(`${input.messageId}:${input.text}`);
        },
        async sendText() {},
      },
    });

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> hello'));
    await delay(30);

    expect(calls[0]).toMatchObject({
      model: "cx@gpt-5.5",
      cwd,
      prompt: "[Alice] hello\n",
      resume: false,
      nativeResume: true,
    });
    expect(replies).toEqual(["om_1:纯文本回答"]);
  });

  test("headless progress appears in monitor without being sent as Feishu replies", async () => {
    const replies: string[] = [];
    let finishRun!: () => void;
    const runMayFinish = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const channel = new FeishuChannel({
      config: configuredConfig({
        sessionMode: "headless",
        history: {
          persist: true,
          maxMessages: 50,
          nativeResume: true,
        },
      }),
      outputQuietMs: 1,
      headlessRunner: async (input) => {
        input.onProgress?.({ type: "assistant_text", text: "我先看项目结构。" });
        input.onProgress?.({ type: "tool_start", name: "Read", input: { file_path: "src/a.ts" } });
        await runMayFinish;
        return { text: "最终回答" };
      },
      historyBaseDir: join(cwd, "history"),
      messageClient: {
        async replyText(input) {
          replies.push(`${input.messageId}:${input.text}`);
        },
        async sendText() {},
      },
    });

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> hello'));
    await delay(10);

    expect(replies).toEqual([]);
    expect(channel.getStatus().recentSessions?.[0]).toMatchObject({
      conversationKey: "group:oc_group",
      output: expect.stringContaining("Read"),
    });
    expect(channel.getStatus().recentSessions?.[0].output).toContain("我先看项目结构。");
    expect(channel.getStatus().recentSessions?.[0].output).toContain("src/a.ts");

    finishRun();
    await delay(30);
    expect(replies).toEqual(["om_1:最终回答"]);
  });

  test("adds and removes typing reaction while processing a message", async () => {
    const events: string[] = [];
    let releaseSend!: () => void;
    const sendFinished = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const channel = new FeishuChannel({
      config: configuredConfig(),
      reactionClient: {
        async addTypingReaction(input) {
          events.push(`add:${input.messageId}`);
          return { reactionId: "reaction_1" };
        },
        async removeTypingReaction(input) {
          events.push(`remove:${input.messageId}:${input.reactionId}`);
        },
      },
      sessionRouter: {
        async send() {
          events.push("send");
          await sendFinished;
        },
        listSessions: () => [],
        stopAll() {},
      },
    } as ConstructorParameters<typeof FeishuChannel>[0]);

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> hello'));
    await delay(5);

    expect(events).toEqual(["add:om_1", "send"]);
    releaseSend();
    await delay(5);
    expect(events).toEqual(["add:om_1", "send", "remove:om_1:reaction_1"]);
  });

  test("removes typing reaction when message processing fails", async () => {
    const events: string[] = [];
    const errors: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      logger: {
        log() {},
        warn() {},
        error(input) {
          errors.push(String(input));
        },
      },
      reactionClient: {
        async addTypingReaction(input) {
          events.push(`add:${input.messageId}`);
          return { reactionId: "reaction_1" };
        },
        async removeTypingReaction(input) {
          events.push(`remove:${input.messageId}:${input.reactionId}`);
        },
      },
      sessionRouter: {
        async send() {
          events.push("send");
          throw new Error("route failed");
        },
        listSessions: () => [],
        stopAll() {},
      },
    } as ConstructorParameters<typeof FeishuChannel>[0]);

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> hello'));
    await delay(10);

    expect(events).toEqual(["add:om_1", "send", "remove:om_1:reaction_1"]);
    expect(errors).toEqual(["route failed"]);
  });

  test("slash new and clear reset the current conversation without routing to model", async () => {
    const events: string[] = [];
    const replies: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      messageClient: {
        async replyText(input) {
          replies.push(`${input.messageId}:${input.text}`);
        },
        async sendText() {},
      },
      sessionRouter: {
        async send(_conversationKey, text) {
          events.push(`send:${text}`);
        },
        resetSession(conversationKey) {
          events.push(`reset:${conversationKey}`);
          return true;
        },
        listSessions: () => [],
        stopAll() {},
      },
    });

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> /new'));
    await channel.handleEvent(
      textPayload('<at user_id="ou_bot">bot</at> /clear', undefined, "om_2")
    );
    await delay(5);

    expect(events).toEqual(["reset:group:oc_group", "reset:group:oc_group"]);
    expect(replies).toEqual(["om_1:已开启新会话。", "om_2:已开启新会话。"]);
  });

  test("slash stop stops the current conversation without routing to model", async () => {
    const events: string[] = [];
    const replies: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      messageClient: {
        async replyText(input) {
          replies.push(`${input.messageId}:${input.text}`);
        },
        async sendText() {},
      },
      sessionRouter: {
        async send(_conversationKey, text) {
          events.push(`send:${text}`);
        },
        stopSession(conversationKey) {
          events.push(`stop:${conversationKey}`);
          return true;
        },
        listSessions: () => [],
        stopAll() {},
      },
    });

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> /stop'));
    await delay(5);

    expect(events).toEqual(["stop:group:oc_group"]);
    expect(replies).toEqual(["om_1:已停止当前会话。"]);
  });

  test("group event without mention is ignored", async () => {
    const routed: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      sessionRouter: {
        async send(_conversationKey, text) {
          routed.push(text);
        },
        listSessions: () => [],
        stopAll() {},
      },
    });

    await channel.handleEvent(textPayload("hello", []));

    expect(routed).toEqual([]);
    expect(channel.getStatus().recentMessages).toEqual([]);
  });

  test("image event downloads image, saves it, and routes path input", async () => {
    const routed: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      mediaClient: {
        async downloadImage() {
          return { buffer: TINY_PNG, contentType: "image/png" };
        },
      },
      sessionRouter: {
        async send(_conversationKey, text) {
          routed.push(text);
        },
        listSessions: () => [],
        stopAll() {},
      },
    });

    await channel.handleEvent({
      event: {
        sender: { sender_id: { open_id: "ou_sender" }, sender_name: "Alice" },
        message: {
          message_id: "om_img_default",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "image",
          content: JSON.stringify({ image_key: "img_1" }),
          mentions: [{ id: { open_id: "ou_bot" }, name: "bot" }],
        },
      },
    });
    await delay(50);

    const imagePath = join(
      cwd,
      ".claudish",
      "feishu-images",
      "group_oc_group",
      "om_img_default-img_1.png"
    );
    expect(existsSync(imagePath)).toBe(true);
    expect(routed).toEqual([`[Alice] 请分析这张图片。\n${imagePath}\n`]);
  });

  test("file event downloads file under cwd and routes file-only path input", async () => {
    const routed: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      mediaClient: {
        async downloadImage() {
          throw new Error("should not download image");
        },
        async downloadFile(fileKey, messageId) {
          expect(fileKey).toBe("file_1");
          expect(messageId).toBe("om_file");
          return { buffer: Buffer.from("pdf-data"), contentType: "application/pdf" };
        },
      },
      sessionRouter: {
        async send(_conversationKey, text) {
          routed.push(text);
        },
        listSessions: () => [],
        stopAll() {},
      },
    });

    await channel.handleEvent({
      event: {
        sender: { sender_id: { open_id: "ou_sender" }, sender_name: "Alice" },
        message: {
          message_id: "om_file",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "file",
          content: JSON.stringify({ file_key: "file_1", file_name: "报告.pdf" }),
          mentions: [{ id: { open_id: "ou_bot" }, name: "bot" }],
        },
      },
    });
    await delay(20);

    const filePath = join(cwd, "feishu-files", "om_file-file_1-报告.pdf");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("pdf-data");
    expect(routed).toEqual([`${filePath}\n`]);
    expect(channel.getStatus().recentSessions?.[0]).toMatchObject({
      conversationKey: "group:oc_group",
      fileCount: 1,
      currentMessage: expect.objectContaining({
        preview: "[文件 x1]",
        fileCount: 1,
        stage: "completed",
      }),
    });
  });

  test("session status keeps model output for channel monitor details", async () => {
    let releaseSend!: () => void;
    const sendFinished = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const channel = new FeishuChannel({
      config: configuredConfig({ id: "donghao" }),
      sessionRouter: {
        async send() {
          channel.handleSessionOutput("group:oc_group", "第一段输出");
          await sendFinished;
        },
        listSessions: () => [],
        stopAll() {},
      },
    });

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> hello'));
    await delay(5);

    expect(channel.getStatus().recentSessions?.[0]).toMatchObject({
      accountId: "donghao",
      conversationKey: "group:oc_group",
      stage: "replying",
      output: "第一段输出",
      messages: [
        expect.objectContaining({
          messageId: "om_1",
          output: "第一段输出",
        }),
      ],
    });

    releaseSend();
  });

  test("image event can route an explicitly enhanced image path", async () => {
    const routed: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      mediaClient: {
        async downloadImage() {
          return { buffer: Buffer.from("png-data"), contentType: "image/png" };
        },
      },
      imageVisionEnhancer: async (image) => ({
        path: image.path.replace(/\.png$/, ".vision.png"),
        contentType: "image/png",
      }),
      sessionRouter: {
        async send(_conversationKey, text) {
          routed.push(text);
        },
        listSessions: () => [],
        stopAll() {},
      },
    });

    await channel.handleEvent({
      event: {
        sender: { sender_id: { open_id: "ou_sender" }, sender_name: "Alice" },
        message: {
          message_id: "om_img",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "image",
          content: JSON.stringify({ image_key: "img_1" }),
          mentions: [{ id: { open_id: "ou_bot" }, name: "bot" }],
        },
      },
    });
    await delay(5);

    const imagePath = join(cwd, ".claudish", "feishu-images", "group_oc_group", "om_img-img_1.png");
    expect(existsSync(imagePath)).toBe(true);
    expect(routed).toEqual([
      `[Alice] 请分析这张图片。\n${imagePath.replace(/\.png$/, ".vision.png")}\n`,
    ]);
  });

  test("post image event downloads embedded image and routes text with path", async () => {
    const routed: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      mediaClient: {
        async downloadImage() {
          return { buffer: Buffer.from("png-data"), contentType: "image/png" };
        },
      },
      imageVisionEnhancer: async (image) => image,
      sessionRouter: {
        async send(_conversationKey, text) {
          routed.push(text);
        },
        listSessions: () => [],
        stopAll() {},
      },
    });

    await channel.handleEvent({
      event: {
        sender: { sender_id: { open_id: "ou_sender" }, sender_name: "Alice" },
        message: {
          message_id: "om_post_img",
          chat_id: "oc_dm",
          chat_type: "p2p",
          message_type: "post",
          content: JSON.stringify({
            content: [
              [
                { tag: "img", image_key: "img_post_1" },
                { tag: "text", text: "你看到了什么" },
              ],
            ],
          }),
          mentions: [],
        },
      },
    });
    await delay(5);

    const imagePath = join(
      cwd,
      ".claudish",
      "feishu-images",
      "dm_ou_sender",
      "om_post_img-img_post_1.png"
    );
    expect(existsSync(imagePath)).toBe(true);
    expect(routed).toEqual([`你看到了什么\n${imagePath}\n`]);
  });

  test("stop closes websocket client and sessions", async () => {
    const events: string[] = [];
    const eventClient: FeishuEventClient = {
      async start() {
        events.push("start");
      },
      async stop() {
        events.push("stop");
      },
    };
    const channel = new FeishuChannel({
      config: configuredConfig(),
      eventClient,
      sessionRouter: {
        async send() {},
        listSessions: () => [],
        stopAll() {
          events.push("sessions-stop");
        },
      },
    });

    await channel.start();
    await channel.stop();

    expect(events).toEqual(["start", "stop", "sessions-stop"]);
  });

  test("session output replies to the source message", async () => {
    const replies: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      outputQuietMs: 1,
      messageClient: {
        async replyText(input) {
          replies.push(`${input.messageId}:${input.text}`);
        },
        async sendText() {},
      },
      sessionRouter: {
        async send() {},
        listSessions: () => [],
        stopAll() {},
      },
    });

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> hello'));
    channel.handleSessionOutput("group:oc_group", "\u001b[31mresult\u001b[0m");
    await delay(10);

    expect(replies).toEqual(["om_1:result"]);
  });

  test("session output suppresses echoed prompt and terminal status", async () => {
    const replies: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      outputQuietMs: 1,
      messageClient: {
        async replyText(input) {
          replies.push(`${input.messageId}:${input.text}`);
        },
        async sendText() {},
      },
      sessionRouter: {
        async send() {},
        listSessions: () => [],
        stopAll() {},
      },
    });

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> 你是什么模型'));
    await delay(5);
    channel.handleSessionOutput(
      "group:oc_group",
      [
        "[Alice] 你是什么模型",
        "────────────────────────────────────────",
        "workspace •",
        "cx@gpt-5.5 • $0.000 • N/A",
        "▶▶ bypass permissions on (shift+tab to cycle)",
        "ctrl+g to edit in Vim",
      ].join("\n")
    );
    await delay(10);

    expect(replies).toEqual([]);
  });
});
