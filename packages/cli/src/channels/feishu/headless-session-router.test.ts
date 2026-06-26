import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeishuHeadlessRunInput } from "./headless-runner.js";
import { FeishuHeadlessSessionRouter } from "./headless-session-router.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-feishu-headless-router-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FeishuHeadlessSessionRouter", () => {
  test("runs each conversation with persistent native session resume", async () => {
    const calls: FeishuHeadlessRunInput[] = [];
    const outputs: string[] = [];
    const router = new FeishuHeadlessSessionRouter({
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
      historyBaseDir: dir,
      history: {
        persist: true,
        maxMessages: 50,
        nativeResume: true,
      },
      createSessionId: () => "11111111-1111-4111-8111-111111111111",
      runHeadless: async (input) => {
        calls.push(input);
        return { text: `answer ${calls.length}` };
      },
      onOutput: (_conversationKey, data) => {
        outputs.push(typeof data === "string" ? data : Buffer.from(data).toString("utf-8"));
      },
    });

    await router.send("group:oc_1", "[Alice] hello");
    await router.send("group:oc_1", "[Alice] continue");

    expect(calls.map((call) => ({ sessionId: call.sessionId, resume: call.resume }))).toEqual([
      { sessionId: "11111111-1111-4111-8111-111111111111", resume: false },
      { sessionId: "11111111-1111-4111-8111-111111111111", resume: true },
    ]);
    expect(outputs).toEqual(["answer 1", "answer 2"]);

    const lines = readFileSync(join(dir, "group_oc_1", "messages.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("injects return-file instructions only on the first native prompt of a session", async () => {
    const calls: FeishuHeadlessRunInput[] = [];
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const router = new FeishuHeadlessSessionRouter({
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
      historyBaseDir: dir,
      history: {
        persist: true,
        maxMessages: 50,
        nativeResume: true,
      },
      createSessionId: () => ids.shift()!,
      runHeadless: async (input) => {
        calls.push(input);
        return { text: `answer ${calls.length}` };
      },
    });

    await router.send("dm:ou_1", "first");
    await router.send("dm:ou_1", "second");
    router.resetSession("dm:ou_1");
    await router.send("dm:ou_1", "third");

    expect(calls[0].prompt).toContain("[[claudish:file:");
    expect(calls[0].prompt).toContain("first");
    expect(calls[1].prompt).toBe("second");
    expect(calls[2].prompt).toContain("[[claudish:file:");
    expect(calls[2].prompt).toContain("third");
  });

  test("forwards progress events separately from final replies", async () => {
    const outputs: string[] = [];
    const progress: string[] = [];
    const router = new FeishuHeadlessSessionRouter({
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
      historyBaseDir: dir,
      history: {
        persist: true,
        maxMessages: 50,
        nativeResume: true,
      },
      createSessionId: () => "11111111-1111-4111-8111-111111111111",
      runHeadless: async (input) => {
        input.onProgress?.({ type: "tool_start", name: "Read", input: { file_path: "src/a.ts" } });
        return { text: "最终回复" };
      },
      onProgress: (_conversationKey, event) => {
        progress.push(`${event.type}:${"name" in event ? event.name : ""}`);
      },
      onOutput: (_conversationKey, data) => {
        outputs.push(typeof data === "string" ? data : Buffer.from(data).toString("utf-8"));
      },
    });

    await router.send("group:oc_1", "[Alice] hello");

    expect(progress).toEqual(["tool_start:Read"]);
    expect(outputs).toEqual(["最终回复"]);
  });

  test("forwards send context to progress events and final replies", async () => {
    const events: string[] = [];
    const router = new FeishuHeadlessSessionRouter({
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
      historyBaseDir: dir,
      history: {
        persist: true,
        maxMessages: 50,
        nativeResume: true,
      },
      createSessionId: () => "11111111-1111-4111-8111-111111111111",
      runHeadless: async (input) => {
        input.onProgress?.({ type: "assistant_text", text: "处理中" });
        return { text: "最终回复" };
      },
      onProgress: (_conversationKey, _event, context) => {
        events.push(`progress:${context?.replyToMessageId}`);
      },
      onOutput: (_conversationKey, _data, context) => {
        events.push(`output:${context?.replyToMessageId}`);
      },
    });

    await router.send("group:oc_1", "[Alice] hello", { replyToMessageId: "om_1" });

    expect(events).toEqual(["progress:om_1", "output:om_1"]);
  });

  test("falls back to jsonl history when native resume fails", async () => {
    const calls: FeishuHeadlessRunInput[] = [];
    const router = new FeishuHeadlessSessionRouter({
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
      historyBaseDir: dir,
      history: {
        persist: true,
        maxMessages: 2,
        nativeResume: true,
      },
      createSessionId: (() => {
        const ids = [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ];
        return () => ids.shift()!;
      })(),
      runHeadless: async (input) => {
        calls.push(input);
        if (calls.length === 2) {
          throw new Error("resume failed");
        }
        return { text: `answer ${calls.length}` };
      },
    });

    await router.send("dm:ou_1", "first");
    await router.send("dm:ou_1", "second");

    expect(calls.map((call) => ({ sessionId: call.sessionId, resume: call.resume }))).toEqual([
      { sessionId: "11111111-1111-4111-8111-111111111111", resume: false },
      { sessionId: "11111111-1111-4111-8111-111111111111", resume: true },
      { sessionId: "22222222-2222-4222-8222-222222222222", resume: false },
    ]);
    expect(calls[2].prompt).toContain("以下是这个飞书会话最近的历史");
    expect(calls[2].prompt).toContain("assistant: answer 1");
    expect(calls[2].prompt).toContain("user: second");
  });

  test("removes leaked analysis draft before saving and replying", async () => {
    const outputs: string[] = [];
    const router = new FeishuHeadlessSessionRouter({
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
      historyBaseDir: dir,
      history: {
        persist: true,
        maxMessages: 50,
        nativeResume: true,
      },
      createSessionId: () => "11111111-1111-4111-8111-111111111111",
      runHeadless: async () => ({
        text:
          "**Evaluating image corruption**\n\n" +
          "I need to figure out if the image is corrupted. I suspect this is the same issue. " +
          "I should find a concise way to describe the situation.这张图是一张飞书聊天截图。\n\n" +
          "主要能看到测试对话和工作目录回复。",
      }),
      onOutput: (_conversationKey, data) => {
        outputs.push(typeof data === "string" ? data : Buffer.from(data).toString("utf-8"));
      },
    });

    await router.send("dm:ou_1", "这个图里有什么");

    expect(outputs).toEqual(["这张图是一张飞书聊天截图。\n\n主要能看到测试对话和工作目录回复。"]);
    const lines = readFileSync(join(dir, "dm_ou_1", "messages.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.at(-1).text).toBe(
      "这张图是一张飞书聊天截图。\n\n主要能看到测试对话和工作目录回复。"
    );
  });

  test("removes leaked greeting draft before saving and replying", async () => {
    const outputs: string[] = [];
    const router = new FeishuHeadlessSessionRouter({
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
      historyBaseDir: dir,
      history: {
        persist: true,
        maxMessages: 50,
        nativeResume: true,
      },
      createSessionId: () => "11111111-1111-4111-8111-111111111111",
      runHeadless: async () => ({
        text:
          "**Greeting in Chinese**\n\n" +
          "I'm thinking it's time for a friendly greeting in Chinese! " +
          "I could say 你好 which means hello. I wonder if the user wants more. " +
          "I'm excited to share!你好！我在这儿。需要我帮你写代码、看项目、排查问题，还是处理文件？",
      }),
      onOutput: (_conversationKey, data) => {
        outputs.push(typeof data === "string" ? data : Buffer.from(data).toString("utf-8"));
      },
    });

    await router.send("dm:ou_1", "你好");

    expect(outputs).toEqual(["你好！我在这儿。需要我帮你写代码、看项目、排查问题，还是处理文件？"]);
    const lines = readFileSync(join(dir, "dm_ou_1", "messages.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.at(-1).text).toBe(
      "你好！我在这儿。需要我帮你写代码、看项目、排查问题，还是处理文件？"
    );
  });

  test("resetSession starts the conversation with a new native session", async () => {
    const calls: FeishuHeadlessRunInput[] = [];
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const router = new FeishuHeadlessSessionRouter({
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
      historyBaseDir: dir,
      history: {
        persist: true,
        maxMessages: 50,
        nativeResume: true,
      },
      createSessionId: () => ids.shift()!,
      runHeadless: async (input) => {
        calls.push(input);
        return { text: `answer ${calls.length}` };
      },
    });

    await router.send("group:oc_1", "first");
    expect(router.resetSession("group:oc_1")).toBe(true);
    await router.send("group:oc_1", "second");

    expect(calls.map((call) => ({ sessionId: call.sessionId, resume: call.resume }))).toEqual([
      { sessionId: "11111111-1111-4111-8111-111111111111", resume: false },
      { sessionId: "22222222-2222-4222-8222-222222222222", resume: false },
    ]);
  });

  test("stopSession clears the active headless session", async () => {
    const calls: FeishuHeadlessRunInput[] = [];
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const router = new FeishuHeadlessSessionRouter({
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
      historyBaseDir: dir,
      history: {
        persist: false,
        maxMessages: 50,
        nativeResume: true,
      },
      createSessionId: () => ids.shift()!,
      runHeadless: async (input) => {
        calls.push(input);
        return { text: `answer ${calls.length}` };
      },
    });

    await router.send("dm:ou_1", "first");
    expect(router.stopSession("dm:ou_1")).toBe(true);
    await router.send("dm:ou_1", "second");

    expect(calls.map((call) => call.sessionId)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });
});
