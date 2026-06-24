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

    const sessionDir = join(dir, "group_oc_1");
    expect(existsSync(join(sessionDir, "session.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(sessionDir, "session.json"), "utf-8"))).toMatchObject({
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
});
