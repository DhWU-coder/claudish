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

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

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

    const lines = readFileSync(
      join(dir, "group_oc_1", "session-11111111-1111-4111-8111-111111111111", "messages.jsonl"),
      "utf-8"
    )
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

  test("does not fallback to jsonl history when native resume fails", async () => {
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
      createSessionId: () => "11111111-1111-4111-8111-111111111111",
      runHeadless: async (input) => {
        calls.push(input);
        if (calls.length === 2) {
          throw new Error("resume failed");
        }
        return { text: `answer ${calls.length}` };
      },
    });

    await router.send("dm:ou_1", "first");
    await expect(router.send("dm:ou_1", "second")).rejects.toThrow("resume failed");

    expect(calls.map((call) => ({ sessionId: call.sessionId, resume: call.resume }))).toEqual([
      { sessionId: "11111111-1111-4111-8111-111111111111", resume: false },
      { sessionId: "11111111-1111-4111-8111-111111111111", resume: true },
    ]);
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
    const lines = readFileSync(
      join(dir, "dm_ou_1", "session-11111111-1111-4111-8111-111111111111", "messages.jsonl"),
      "utf-8"
    )
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
    const lines = readFileSync(
      join(dir, "dm_ou_1", "session-11111111-1111-4111-8111-111111111111", "messages.jsonl"),
      "utf-8"
    )
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

  test("resumeArchivedSession switches back to a previous native session", async () => {
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
    router.resetSession("group:oc_1");
    await router.send("group:oc_1", "second");

    expect(router.listArchivedSessions("group:oc_1").map((session) => session.current)).toEqual([
      true,
      false,
    ]);
    expect(router.resumeArchivedSession("group:oc_1", 2)).toMatchObject({
      ok: true,
      archiveId: "session-11111111-1111-4111-8111-111111111111",
    });
    await router.send("group:oc_1", "third");

    expect(calls.map((call) => ({ sessionId: call.sessionId, resume: call.resume }))).toEqual([
      { sessionId: "11111111-1111-4111-8111-111111111111", resume: false },
      { sessionId: "22222222-2222-4222-8222-222222222222", resume: false },
      { sessionId: "11111111-1111-4111-8111-111111111111", resume: true },
    ]);
  });

  test("forkArchivedSession seeds copied history into a new native session once", async () => {
    const calls: FeishuHeadlessRunInput[] = [];
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
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
    router.resetSession("dm:ou_1");
    await router.send("dm:ou_1", "second");

    expect(router.forkArchivedSession("dm:ou_1", 2)).toMatchObject({
      ok: true,
      archiveId: "session-33333333-3333-4333-8333-333333333333",
      forkedFrom: "session-11111111-1111-4111-8111-111111111111",
    });
    await router.send("dm:ou_1", "branch");
    await router.send("dm:ou_1", "continue");

    expect(calls.map((call) => ({ sessionId: call.sessionId, resume: call.resume }))).toEqual([
      { sessionId: "11111111-1111-4111-8111-111111111111", resume: false },
      { sessionId: "22222222-2222-4222-8222-222222222222", resume: false },
      { sessionId: "33333333-3333-4333-8333-333333333333", resume: false },
      { sessionId: "33333333-3333-4333-8333-333333333333", resume: true },
    ]);
    expect(calls[2].prompt).toContain("以下是从已归档会话 fork 出来的上下文");
    expect(calls[2].prompt).toContain("user: first");
    expect(calls[2].prompt).toContain("assistant: answer 1");
    expect(calls[2].prompt).toContain("请回复当前最新用户消息：");
    expect(calls[2].prompt).toContain("branch");
    expect(calls[3].prompt).toBe("continue");
  });

  test("summarizeArchivedSessions runs one summarizer per selected session and uses cache", async () => {
    const calls: FeishuHeadlessRunInput[] = [];
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ];
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
        if (input.prompt.includes("总结以下飞书历史 session")) {
          return {
            text: JSON.stringify({
              topic: `主题 ${calls.length}`,
              keyInfo: "关键信息",
              recentAction: "最近动作",
            }),
          };
        }
        return { text: `answer ${calls.length}` };
      },
    });

    await router.send("dm:ou_1", "first");
    router.resetSession("dm:ou_1");
    await router.send("dm:ou_1", "second");

    const first = await router.summarizeArchivedSessions("dm:ou_1", 2);
    const second = await router.summarizeArchivedSessions("dm:ou_1", 2);

    expect(first.map((session) => session.aiSummary?.topic)).toEqual(["主题 3", "主题 4"]);
    expect(second.map((session) => session.aiSummary?.topic)).toEqual(["主题 3", "主题 4"]);
    expect(calls.filter((call) => call.prompt.includes("总结以下飞书历史 session"))).toHaveLength(
      2
    );
  });

  test("summarizeArchivedSessions runs at most five summarizers concurrently", async () => {
    let running = 0;
    let maxRunning = 0;
    let releaseSummaries!: () => void;
    const summariesMayFinish = new Promise<void>((resolve) => {
      releaseSummaries = resolve;
    });
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888",
      "99999999-9999-4999-8999-999999999999",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ];
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
        if (input.prompt.includes("总结以下飞书历史 session")) {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          await summariesMayFinish;
          running -= 1;
          return {
            text: JSON.stringify({
              topic: "主题",
              keyInfo: "关键信息",
              recentAction: "最近动作",
            }),
          };
        }
        return { text: "answer" };
      },
    });

    for (let index = 0; index < 6; index += 1) {
      if (index > 0) {
        router.resetSession("dm:ou_1");
      }
      await router.send("dm:ou_1", `message ${index}`);
    }

    const summarizing = router.summarizeArchivedSessions("dm:ou_1", 6);
    await waitUntil(() => maxRunning === 5);
    expect(maxRunning).toBe(5);

    releaseSummaries();
    await summarizing;
    expect(maxRunning).toBe(5);
  });

  test("summarizeArchivedSessions skips empty sessions without calling the model", async () => {
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
        return { text: "should not summarize" };
      },
    });

    router.resetSession("dm:ou_1");

    await expect(router.summarizeArchivedSessions("dm:ou_1", 1)).resolves.toEqual([]);
    expect(calls).toEqual([]);
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
