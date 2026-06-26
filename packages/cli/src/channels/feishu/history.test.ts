import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuHistoryStore } from "./history.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-feishu-history-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Feishu history store", () => {
  test("creates stable session metadata and appends jsonl messages", () => {
    const store = new FeishuHistoryStore({
      baseDir: dir,
      createSessionId: () => "11111111-1111-4111-8111-111111111111",
    });

    const session = store.getOrCreateSession("group:oc_1", {
      cwd: "/tmp/project",
      model: "cx@gpt-5.5",
    });
    store.appendMessage(session, {
      role: "user",
      text: "[Alice] hello",
      feishuMessageId: "om_1",
    });
    store.appendMessage(session, {
      role: "assistant",
      text: "answer",
    });

    expect(session.archiveId).toBe("session-11111111-1111-4111-8111-111111111111");
    const conversationDir = join(dir, "group_oc_1");
    const sessionDir = join(conversationDir, "session-11111111-1111-4111-8111-111111111111");
    expect(JSON.parse(readFileSync(join(conversationDir, "current.json"), "utf-8"))).toEqual({
      archiveId: "session-11111111-1111-4111-8111-111111111111",
    });
    expect(
      JSON.parse(readFileSync(join(conversationDir, "index.json"), "utf-8")).sessions
    ).toHaveLength(1);
    expect(existsSync(join(sessionDir, "session.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(sessionDir, "session.json"), "utf-8"))).toMatchObject({
      archiveId: "session-11111111-1111-4111-8111-111111111111",
      conversationKey: "group:oc_1",
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/tmp/project",
      model: "cx@gpt-5.5",
      nativeSessionStarted: false,
    });

    const lines = readFileSync(join(sessionDir, "messages.jsonl"), "utf-8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).role)).toEqual(["user", "assistant"]);
  });

  test("loads an existing session and recent messages", () => {
    const store = new FeishuHistoryStore({
      baseDir: dir,
      createSessionId: () => "11111111-1111-4111-8111-111111111111",
    });
    const session = store.getOrCreateSession("dm:ou_1", {
      cwd: "/tmp/project",
      model: "cx@gpt-5.5",
    });
    store.appendMessage(session, { role: "user", text: "one" });
    store.appendMessage(session, { role: "assistant", text: "two" });

    const loaded = store.getOrCreateSession("dm:ou_1", {
      cwd: "/tmp/project",
      model: "cx@gpt-5.5",
    });

    expect(loaded.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(store.readRecentMessages(loaded, 1).map((message) => message.text)).toEqual(["two"]);
  });

  test("archives multiple sessions and switches the current pointer", () => {
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const store = new FeishuHistoryStore({
      baseDir: dir,
      createSessionId: () => ids.shift()!,
    });

    const first = store.getOrCreateSession("dm:ou_1", {
      cwd: "/tmp/project",
      model: "cx@gpt-5.5",
    });
    store.appendMessage(first, { role: "user", text: "first" });
    const second = store.createNewSession("dm:ou_1", {
      cwd: "/tmp/project",
      model: "cx@gpt-5.5",
    });
    store.appendMessage(second, { role: "user", text: "second" });

    const sessions = store.listSessions("dm:ou_1");
    expect(sessions.map((session) => session.archiveId)).toEqual([
      "session-22222222-2222-4222-8222-222222222222",
      "session-11111111-1111-4111-8111-111111111111",
    ]);
    expect(sessions.map((session) => session.current)).toEqual([true, false]);
    expect(sessions.map((session) => session.preview)).toEqual(["second", "first"]);

    expect(store.resumeSession("dm:ou_1", sessions[1].archiveId)?.archiveId).toBe(
      "session-11111111-1111-4111-8111-111111111111"
    );
    expect(
      store.getOrCreateSession("dm:ou_1", { cwd: "/tmp/project", model: "cx@gpt-5.5" }).archiveId
    ).toBe("session-11111111-1111-4111-8111-111111111111");
  });

  test("forks a session by copying its messages into a new archived session", () => {
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const store = new FeishuHistoryStore({
      baseDir: dir,
      createSessionId: () => ids.shift()!,
    });
    const source = store.getOrCreateSession("group:oc_1", {
      cwd: "/tmp/project",
      model: "cx@gpt-5.5",
    });
    store.appendMessage(source, { role: "user", text: "source question" });
    store.appendMessage(source, { role: "assistant", text: "source answer" });

    const fork = store.forkSession("group:oc_1", source.archiveId, {
      cwd: "/tmp/project",
      model: "cx@gpt-5.5",
    });

    expect(fork).toMatchObject({
      archiveId: "session-22222222-2222-4222-8222-222222222222",
      forkedFrom: source.archiveId,
      nativeSessionStarted: false,
    });
    expect(store.readRecentMessages(fork!, 10).map((message) => message.text)).toEqual([
      "source question",
      "source answer",
    ]);
    expect(
      store.getOrCreateSession("group:oc_1", { cwd: "/tmp/project", model: "cx@gpt-5.5" }).archiveId
    ).toBe(fork?.archiveId);
  });

  test("caches session summaries until the message count changes", () => {
    const store = new FeishuHistoryStore({
      baseDir: dir,
      createSessionId: () => "11111111-1111-4111-8111-111111111111",
    });
    const session = store.getOrCreateSession("dm:ou_1", {
      cwd: "/tmp/project",
      model: "cx@gpt-5.5",
    });
    store.appendMessage(session, { role: "user", text: "first" });

    store.writeSessionSummary(session, {
      topic: "主题",
      keyInfo: "关键信息",
      recentAction: "最近动作",
    });

    expect(store.readSessionSummary(session)).toMatchObject({
      topic: "主题",
      keyInfo: "关键信息",
      recentAction: "最近动作",
      messageCount: 1,
    });

    store.appendMessage(session, { role: "assistant", text: "answer" });

    expect(store.readSessionSummary(session)).toBeNull();
  });
});
