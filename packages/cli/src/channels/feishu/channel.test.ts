import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function waitForExpectation(assertion: () => void, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(5);
    }
  }
  throw lastError;
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
      resume: false,
      nativeResume: true,
    });
    expect(calls[0].prompt).toContain("[[claudish:file:");
    expect(calls[0].prompt).toContain("[Alice] hello\n");
    await waitForExpectation(() => {
      expect(replies).toEqual(["om_1:纯文本回答"]);
    });
  });

  test("headless queued replies stay bound to the source message", async () => {
    const replies: string[] = [];
    let finishFirstRun!: () => void;
    let markFirstRunStarted!: () => void;
    const firstRunStarted = new Promise<void>((resolve) => {
      markFirstRunStarted = resolve;
    });
    const firstRunMayFinish = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });
    let runCount = 0;
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
      headlessRunner: async () => {
        runCount += 1;
        if (runCount === 1) {
          markFirstRunStarted();
          await firstRunMayFinish;
          return { text: "第一条回复" };
        }
        return { text: "第二条回复" };
      },
      historyBaseDir: join(cwd, "history"),
      messageClient: {
        async replyText(input) {
          replies.push(`${input.messageId}:${input.text}`);
        },
        async sendText() {},
      },
    });

    await channel.handleEvent(
      textPayload('<at user_id="ou_bot">bot</at> 第一条', undefined, "om_1")
    );
    await firstRunStarted;
    await channel.handleEvent(
      textPayload('<at user_id="ou_bot">bot</at> 第二条', undefined, "om_2")
    );
    await delay(10);
    finishFirstRun();
    await delay(80);

    expect(replies).toEqual(["om_1:第一条回复", "om_2:第二条回复"]);
  });

  test("headless output sends return-file directives as Feishu files without showing the directive", async () => {
    const replies: string[] = [];
    const sentFiles: string[] = [];
    const reportPath = join(cwd, "report.pdf");
    writeFileSync(reportPath, "pdf-data", { flag: "w" });
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
      headlessRunner: async () => ({
        text: "报告已经生成。\n\n[[claudish:file:report.pdf]]",
      }),
      historyBaseDir: join(cwd, "history"),
      messageClient: {
        async replyText(input) {
          replies.push(input.text);
        },
        async sendText() {},
        async replyFile(input) {
          sentFiles.push(`${input.messageId}:${input.filePath}`);
        },
        async sendFile() {},
      },
    });

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> 生成报告'));
    await delay(30);

    expect(replies).toEqual(["报告已经生成。"]);
    expect(sentFiles).toEqual([`om_1:${reportPath}`]);
    expect(channel.getStatus().recentSessions?.[0].output).not.toContain("[[claudish:file:");
  });

  test("headless output sends cwd-local file paths as Feishu files", async () => {
    const replies: string[] = [];
    const sentFiles: string[] = [];
    const reportPath = join(cwd, "2026年金价整理.xlsx");
    writeFileSync(reportPath, "xlsx-data", { flag: "w" });
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
      headlessRunner: async () => ({
        text: [
          "已整理好 Excel 文件：",
          "```text",
          reportPath,
          "```",
          "内容包括：",
          "- 月度汇总",
        ].join("\n"),
      }),
      historyBaseDir: join(cwd, "history"),
      messageClient: {
        async replyText(input) {
          replies.push(input.text);
        },
        async sendText() {},
        async replyFile(input) {
          sentFiles.push(`${input.messageId}:${input.filePath}`);
        },
        async sendFile() {},
      },
    });

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> 整理文件'));
    await delay(30);

    expect(replies).toEqual(["已整理好 Excel 文件：\n内容包括：\n- 月度汇总"]);
    expect(sentFiles).toEqual([`om_1:${reportPath}`]);
  });

  test("headless queued return files stay bound to the source message", async () => {
    const sentFiles: string[] = [];
    const firstFile = join(cwd, "first.txt");
    const secondFile = join(cwd, "second.txt");
    writeFileSync(firstFile, "first");
    writeFileSync(secondFile, "second");
    let finishFirstRun!: () => void;
    let markFirstRunStarted!: () => void;
    const firstRunStarted = new Promise<void>((resolve) => {
      markFirstRunStarted = resolve;
    });
    const firstRunMayFinish = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });
    let runCount = 0;
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
      headlessRunner: async () => {
        runCount += 1;
        if (runCount === 1) {
          markFirstRunStarted();
          await firstRunMayFinish;
          return { text: "第一条文件\n[[claudish:file:first.txt]]" };
        }
        return { text: "第二条文件\n[[claudish:file:second.txt]]" };
      },
      historyBaseDir: join(cwd, "history"),
      messageClient: {
        async replyText() {},
        async sendText() {},
        async replyFile(input) {
          sentFiles.push(`${input.messageId}:${input.filePath}`);
        },
        async sendFile() {},
      },
    });

    await channel.handleEvent(
      textPayload('<at user_id="ou_bot">bot</at> 第一条', undefined, "om_1")
    );
    await firstRunStarted;
    await channel.handleEvent(
      textPayload('<at user_id="ou_bot">bot</at> 第二条', undefined, "om_2")
    );
    await delay(10);
    finishFirstRun();
    await delay(80);

    expect(sentFiles).toEqual([`om_1:${firstFile}`, `om_2:${secondFile}`]);
  });

  test("headless assistant progress stays in monitor by default", async () => {
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
    await delay(30);

    expect(replies).toEqual([]);
    expect(channel.getStatus().recentSessions?.[0].output).toContain("我先看项目结构。");
    expect(channel.getStatus().recentSessions?.[0].output).toContain("src/a.ts");

    finishRun();
    await waitForExpectation(() => {
      expect(replies).toEqual(["om_1:最终回答"]);
    });
  });

  test("headless assistant progress is sent as Feishu replies when enabled", async () => {
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
        sendProgressReplies: true,
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

    await waitForExpectation(() => {
      expect(replies).toEqual(["om_1:我先看项目结构。"]);
    });
    expect(channel.getStatus().recentSessions?.[0]).toMatchObject({
      conversationKey: "group:oc_group",
      output: expect.stringContaining("Read"),
    });
    expect(channel.getStatus().recentSessions?.[0].output).toContain("我先看项目结构。");
    expect(channel.getStatus().recentSessions?.[0].output).toContain("src/a.ts");

    finishRun();
    await waitForExpectation(() => {
      expect(replies).toEqual(["om_1:我先看项目结构。", "om_1:最终回答"]);
    });
  });

  test("headless progress replies strip leaked English draft text", async () => {
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
        sendProgressReplies: true,
      }),
      outputQuietMs: 1,
      headlessRunner: async (input) => {
        input.onProgress?.({
          type: "assistant_text",
          text:
            "**Creating XLSX file**\n\n" +
            "I need to create an XLSX file, but I do not have openpyxl installed. " +
            "Maybe I should write a script.数据源可以正常读取。我现在生成 Excel 文件。",
        });
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

    await waitForExpectation(() => {
      expect(replies).toEqual(["om_1:数据源可以正常读取。我现在生成 Excel 文件。"]);
    });

    finishRun();
    await waitForExpectation(() => {
      expect(replies).toEqual([
        "om_1:数据源可以正常读取。我现在生成 Excel 文件。",
        "om_1:最终回答",
      ]);
    });
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

  test("slash file sends a cwd-local file without routing to the model", async () => {
    const filePath = join(cwd, "result.txt");
    writeFileSync(filePath, "result");
    const routed: string[] = [];
    const sentFiles: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      messageClient: {
        async replyText() {},
        async sendText() {},
        async replyFile(input) {
          sentFiles.push(`${input.messageId}:${input.filePath}`);
        },
        async sendFile() {},
      },
      sessionRouter: {
        async send(_conversationKey, text) {
          routed.push(text);
        },
        listSessions: () => [],
        stopAll() {},
      },
    });

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> /file result.txt'));
    await delay(20);

    expect(routed).toEqual([]);
    expect(sentFiles).toEqual([`om_1:${filePath}`]);
    expect(channel.getStatus().recentMessages?.[0]).toMatchObject({
      stage: "completed",
    });
  });

  test("slash file rejects paths outside the channel cwd", async () => {
    const outsidePath = join(cwd, "..", "outside.txt");
    writeFileSync(outsidePath, "secret");
    const sentFiles: string[] = [];
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
      messageClient: {
        async replyText() {},
        async sendText() {},
        async replyFile(input) {
          sentFiles.push(input.filePath);
        },
        async sendFile() {},
      },
      sessionRouter: {
        async send() {},
        listSessions: () => [],
        stopAll() {},
      },
    });

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> /file ../outside.txt'));
    await delay(20);

    expect(sentFiles).toEqual([]);
    expect(errors[0]).toContain("只能回传当前工作目录内的文件");
    expect(channel.getStatus().recentMessages?.[0]).toMatchObject({
      stage: "failed",
    });
    rmSync(outsidePath, { force: true });
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

  test("slash status replies with current conversation status without routing to model", async () => {
    const routed: string[] = [];
    const replies: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig({ id: "donghao" }),
      messageClient: {
        async replyText(input) {
          replies.push(input.text);
        },
        async sendText() {},
      },
      sessionRouter: {
        async send(_conversationKey, text) {
          routed.push(text);
        },
        listSessions: () => [
          {
            conversationKey: "group:oc_group",
            pid: 123,
            status: "running",
          },
        ],
        stopAll() {},
      },
    });

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> /status'));
    await delay(5);

    expect(routed).toEqual([]);
    expect(replies[0]).toContain("状态：");
    expect(replies[0]).toContain("账号：donghao");
    expect(replies[0]).toContain("会话：group:oc_group");
    expect(replies[0]).toContain("模型：cx@gpt-5.5");
    expect(replies[0]).toContain(`工作目录：${cwd}`);
    expect(replies[0]).toContain("运行中");
  });

  test("slash sessions lists archived sessions without routing to the model", async () => {
    const routed: string[] = [];
    const replies: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      messageClient: {
        async replyText(input) {
          replies.push(input.text);
        },
        async sendText() {},
      },
      sessionRouter: {
        async send(_conversationKey, text) {
          routed.push(text);
        },
        listSessions: () => [],
        listArchivedSessions: () => [
          {
            archiveId: "session-22222222-2222-4222-8222-222222222222",
            conversationKey: "group:oc_group",
            sessionId: "22222222-2222-4222-8222-222222222222",
            cwd,
            model: "cx@gpt-5.5",
            nativeSessionStarted: true,
            createdAt: "2026-06-24T12:00:00.000Z",
            lastActiveAt: "2026-06-24T12:03:00.000Z",
            current: true,
            messageCount: 4,
            preview: "第二个问题",
          },
          {
            archiveId: "session-11111111-1111-4111-8111-111111111111",
            conversationKey: "group:oc_group",
            sessionId: "11111111-1111-4111-8111-111111111111",
            cwd,
            model: "cx@gpt-5.5",
            nativeSessionStarted: true,
            createdAt: "2026-06-24T11:00:00.000Z",
            lastActiveAt: "2026-06-24T11:03:00.000Z",
            current: false,
            messageCount: 2,
            preview: "第一个问题",
          },
        ],
        stopAll() {},
      },
    } as ConstructorParameters<typeof FeishuChannel>[0]);

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> /sessions'));
    await delay(5);

    expect(routed).toEqual([]);
    expect(replies[0]).toContain("历史 session");
    expect(replies[0]).toContain("1. 当前");
    expect(replies[0]).toContain("第二个问题");
    expect(replies[0]).toContain("2.");
    expect(replies[0]).toContain("第一个问题");
  });

  test("slash sessions summary uses independent list and summary counts", async () => {
    const replies: string[] = [];
    const events: string[] = [];
    const archivedSessions = [1, 2, 3].map((index) => ({
      archiveId: `session-${index}`,
      conversationKey: "group:oc_group",
      sessionId: `native-${index}`,
      cwd,
      model: "cx@gpt-5.5",
      nativeSessionStarted: true,
      createdAt: `2026-06-24T12:0${index}:00.000Z`,
      lastActiveAt: `2026-06-24T12:0${index}:00.000Z`,
      current: index === 1,
      messageCount: index,
      preview: `问题 ${index}`,
    }));
    const channel = new FeishuChannel({
      config: configuredConfig(),
      messageClient: {
        async replyText(input) {
          replies.push(input.text);
        },
        async sendText() {},
      },
      sessionRouter: {
        async send() {},
        listSessions: () => [],
        listArchivedSessions: () => archivedSessions,
        async summarizeArchivedSessions(_conversationKey, count) {
          events.push(`summary:${count}`);
          return archivedSessions.slice(0, Number(count)).map((session) => ({
            ...session,
            aiSummary: {
              topic: `主题 ${session.archiveId}`,
              keyInfo: "关键信息",
              recentAction: "最近动作",
              messageCount: session.messageCount,
              updatedAt: "2026-06-24T12:10:00.000Z",
            },
          }));
        },
        stopAll() {},
      },
    } as ConstructorParameters<typeof FeishuChannel>[0]);

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> /sessions 1 --summary 2'));
    await delay(5);

    expect(events).toEqual(["summary:2"]);
    expect(replies[0]).toContain("1. 当前");
    expect(replies[0]).toContain("主题：主题 session-1");
    expect(replies[0]).not.toContain("状态：");
    expect(replies[0]).toContain("2. 历史");
    expect(replies[0]).toContain("主题：主题 session-2");
    expect(replies[0]).not.toContain("问题 3");
  });

  test("slash sessions summary treats empty sessions as empty without status", async () => {
    const replies: string[] = [];
    const events: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      messageClient: {
        async replyText(input) {
          replies.push(input.text);
        },
        async sendText() {},
      },
      sessionRouter: {
        async send() {},
        listSessions: () => [],
        listArchivedSessions: () => [
          {
            archiveId: "session-empty",
            conversationKey: "group:oc_group",
            sessionId: "native-empty",
            cwd,
            model: "cx@gpt-5.5",
            nativeSessionStarted: false,
            createdAt: "2026-06-24T12:01:00.000Z",
            lastActiveAt: "2026-06-24T12:01:00.000Z",
            current: true,
            messageCount: 0,
            preview: "",
          },
        ],
        async summarizeArchivedSessions(_conversationKey, count) {
          events.push(`summary:${count}`);
          return [];
        },
        stopAll() {},
      },
    } as ConstructorParameters<typeof FeishuChannel>[0]);

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> /sessions --summary'));
    await delay(5);

    expect(events).toEqual(["summary:10"]);
    expect(replies[0]).toContain("0 条消息 · 空会话");
    expect(replies[0]).not.toContain("状态：");
    expect(replies[0]).not.toContain("不可直接 resume");
  });

  test("slash sessions all summary lists all while summarizing selected sessions", async () => {
    const replies: string[] = [];
    const events: string[] = [];
    const archivedSessions = [1, 2, 3].map((index) => ({
      archiveId: `session-${index}`,
      conversationKey: "group:oc_group",
      sessionId: `native-${index}`,
      cwd,
      model: "cx@gpt-5.5",
      nativeSessionStarted: true,
      createdAt: `2026-06-24T12:0${index}:00.000Z`,
      lastActiveAt: `2026-06-24T12:0${index}:00.000Z`,
      current: index === 1,
      messageCount: index,
      preview: `问题 ${index}`,
    }));
    const channel = new FeishuChannel({
      config: configuredConfig(),
      messageClient: {
        async replyText(input) {
          replies.push(input.text);
        },
        async sendText() {},
      },
      sessionRouter: {
        async send() {},
        listSessions: () => [],
        listArchivedSessions: () => archivedSessions,
        async summarizeArchivedSessions(_conversationKey, count) {
          events.push(`summary:${count}`);
          return [
            {
              ...archivedSessions[0],
              aiSummary: {
                topic: "最近主题",
                keyInfo: "关键信息",
                recentAction: "最近动作",
                messageCount: 1,
                updatedAt: "2026-06-24T12:10:00.000Z",
              },
            },
          ];
        },
        stopAll() {},
      },
    } as ConstructorParameters<typeof FeishuChannel>[0]);

    await channel.handleEvent(
      textPayload('<at user_id="ou_bot">bot</at> /sessions all --summary 1')
    );
    await delay(5);

    expect(events).toEqual(["summary:1"]);
    expect(replies[0]).toContain("主题：最近主题");
    expect(replies[0]).toContain("问题 2");
    expect(replies[0]).toContain("问题 3");
  });

  test("slash session replies with the current archived session", async () => {
    const replies: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      messageClient: {
        async replyText(input) {
          replies.push(input.text);
        },
        async sendText() {},
      },
      sessionRouter: {
        async send() {},
        listSessions: () => [],
        getCurrentArchivedSession: () => ({
          archiveId: "session-11111111-1111-4111-8111-111111111111",
          conversationKey: "group:oc_group",
          sessionId: "11111111-1111-4111-8111-111111111111",
          cwd,
          model: "cx@gpt-5.5",
          nativeSessionStarted: true,
          createdAt: "2026-06-24T11:00:00.000Z",
          lastActiveAt: "2026-06-24T11:03:00.000Z",
          current: true,
          messageCount: 2,
          preview: "当前问题",
        }),
        stopAll() {},
      },
    } as ConstructorParameters<typeof FeishuChannel>[0]);

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> /session'));
    await delay(5);

    expect(replies[0]).toContain("当前 session");
    expect(replies[0]).toContain("session-11111111-1111-4111-8111-111111111111");
    expect(replies[0]).toContain("当前问题");
  });

  test("slash session number replies with archived session history", async () => {
    const replies: string[] = [];
    const channel = new FeishuChannel({
      config: configuredConfig(),
      messageClient: {
        async replyText(input) {
          replies.push(input.text);
        },
        async sendText() {},
      },
      sessionRouter: {
        async send() {},
        listSessions: () => [],
        getArchivedSessionDetail: (_conversationKey, selection) => ({
          session: {
            archiveId: "session-22222222-2222-4222-8222-222222222222",
            conversationKey: "group:oc_group",
            sessionId: "22222222-2222-4222-8222-222222222222",
            cwd,
            model: "cx@gpt-5.5",
            nativeSessionStarted: true,
            createdAt: "2026-06-24T12:00:00.000Z",
            lastActiveAt: "2026-06-24T12:03:00.000Z",
            current: false,
            messageCount: 2,
            preview: "历史问题",
          },
          messages: [
            { role: "user", text: "这个文件是什么" },
            { role: "assistant", text: "这是一个 Dockerfile。" },
          ],
          selection,
        }),
        stopAll() {},
      },
    } as ConstructorParameters<typeof FeishuChannel>[0]);

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> /session 2'));
    await delay(5);

    expect(replies[0]).toContain("Session 2");
    expect(replies[0]).toContain("用户：\n这个文件是什么");
    expect(replies[0]).toContain("模型：\n这是一个 Dockerfile。");
  });

  test("slash resume and fork switch archived sessions without routing to the model", async () => {
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
        listSessions: () => [],
        resumeArchivedSession(conversationKey, selection) {
          events.push(`resume:${conversationKey}:${selection}`);
          return {
            ok: true,
            message: "已恢复历史 session。",
            archiveId: "session-11111111-1111-4111-8111-111111111111",
            sessionId: "11111111-1111-4111-8111-111111111111",
          };
        },
        forkArchivedSession(conversationKey, selection) {
          events.push(`fork:${conversationKey}:${selection}`);
          return {
            ok: true,
            message: "已 fork 历史 session。",
            archiveId: "session-22222222-2222-4222-8222-222222222222",
            sessionId: "22222222-2222-4222-8222-222222222222",
            forkedFrom: "session-11111111-1111-4111-8111-111111111111",
          };
        },
        stopAll() {},
      },
    } as ConstructorParameters<typeof FeishuChannel>[0]);

    await channel.handleEvent(textPayload('<at user_id="ou_bot">bot</at> /resume 2'));
    await channel.handleEvent(
      textPayload('<at user_id="ou_bot">bot</at> /fork 1', undefined, "om_2")
    );
    await delay(5);

    expect(events).toEqual(["resume:group:oc_group:2", "fork:group:oc_group:1"]);
    expect(replies[0]).toContain("om_1:已恢复历史 session。");
    expect(replies[0]).toContain("session-11111111-1111-4111-8111-111111111111");
    expect(replies[1]).toContain("om_2:已 fork 历史 session。");
    expect(replies[1]).toContain("fork 自");
  });

  test("testConnection delegates to message client and reports disabled accounts", async () => {
    const channel = new FeishuChannel({
      config: configuredConfig({ id: "donghao" }),
      messageClient: {
        async replyText() {},
        async sendText() {},
        async testConnection(input) {
          return {
            ok: true,
            latencyMs: 12,
            checks: [
              {
                name: "tenant_access_token",
                ok: true,
                message: input.expectedBotOpenId,
              },
            ],
          };
        },
      },
    });
    const disabled = new FeishuChannel({
      config: configuredConfig({ enabled: false }),
    });

    await expect(channel.testConnection()).resolves.toEqual({
      ok: true,
      latencyMs: 12,
      checks: [{ name: "tenant_access_token", ok: true, message: "ou_bot" }],
    });
    await expect(disabled.testConnection()).resolves.toMatchObject({
      ok: false,
      error: "Feishu account is disabled.",
    });
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
      fileAttachments: [
        {
          name: "om_file-file_1-报告.pdf",
          path: filePath,
        },
      ],
      currentMessage: expect.objectContaining({
        preview: "[文件 x1]",
        fileCount: 1,
        fileAttachments: [
          {
            name: "om_file-file_1-报告.pdf",
            path: filePath,
          },
        ],
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
      ].join("\n"),
      { replyToMessageId: "om_1" }
    );
    await delay(10);

    expect(replies).toEqual([]);
  });
});
