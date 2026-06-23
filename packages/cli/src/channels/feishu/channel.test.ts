import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuChannel, type FeishuEventClient } from "./channel.js";
import type { FeishuConfig } from "./config.js";

let cwd: string;

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

function textPayload(text: string, mentions = [{ id: { open_id: "ou_bot" }, name: "bot" }]) {
  return {
    event: {
      sender: { sender_id: { open_id: "ou_sender" }, sender_name: "Alice" },
      message: {
        message_id: "om_1",
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

    expect(routed).toEqual(["[Alice] hello\n"]);
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
  });

  test("image event downloads image, saves it, and routes path input", async () => {
    const routed: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      mediaClient: {
        async downloadImage() {
          return { buffer: Buffer.from("png-data"), contentType: "image/png" };
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
          message_id: "om_img",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "image",
          content: JSON.stringify({ image_key: "img_1" }),
          mentions: [{ id: { open_id: "ou_bot" }, name: "bot" }],
        },
      },
    });

    const imagePath = join(cwd, ".claudish", "feishu-images", "group_oc_group", "om_img-img_1.png");
    expect(existsSync(imagePath)).toBe(true);
    expect(routed).toEqual([`[Alice] 请分析这张图片。\n${imagePath}\n`]);
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
});
